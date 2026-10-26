import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../lib/tools.js';
import { writeAuthFile, AUTH_FILENAME } from '../lib/store.js';
import { encodeToken } from '../lib/token.js';
import { RENEWED_ACCESS_TOKEN, VALID_ACCESS_TOKEN, VALID_REFRESH_TOKEN, startMockApi } from '../tools/mock-api.js';

/** @type {Awaited<ReturnType<typeof startMockApi>>} */
let mock;
/** @type {string} */
let home;

before(async () => {
  mock = await startMockApi();
});

after(async () => {
  await mock.close();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-tools-'));
});

/** @param {Record<string, unknown>} [overrides] */
function credential(overrides = {}) {
  return {
    accessToken: VALID_ACCESS_TOKEN,
    refreshToken: VALID_REFRESH_TOKEN,
    domain: 'www.workbuddy.cn',
    expiresAtMs: Date.now() + 3600_000,
    refreshExpiresAtMs: Date.now() + 86_400_000,
    ...overrides,
  };
}

/** Build the tool set against a throwaway DSH home. */
function tools() {
  return buildTools({ env: { DSH_HOME: home }, baseUrl: mock.baseUrl });
}

/** @param {Array<Record<string, any>>} list */
function byName(list) {
  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

describe('tool set', () => {
  it('registers exactly five tools with the names the manifest promises', () => {
    const names = tools().map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'workbuddy_capture_from_phone',
      'workbuddy_import',
      'workbuddy_probe',
      'workbuddy_refresh',
      'workbuddy_status',
    ]);
  });

  it('gives every tool a description and a JSON schema', () => {
    for (const tool of tools()) {
      assert.ok(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name} description`);
      assert.equal(tool.parameters.type, 'object');
      assert.equal(typeof tool.parameters.properties, 'object');
    }
  });
});

describe('workbuddy_status', () => {
  it('does not throw when nothing has been imported', async () => {
    const result = await byName(tools()).workbuddy_status.execute({});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'missing');
    assert.match(result.text, /还没有导入过/);
  });

  it('reports a good credential as ready', async () => {
    await writeAuthFile(join(home, AUTH_FILENAME), credential());
    const result = await byName(tools()).workbuddy_status.execute({});
    assert.equal(result.ok, true);
    assert.equal(result.code, 'ready');
    assert.match(result.text, /已登录/);
  });

  it('reports an expired-but-renewable credential as usable', async () => {
    await writeAuthFile(join(home, AUTH_FILENAME), credential({ expiresAtMs: Date.now() - 1000 }));
    const result = await byName(tools()).workbuddy_status.execute({});
    // Usable: the bridge can renew it. Saying "not ok" here would make the
    // agent tell the user to re-export for no reason.
    assert.equal(result.ok, true);
    assert.equal(result.code, 'renewable');
  });
});

describe('workbuddy_probe', () => {
  it('refuses to pretend when there is no credential', async () => {
    const result = await byName(tools()).workbuddy_probe.execute({});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_CREDENTIAL');
  });

  it('lists models without chatting by default', async () => {
    await writeAuthFile(join(home, AUTH_FILENAME), credential());
    const result = await byName(tools()).workbuddy_probe.execute({});
    assert.equal(result.ok, true);
    assert.equal(result.modelCount, 2);
    assert.deepEqual(result.models, ['default', 'hy4-preview']);
    assert.equal(result.chat, undefined);
  });

  it('chats only when asked', async () => {
    await writeAuthFile(join(home, AUTH_FILENAME), credential());
    const result = await byName(tools()).workbuddy_probe.execute({ chat: true });
    assert.equal(result.ok, true);
    assert.equal(result.chat.content, '收到');
  });

  it('renews a stale token in memory without writing the file', async () => {
    await writeAuthFile(join(home, AUTH_FILENAME), credential({ expiresAtMs: Date.now() - 1000 }));
    const before = mock.state.refreshCalls;
    const result = await byName(tools()).workbuddy_probe.execute({});
    assert.equal(result.ok, true);
    assert.equal(mock.state.refreshCalls, before + 1);
    assert.match(result.text, /未写回文件/);

    // The file must still hold the old token: a probe is read-only.
    const { readAuthFile } = await import('../lib/store.js');
    const after = await readAuthFile(join(home, AUTH_FILENAME));
    assert.equal(/** @type {any} */ (after.document).credential.accessToken, VALID_ACCESS_TOKEN);
  });

  it('returns a code and a hint instead of throwing on a rejected token', async () => {
    await writeAuthFile(join(home, AUTH_FILENAME), credential({ accessToken: 'wrong' }));
    const result = await byName(tools()).workbuddy_probe.execute({});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOKEN_REJECTED');
    assert.match(result.hint, /重新登录/);
  });
});

describe('workbuddy_import', () => {
  it('imports a transfer token and says where it landed', async () => {
    const token = encodeToken(credential());
    const result = await byName(tools()).workbuddy_import.execute({ token });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'IMPORTED');
    assert.equal(result.path, join(home, AUTH_FILENAME));
    assert.match(result.text, /已写入/);
  });

  it('never echoes the token back', async () => {
    const token = encodeToken(credential());
    const result = await byName(tools()).workbuddy_import.execute({ token });
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(result).includes(VALID_ACCESS_TOKEN), false);
  });

  it('explains a token-shaped string that is not a real token', async () => {
    const result = await byName(tools()).workbuddy_import.execute({ token: 'wb1.not-a-real-payload' });
    assert.equal(result.ok, false);
    assert.ok(['TOKEN_CORRUPT', 'TOKEN_CHECKSUM'].includes(result.code), result.code);
    assert.match(result.hint, /重新/);
  });

  it('points at the prefix when the text is neither token nor JSON', async () => {
    // "hello" has no `wb1.` prefix and does not parse as JSON, so the useful
    // answer is the two shapes we accept — not a JSON parse error.
    const result = await byName(tools()).workbuddy_import.execute({ token: 'hello' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_JSON');
    assert.match(result.error, /wb1\./);
  });

  it('explains a truncated token', async () => {
    const token = encodeToken(credential());
    const result = await byName(tools()).workbuddy_import.execute({ token: token.slice(0, 40) });
    assert.equal(result.ok, false);
    assert.ok(['TOKEN_CORRUPT', 'TOKEN_CHECKSUM'].includes(result.code), result.code);
  });

  it('refuses a dead credential and says retrying is useless', async () => {
    const dead = encodeToken({ accessToken: 'a', expiresAtMs: Date.now() - 5000 });
    const result = await byName(tools()).workbuddy_import.execute({ token: dead });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UNUSABLE');
    assert.match(result.hint, /重试无效/);
  });
});

describe('workbuddy_refresh', () => {
  it('skips a credential that is still fresh', async () => {
    await writeAuthFile(join(home, AUTH_FILENAME), credential());
    const before = mock.state.refreshCalls;
    const result = await byName(tools()).workbuddy_refresh.execute({});
    assert.equal(result.code, 'STILL_FRESH');
    assert.equal(result.skipped, true);
    // The whole point: do not rotate tokens the bridge is still using.
    assert.equal(mock.state.refreshCalls, before);
  });

  it('renews and writes back when the access token has expired', async () => {
    await writeAuthFile(join(home, AUTH_FILENAME), credential({ expiresAtMs: Date.now() - 1000 }));
    const result = await byName(tools()).workbuddy_refresh.execute({});
    assert.equal(result.ok, true);
    assert.equal(result.code, 'REFRESHED');

    const { readAuthFile } = await import('../lib/store.js');
    const after = await readAuthFile(join(home, AUTH_FILENAME));
    assert.equal(/** @type {any} */ (after.document).credential.accessToken, RENEWED_ACCESS_TOKEN);
  });

  it('explains a rejected refresh token', async () => {
    // A bad refresh token, not a bad access token: the access token is allowed
    // to be stale, that is exactly when we refresh.
    await writeAuthFile(
      join(home, AUTH_FILENAME),
      credential({ refreshToken: 'bogus-refresh', expiresAtMs: Date.now() - 1000 }),
    );
    const result = await byName(tools()).workbuddy_refresh.execute({});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOKEN_REJECTED');
    assert.match(result.hint, /重新登录/);
  });
});

describe('guard', () => {
  it('turns an unexpected error into a code, not a stack', async () => {
    // A bridge URL of a closed port is a real network failure, and it must
    // come back as data the model can read.
    const broken = buildTools({ env: { DSH_HOME: home }, baseUrl: 'http://127.0.0.1:1' });
    await writeAuthFile(join(home, AUTH_FILENAME), credential());
    const result = await byName(broken).workbuddy_probe.execute({});
    assert.equal(result.ok, false);
    assert.ok(['NETWORK_UNREACHABLE', 'NETWORK_ERROR', 'UNEXPECTED'].includes(result.code), result.code);
    assert.equal(typeof result.hint, 'string');
  });
});
