import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_FILENAME, writeAuthFile } from '../lib/store.js';
import { encodeToken } from '../lib/token.js';

const CLI = fileURLToPath(new URL('../tools/cli.js', import.meta.url));

/** @type {string} */
let home;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-cli-'));
});

/**
 * Run the CLI as a real child process, the way a user would.
 *
 * `spawnSync` rather than `execFileSync`, because the interesting thing about
 * `export` is that stdout and stderr carry different things — and
 * `execFileSync` only hands back stdout when the process succeeds.
 * @param {string[]} args
 * @param {{ input?: string }} [options]
 */
function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, NO_COLOR: '1' },
    input: options.input,
    timeout: 60_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const authPath = () => join(home, AUTH_FILENAME);

/** @param {Record<string, unknown>} [overrides] */
function credential(overrides = {}) {
  return {
    accessToken: 'a',
    refreshToken: 'r',
    domain: 'www.workbuddy.cn',
    expiresAtMs: Date.now() + 3600_000,
    ...overrides,
  };
}

/** A plaintext desktop auth file, so export needs no Electron app. */
async function desktopFile() {
  const path = join(home, 'workbuddy-desktop.info');
  await writeFile(
    path,
    JSON.stringify({
      auth: {
        accessToken: 'desktop-access',
        refreshToken: 'desktop-refresh',
        domain: 'www.workbuddy.cn',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      account: { uid: 'uid-1', nickname: '小明' },
    }),
  );
  return path;
}

describe('help and usage', () => {
  it('prints help with no arguments and exits 2', () => {
    const result = run([]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /workbuddy-android/);
    assert.match(result.stdout, /export/);
  });

  it('prints help for --help and exits 0', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /退出码：0 成功 \/ 1 失败 \/ 2 用法错误/);
  });

  it('rejects an unknown command with exit 2', () => {
    const result = run(['frobnicate']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /不认识的命令/);
  });

  it('rejects an unknown flag with exit 2', () => {
    const result = run(['status', '--wat']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /不认识的选项/);
  });

  it('asks for a value when a value flag is last', () => {
    const result = run(['import', '--token']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /需要一个值/);
  });
});

describe('export', () => {
  it('writes the token to stdout and nothing else', async () => {
    const file = await desktopFile();
    const result = run(['export', '--file', file]);
    assert.equal(result.status, 0);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `stdout must be one line, got: ${result.stdout}`);
    assert.ok(lines[0].startsWith('wb1.'));
    // The human explanation goes to stderr so pipes stay clean.
    assert.match(result.stderr, /导出成功/);
  });

  it('round-trips through import', async () => {
    const file = await desktopFile();
    const exported = run(['export', '--file', file]);
    const token = exported.stdout.trim();

    const imported = run(['import', '--token', token]);
    assert.equal(imported.status, 0);
    assert.match(imported.stdout, /已导入/);
    const document = JSON.parse(await readFile(authPath(), 'utf8'));
    assert.equal(document.credential.accessToken, 'desktop-access');
    assert.equal(document.credential.nickname, '小明');
  });

  it('also saves a copy with --out', async () => {
    const file = await desktopFile();
    const out = join(home, 'token.txt');
    const result = run(['export', '--file', file, '--out', out]);
    assert.equal(result.status, 0);
    assert.equal((await readFile(out, 'utf8')).trim(), result.stdout.trim());
  });

  it('emits parseable JSON with --json', async () => {
    const file = await desktopFile();
    const result = run(['export', '--file', file, '--json']);
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.token.startsWith('wb1.'));
    assert.equal(payload.credential.nickname, '小明');
    assert.equal(result.stdout.includes('\u001b['), false);
  });

  it('fails with exit 1 and a readable message when there is no desktop file', () => {
    const result = run(['export']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DESKTOP_NOT_FOUND|没找到/);
  });
});

describe('import', () => {
  it('reads a token from a file', async () => {
    const token = encodeToken(credential());
    const path = join(home, 'token.txt');
    await writeFile(path, token);
    const result = run(['import', '--file', path]);
    assert.equal(result.status, 0);
    assert.equal(existsSync(authPath()), true);
  });

  it('reads a token from stdin', async () => {
    const token = encodeToken(credential());
    const result = run(['import', '--stdin'], { input: token });
    assert.equal(result.status, 0);
    assert.equal(existsSync(authPath()), true);
  });

  it('refuses with exit 2 when no source is given', () => {
    const result = run(['import']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /需要一个来源/);
  });

  it('fails with exit 1 and a code for a bad token', () => {
    const result = run(['import', '--token', 'wb1.garbage']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TOKEN_/);
  });

  it('honours --auth-file', async () => {
    const token = encodeToken(credential());
    const elsewhere = join(home, 'custom.json');
    const result = run(['import', '--token', token, '--auth-file', elsewhere]);
    assert.equal(result.status, 0);
    assert.equal(existsSync(elsewhere), true);
    assert.equal(existsSync(authPath()), false);
  });
});

describe('status', () => {
  it('exits 1 and explains when nothing is imported', () => {
    const result = run(['status']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /没有凭据/);
  });

  it('exits 0 for a usable credential', async () => {
    await writeAuthFile(authPath(), credential());
    const result = run(['status']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /已登录/);
  });

  it('emits JSON with --json', async () => {
    await writeAuthFile(authPath(), credential({ nickname: '小明' }));
    const result = run(['status', '--json']);
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.state, 'ready');
    assert.equal(payload.credential.nickname, '小明');
    assert.equal(result.stdout.includes('\u001b['), false);
  });

  it('treats a renewable credential as usable', async () => {
    await writeAuthFile(authPath(), credential({ expiresAtMs: Date.now() - 1000 }));
    assert.equal(run(['status']).status, 0);
  });
});

describe('refresh', () => {
  it('says there is nothing to do when the token is fresh', async () => {
    await writeAuthFile(authPath(), credential());
    const result = run(['refresh']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /不需要续期/);
  });

  it('does not touch anything when there is no credential', () => {
    const result = run(['refresh']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /还没有凭据/);
  });
});

describe('forget', () => {
  it('refuses without --yes and says why', async () => {
    await writeAuthFile(authPath(), credential());
    const result = run(['forget']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--yes/);
    assert.equal(existsSync(authPath()), true);
  });

  it('deletes with --yes', async () => {
    await writeAuthFile(authPath(), credential());
    const result = run(['forget', '--yes']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /已删除/);
    assert.equal(existsSync(authPath()), false);
  });

  it('says when there was nothing to delete', () => {
    const result = run(['forget', '--yes']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /本来就不存在/);
  });
});
