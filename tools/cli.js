#!/usr/bin/env node
/**
 * The command line, because the credential must not go through a chat log.
 *
 * `export` prints the transfer token on **stdout and nothing else**, so
 * `workbuddy-android export | pbcopy` or `> token.txt` behaves like any other
 * unix tool. Everything the human needs to read goes to stderr. `--json` is the
 * exception: it prints one JSON object on stdout for scripts.
 *
 * Exit codes are stable so the README can promise them:
 *   0 ok
 *   1 the operation failed (credential, network, file)
 *   2 bad usage
 */

import { readFile } from 'node:fs/promises';
import { inspectCredential, formatStatus } from '../lib/status.js';
import { describeCredential } from '../lib/credential.js';
import { exportCredential, importCredential } from '../lib/transfer.js';
import { forgetCredential } from '../lib/tools.js';
import { listModels, probeChat, refreshCredential } from '../lib/api.js';
import { resolveAuthPath, writeAuthFile } from '../lib/store.js';

const PROG = 'workbuddy-android';

const HELP = `${PROG} — 把 WorkBuddy 登录态从电脑搬到手机

用法：
  ${PROG} export [--out <文件>] [--file <桌面凭据>] [--electron <程序>] [--json]
  ${PROG} import --token <令牌> | --file <文件> | --stdin [--auth-file <路径>]
  ${PROG} status [--json] [--auth-file <路径>]
  ${PROG} verify [--chat] [--model <id>] [--json]
  ${PROG} refresh [--json]
  ${PROG} forget [--yes]

export 在**安装了 WorkBuddy 桌面版并已登录的电脑**上跑，产出一行 wb1. 开头的
令牌；import 在手机（DSHA 容器里）跑，把它写进 /root/.dsh/.workbuddy-auth.json，
dsh-workbuddy-bridge 读的就是这个文件。

选项：
  --out <文件>       导出时同时写到文件（导出默认只打 stdout）
  --file <路径>      export：指定桌面凭据文件；import：从文件读令牌或 JSON
  --electron <程序>  指定 WorkBuddy 可执行文件（缺省按平台猜）
  --auth-file <路径> 覆盖凭据文件位置（等同于 WORKBUDDY_AUTH_FILE）
  --token <令牌>     直接给令牌
  --stdin            从标准输入读令牌
  --json             输出机器可读 JSON
  --yes              不再确认（forget 用）
  --no-color         不上色
  -h, --help         显示这段

退出码：0 成功 / 1 失败 / 2 用法错误`;

const VALUE_FLAGS = new Set(['out', 'file', 'electron', 'auth-file', 'token', 'model']);
const BOOL_FLAGS = new Set(['json', 'stdin', 'yes', 'chat', 'help', 'no-color']);

/** A usage error, exit 2. */
class UsageError extends Error {}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ command: string, flags: Record<string, string | true> }} */
  const result = { command: '', flags: {} };
  const queue = [...argv];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    if (item === '-h' || item === '--help') {
      result.flags.help = true;
      continue;
    }
    if (item.startsWith('--')) {
      const name = item.slice(2);
      if (VALUE_FLAGS.has(name)) {
        const value = queue.shift();
        if (value === undefined) throw new UsageError(`--${name} 需要一个值`);
        result.flags[name] = value;
        continue;
      }
      if (BOOL_FLAGS.has(name)) {
        result.flags[name] = true;
        continue;
      }
      throw new UsageError(`不认识的选项：--${name}`);
    }
    if (result.command === '') {
      result.command = item;
      continue;
    }
    throw new UsageError(`多出来的参数：${item}`);
  }
  return result;
}

/** @param {{ json?: true, 'no-color'?: true }} flags */
function useColor(flags) {
  if (flags['no-color'] === true) return false;
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

/** @param {boolean} color */
function painter(color) {
  const wrap = (code) => (text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  return { ok: wrap('32'), bad: wrap('31'), dim: wrap('2'), bold: wrap('1'), warn: wrap('33') };
}

/** @param {string} message */
function fail(message) {
  process.stderr.write(`${message}\n`);
}

/** @param {NodeJS.WriteStream} stream @param {string} text */
async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `export`
 * @param {Record<string, string | true>} flags
 */
async function commandExport(flags) {
  const result = await exportCredential({
    desktopPath: typeof flags.file === 'string' ? flags.file : undefined,
    electronPath: typeof flags.electron === 'string' ? flags.electron : undefined,
    withToken: true,
  });
  const summary = describeCredential(result.credential);

  if (typeof flags.out === 'string') {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(flags.out, `${result.token}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, source: result.source, credential: summary, token: result.token }, null, 2)}\n`,
    );
    return 0;
  }

  // stdout: the token, alone, so it can be redirected or piped.
  process.stdout.write(`${result.token}\n`);

  const { dim, bold } = painter(useColor(flags));
  const lines = [
    '',
    `${bold('导出成功')}（${result.source}）`,
    `身份：${summary.nickname ?? summary.uid ?? '未知'}`,
    summary.domain !== '' ? `域：${summary.domain}` : '',
    summary.expiresAt !== undefined ? `access token 到期：${summary.expiresAt}` : '',
    result.expired ? '⚠️ access token 已经过期，靠 refresh token 续期；导入后第一次调用会自动续期' : '',
    '',
    dim('上面那一行（wb1. 开头）就是传输令牌，已写到 stdout。'),
    dim('把它带到手机上，在 DSHA 容器里运行：'),
    dim(`  ${PROG} import --token '<令牌>'`),
    typeof flags.out === 'string' ? `已另存到 ${flags.out}` : '',
  ].filter((line) => line !== '');
  process.stderr.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * `import`
 * @param {Record<string, string | true>} flags
 */
async function commandImport(flags) {
  let input;
  if (typeof flags.token === 'string') {
    input = flags.token;
  } else if (typeof flags.file === 'string') {
    input = await readFile(flags.file, 'utf8');
  } else if (flags.stdin === true) {
    input = await readStdin(process.stdin);
  } else {
    throw new UsageError(`需要一个来源：--token <令牌>、--file <文件> 或 --stdin`);
  }

  const result = await importCredential({
    input,
    authFile: typeof flags['auth-file'] === 'string' ? flags['auth-file'] : undefined,
  });
  const summary = describeCredential(result.credential);

  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, path: result.path, replaced: result.replaced, bytes: result.bytes, credential: summary }, null, 2)}\n`,
    );
    return 0;
  }

  const { ok: green, dim, bold } = painter(useColor(flags));
  const lines = [
    green(`${bold('已导入')} ${result.path}`),
    `大小：${result.bytes} 字节${result.replaced ? '（覆盖了原有文件）' : ''}`,
    `身份：${summary.nickname ?? summary.uid ?? '未知'}`,
    summary.domain !== '' ? `域：${summary.domain}` : '',
    summary.expiresAt !== undefined ? `access token 到期：${summary.expiresAt}` : '',
    result.expired ? '这份凭据的 access token 已过期，靠 refresh token 续期；第一次调用会自动续期' : '',
    '',
    dim('下一步：重启 DSHA 应用或重新加载会话，然后在模型选择里应该能看到 WorkBuddy。'),
    dim(`确认状态：${PROG} status`),
  ].filter((line) => line !== '');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * `status`
 * @param {Record<string, string | true>} flags
 */
async function commandStatus(flags) {
  const report = await inspectCredential({
    authFile: typeof flags['auth-file'] === 'string' ? flags['auth-file'] : undefined,
  });
  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: report.state === 'ready' || report.state === 'renewable',
          state: report.state,
          label: report.label,
          path: report.path,
          exists: report.exists,
          bytes: report.bytes,
          mode: report.mode,
          credential: report.summary,
          needs: report.fix,
        },
        null,
        2,
      )}\n`,
    );
    return report.state === 'ready' || report.state === 'renewable' ? 0 : 1;
  }
  const { ok: green, bad, warn } = painter(useColor(flags));
  const color = report.state === 'ready' ? green : report.state === 'renewable' ? warn : bad;
  process.stdout.write(`${color(formatStatus(report))}\n`);
  return report.state === 'ready' || report.state === 'renewable' ? 0 : 1;
}

/**
 * `verify`
 * @param {Record<string, string | true>} flags
 */
async function commandVerify(flags) {
  const report = await inspectCredential({
    authFile: typeof flags['auth-file'] === 'string' ? flags['auth-file'] : undefined,
  });
  if (!report.exists || report.credential === undefined) {
    throw new Error(`这台设备上还没有凭据（${report.path}）。先在电脑上 export，再 import`);
  }

  let credential = report.credential;
  const notes = [];
  const expiresAtMs = typeof credential.expiresAtMs === 'number' ? credential.expiresAtMs : 0;
  if (expiresAtMs !== 0 && expiresAtMs <= Date.now() + 60_000) {
    credential = await refreshCredential(credential);
    notes.push('access token 已到期，用 refresh token 续期后测试（未写回文件）');
  }

  const models = await listModels(credential);
  notes.push(`模型目录可用：${models.length} 个`);

  let chat;
  if (flags.chat === true) {
    const reply = await probeChat(credential, { model: typeof flags.model === 'string' ? flags.model : undefined });
    chat = { model: reply.model, content: reply.content, reasoning: reply.reasoning };
    notes.push(`对话可用：后端模型 ${reply.model || '未知'}`);
  }

  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, modelCount: models.length, models: models.map((m) => m.id || m.name), chat, notes }, null, 2)}\n`,
    );
    return 0;
  }

  const { ok: green, dim } = painter(useColor(flags));
  const lines = [green('凭据可用'), ...notes.map((note) => `- ${note}`)];
  if (chat) {
    if (chat.content !== '') {
      lines.push(`- 回复（正文）：${chat.content}`);
    } else if (chat.reasoning !== '') {
      // Not a failure: the credential and the endpoint both work, the model
      // just used its whole budget thinking. Say so instead of printing 空.
      lines.push('- 回复（正文）：（模型只输出了思考，没走到正文）');
    } else {
      lines.push('- 回复（正文）：（空）');
    }
    if (chat.reasoning !== '') lines.push(`- 回复（思考）：${chat.reasoning.slice(0, 120)}`);
  } else {
    lines.push(dim('加 --chat 可以再验证一次真实对话（会消耗一点额度）'));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * `refresh`
 * @param {Record<string, string | true>} flags
 */
async function commandRefresh(flags) {
  const report = await inspectCredential({
    authFile: typeof flags['auth-file'] === 'string' ? flags['auth-file'] : undefined,
  });
  if (!report.exists || report.credential === undefined) {
    throw new Error(`这台设备上还没有凭据（${report.path}）`);
  }
  if (report.state === 'ready') {
    process.stdout.write(`凭据还没到期（${report.summary?.expiresAt ?? '未知'}），不需要续期\n`);
    return 0;
  }
  const renewed = await refreshCredential(report.credential);
  const written = await writeAuthFile(report.path, renewed);
  const summary = describeCredential(renewed);
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, path: written.path, credential: summary }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`已续期并写回 ${written.path}\n新 access token 到期：${summary.expiresAt ?? '未知'}\n`);
  return 0;
}

/**
 * `forget`
 * @param {Record<string, string | true>} flags
 */
async function commandForget(flags) {
  const path = resolveAuthPath({ authFile: typeof flags['auth-file'] === 'string' ? flags['auth-file'] : undefined });
  if (flags.yes !== true) {
    throw new UsageError(
      `删除 ${path} 会让这台设备上的 WorkBuddy 退出登录。确认要删就加 --yes（或手动 rm 那个文件）`,
    );
  }
  const result = await forgetCredential({
    authFile: typeof flags['auth-file'] === 'string' ? flags['auth-file'] : undefined,
  });
  process.stdout.write(result.removed ? `已删除 ${result.path}\n` : `本来就不存在：${result.path}\n`);
  return 0;
}

/** @param {string[]} argv */
export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }
  const { command, flags } = parsed;
  if (flags.help === true || command === '') {
    process.stdout.write(`${HELP}\n`);
    return flags.help === true ? 0 : 2;
  }

  try {
    switch (command) {
      case 'export':
        return await commandExport(flags);
      case 'import':
        return await commandImport(flags);
      case 'status':
        return await commandStatus(flags);
      case 'verify':
        return await commandVerify(flags);
      case 'refresh':
        return await commandRefresh(flags);
      case 'forget':
        return await commandForget(flags);
      default:
        fail(`不认识的命令：${command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      fail(`${error.message}\n\n${HELP}`);
      return 2;
    }
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
    const label = typeof code === 'string' && code !== 'UNEXPECTED' ? ` [${code}]` : '';
    fail(`${error instanceof Error ? error.message : String(error)}${label}`);
    return 1;
  }
}

// Only run when invoked directly, so tests can import the helpers.
const invokedDirectly = process.argv[1] !== undefined && /cli\.(js|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
