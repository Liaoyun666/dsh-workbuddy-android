/**
 * The agent-facing tools.
 *
 * Four tools, split by what they touch rather than by what they are called:
 *
 *   workbuddy_status    reads the file            (no network, no writes)
 *   workbuddy_probe     talks to WorkBuddy        (no writes)
 *   workbuddy_import    writes the file           (no network)
 *   workbuddy_refresh   talks and writes          (both)
 *
 * The split exists because the useful question is never "did it work" but
 * "which of the two halves failed" — a phone can have a perfectly good
 * credential and no network, or a network and an expired refresh token, and the
 * fixes are completely different.
 *
 * Every result is `{ ok, code, ... }`. A thrown error would reach the model as
 * `Error: fetch failed`, which teaches it nothing; a code plus a sentence tells
 * it whether retrying is pointless.
 */

import { inspectCredential, modeIsLoose, STATE } from './status.js';
import { WorkBuddyError, listModels, probeChat, refreshCredential } from './api.js';
import { CredentialError, describeCredential } from './credential.js';
import { TokenError } from './token.js';
import { removeAuthFile, resolveAuthPath, writeAuthFile } from './store.js';

/** How each failure code should be explained, and whether retrying helps. */
const EXPLAIN = {
  NO_INPUT: '没有要导入的内容。让用户把电脑上导出的令牌贴过来，或者用 workbuddy-android import --token',
  TOKEN_EMPTY: '令牌是空的。让用户重新复制完整的 wb1. 开头那串',
  TOKEN_BAD_PREFIX: '这不是本插件导出的令牌。它必须以 wb1. 开头；如果是一份 JSON，请改用 --file 导入',
  TOKEN_CORRUPT: '令牌在传递过程中被截断或改写。让用户重新导出、重新粘贴（不要手工换行）',
  TOKEN_CHECKSUM: '令牌校验不通过，内容已损坏。重新导出最省事',
  TOKEN_TOO_LONG: '这段内容太长，不像令牌。请确认贴的是 wb1. 开头的那一行',
  NOT_JSON: '这段内容既不是令牌也不是 JSON。要令牌（wb1. 开头）或整份凭据文件',
  NO_ACCESS_TOKEN: '凭据里没有 accessToken。用户导出的可能不是凭据文件',
  EMPTY: '没有收到内容。',
  UNUSABLE: '这份凭据已经不能用了 —— 重试无效，必须回电脑重新登录 WorkBuddy 桌面版再导出',
  TOKEN_REJECTED: 'WorkBuddy 拒绝了这个凭据 —— 重试无效，请重新登录桌面版再导出',
  NO_REFRESH_TOKEN: '凭据没有 refreshToken，到期后无法续期。请重新导出（导出内容应含 refreshToken）',
  REFRESH_NO_TOKEN: '续期接口说成功却没给新 token。稍后再试一次；仍失败就重新导出',
  NETWORK_TIMEOUT: '网络超时。稍后重试可能有用',
  NETWORK_DNS: 'DNS 解析失败。检查手机网络，重试可能有用',
  NETWORK_UNREACHABLE: '连不上 WorkBuddy。检查网络后重试',
  NETWORK_TLS: 'TLS 握手失败。多半是代理或系统证书问题，重试无用',
  NETWORK_ERROR: '请求失败。看 message 里具体原因',
  SERVICE_ERROR: 'WorkBuddy 服务端报错。稍后重试；持续失败就不是这份凭据的问题',
  BAD_RESPONSE: '服务返回了非 JSON。多半是被网关拦截',
  EMPTY_REPLY: '模型没有回内容，但凭据是通的。可能该模型暂时不可用',
  EIO: '写文件失败。检查 /root/.dsh 的权限和剩余空间',
  EACCES: '没有权限写凭据文件。检查 /root/.dsh 的属主',
};

/**
 * @param {string} code
 * @param {string} [detail]
 */
function explain(code, detail) {
  const base = EXPLAIN[code];
  if (base === undefined) return detail ?? `失败码：${code}`;
  return detail === undefined || detail === '' ? base : `${base}（${code}）`;
}

/** Turn any thrown value into a result object. */
function guard(executor) {
  return async (...args) => {
    try {
      return await executor(...args);
    } catch (error) {
      if (
        error instanceof TokenError ||
        error instanceof CredentialError ||
        error instanceof WorkBuddyError
      ) {
        return { ok: false, code: error.code, error: error.message, hint: explain(error.code, '') };
      }
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
      if (typeof code === 'string' && EXPLAIN[code] !== undefined) {
        return {
          ok: false,
          code,
          error: /** @type {Error} */ (error).message,
          hint: explain(code, ''),
        };
      }
      return {
        ok: false,
        code: 'UNEXPECTED',
        error: /** @type {Error} */ (error)?.message ?? String(error),
        hint: '这是本插件没预料到的失败。把这段原文告诉用户',
      };
    }
  };
}

/**
 * Render a status report as one short block of text.
 * @param {Awaited<ReturnType<typeof inspectCredential>>} report
 */
export function renderStatus(report) {
  const lines = [`状态：${report.label}（${report.state}）`, `文件：${report.path}`];
  if (!report.exists) {
    lines.push('这个文件还不存在，说明这台设备上还没有导入过凭据。');
  } else {
    const bits = [];
    if (report.bytes !== undefined) bits.push(`${report.bytes} 字节`);
    if (report.mode !== undefined && process.platform !== 'win32') bits.push(`权限 ${report.mode.toString(8)}`);
    if (bits.length > 0) lines.push(`大小：${bits.join('，')}`);
    if (report.summary) {
      const s = report.summary;
      if (s.nickname || s.uid) lines.push(`身份：${s.nickname ?? s.uid}`);
      if (s.domain !== '') lines.push(`域：${s.domain}`);
      if (s.expiresAt !== undefined) lines.push(`access token 到期：${s.expiresAt}`);
      if (s.refreshExpiresAt !== undefined) lines.push(`refresh token 到期：${s.refreshExpiresAt}`);
    }
    if (modeIsLoose(report.mode)) lines.push('⚠️ 权限太宽：同一容器里的其它进程也能读到它');
  }
  lines.push(`下一步：${report.fix}`);
  return lines.join('\n');
}

/**
 * Build the four tools.
 *
 * @param {{ env?: NodeJS.ProcessEnv, authFile?: string, baseUrl?: string }} [options]
 */
export function buildTools(options = {}) {
  // `baseUrl` is threaded through so the tests can point every call at a local
  // mock; the product never sets it.
  const apiOptions = options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl };
  const context = { env: options.env, authFile: options.authFile };

  /** @type {Array<Record<string, unknown>>} */
  const tools = [];
  const push = (definition) =>
    tools.push({ ...definition, execute: guard(definition.execute) });

  push({
    name: 'workbuddy_status',
    description:
      '查看这台设备上的 WorkBuddy 登录态：有没有凭据文件、是否可用、什么时候到期、身份是谁。只读本地文件，不联网。用户问「workbuddy 能不能用」「为什么 workbuddy 没反应」时先调它。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const report = await inspectCredential(context);
      return {
        ok: report.state === STATE.ready || report.state === STATE.renewable,
        code: report.state,
        state: report.state,
        path: report.path,
        exists: report.exists,
        credential: report.summary,
        needs: report.fix,
        text: renderStatus(report),
      };
    },
  });

  push({
    name: 'workbuddy_probe',
    description:
      '真的向 WorkBuddy 发一次请求，确认凭据通不通：先续期（只在需要时），再拉一次模型列表；chat=true 时再发一句极短的对话。只读链路，不会写凭据文件。状态显示「已登录」但用户说用不了时调它。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'boolean', description: '是否额外发一次极短的对话（会消耗一点额度）' },
        model: { type: 'string', description: 'chat 用的模型 id，缺省 default' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const report = await inspectCredential(context);
      if (!report.exists || report.credential === undefined) {
        return {
          ok: false,
          code: 'NO_CREDENTIAL',
          hint: `这台设备上还没有凭据。${report.fix}`,
        };
      }
      let credential = report.credential;
      const notes = [];

      const expiresAtMs = typeof credential.expiresAtMs === 'number' ? credential.expiresAtMs : 0;
      const needsRefresh = expiresAtMs !== 0 && expiresAtMs <= Date.now() + 60_000;
      if (needsRefresh) {
        credential = await refreshCredential(credential, apiOptions);
        notes.push('access token 已到期，本次用 refresh token 续期后测试（未写回文件）');
      }

      const models = await listModels(credential, apiOptions);
      notes.push(`模型目录可用，共 ${models.length} 个模型`);

      let chatResult;
      if (args.chat === true) {
        const reply = await probeChat(credential, { ...apiOptions, model: args.model });
        chatResult = {
          model: reply.model,
          content: reply.content.slice(0, 200),
          reasoning: reply.reasoning.slice(0, 200),
        };
        notes.push(`对话可用，后端模型 ${reply.model || '未知'}`);
      }

      return {
        ok: true,
        code: 'PROBE_OK',
        region: typeof credential.domain === 'string' && credential.domain.endsWith('workbuddy.ai') ? 'global' : 'cn',
        models: models.slice(0, 12).map((m) => m.id || m.name).filter(Boolean),
        modelCount: models.length,
        chat: chatResult,
        notes,
        text: notes.join('；'),
      };
    },
  });

  push({
    name: 'workbuddy_import',
    description:
      '把一份 WorkBuddy 登录态导入这台设备：接受电脑上导出的传输令牌（wb1. 开头的一行文本），也接受整份凭据 JSON。写入 /root/.dsh/.workbuddy-auth.json（权限 600），dsh-workbuddy-bridge 会读它。注意：令牌会经过对话记录，更安全的做法是让用户在终端里运行 workbuddy-android import。',
    parameters: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          description: '传输令牌（wb1. 开头）或整份凭据 JSON 文本',
        },
      },
      required: ['token'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const { importCredential } = await import('./transfer.js');
      const result = await importCredential({ ...context, input: args.token });
      return {
        ok: true,
        code: 'IMPORTED',
        path: result.path,
        replaced: result.replaced,
        bytes: result.bytes,
        credential: describeCredential(result.credential),
        text: `已写入 ${result.path}（${result.bytes} 字节${result.replaced ? '，覆盖了原有文件' : ''}）。现在 workbuddy_status 应该显示「已登录」`,
      };
    },
  });

  push({
    name: 'workbuddy_refresh',
    description:
      '用已有的 refresh token 换一张新的 access token，并写回凭据文件。凭据还有效时不要调用 —— 该由 dsh-workbuddy-bridge 自己按需续期，手动续期只会让两边的 refresh token 轮换打架。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const report = await inspectCredential(context);
      if (!report.exists || report.credential === undefined) {
        return { ok: false, code: 'NO_CREDENTIAL', hint: `这台设备上还没有凭据。${report.fix}` };
      }
      if (report.state === STATE.ready) {
        const summary = report.summary;
        return {
          ok: true,
          code: 'STILL_FRESH',
          skipped: true,
          expiresAt: summary?.expiresAt,
          text: '凭据还没到期，不需要续期。让它自己到期后续期，或交给 dsh-workbuddy-bridge',
        };
      }
      const renewed = await refreshCredential(report.credential, apiOptions);
      const written = await writeAuthFile(report.path, renewed);
      return {
        ok: true,
        code: 'REFRESHED',
        path: written.path,
        credential: describeCredential(renewed),
        text: `已续期并写回 ${written.path}，新 access token 到期时间 ${describeCredential(renewed).expiresAt ?? '未知'}`,
      };
    },
  });

  return tools;
}

/**
 * Forget the credential. Not exposed as a tool: deleting someone's login state
 * is a decision for the human, and the CLI asks for confirmation.
 * @param {{ env?: NodeJS.ProcessEnv, authFile?: string }} [options]
 */
export async function forgetCredential(options = {}) {
  const path = resolveAuthPath(options);
  return { path, removed: await removeAuthFile(path) };
}
