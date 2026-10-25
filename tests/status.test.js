import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE, STATE_FIX, STATE_LABEL, formatStatus, inspectCredential, modeIsLoose } from '../lib/status.js';
import { AUTH_FILENAME, writeAuthFile } from '../lib/store.js';

/** @type {string} */
let home;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-status-'));
});

const env = () => ({ DSH_HOME: home });
const path = () => join(home, AUTH_FILENAME);

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

describe('inspectCredential', () => {
  it('says missing when there is no file, and does not create one', async () => {
    const report = await inspectCredential({ env: env() });
    assert.equal(report.state, STATE.missing);
    assert.equal(report.exists, false);
    assert.equal(report.path, path());
  });

  it('says unreadable for a file that is not our shape', async () => {
    await writeFile(path(), JSON.stringify({ hello: 'world' }));
    const report = await inspectCredential({ env: env() });
    assert.equal(report.state, STATE.unreadable);
    assert.equal(report.exists, true);
  });

  it('says unreadable for broken JSON, without throwing', async () => {
    await writeFile(path(), '{ not json');
    const report = await inspectCredential({ env: env() });
    assert.equal(report.state, STATE.unreadable);
  });

  it('names the version when it is the wrong one', async () => {
    await writeFile(path(), JSON.stringify({ version: 2, credential: credential() }));
    const report = await inspectCredential({ env: env() });
    assert.equal(report.state, STATE.unreadable);
    assert.match(report.fix, /version 是 2/);
  });

  it('says ready for a live access token', async () => {
    await writeAuthFile(path(), credential());
    assert.equal((await inspectCredential({ env: env() })).state, STATE.ready);
  });

  it('says renewable when only the refresh token is left', async () => {
    await writeAuthFile(path(), credential({ expiresAtMs: Date.now() - 1000 }));
    const report = await inspectCredential({ env: env() });
    assert.equal(report.state, STATE.renewable);
    assert.match(report.fix, /自动续期/);
  });

  it('says expired when both tokens are gone', async () => {
    await writeAuthFile(
      path(),
      credential({ expiresAtMs: Date.now() - 1000, refreshExpiresAtMs: Date.now() - 500 }),
    );
    const report = await inspectCredential({ env: env() });
    assert.equal(report.state, STATE.expired);
    assert.match(report.fix, /重新登录/);
  });

  it('says expired when there is no refresh token at all', async () => {
    await writeAuthFile(path(), credential({ expiresAtMs: Date.now() - 1000, refreshToken: '' }));
    assert.equal((await inspectCredential({ env: env() })).state, STATE.expired);
  });

  it('treats a credential with no expiry as ready', async () => {
    await writeAuthFile(path(), credential({ expiresAtMs: 0 }));
    assert.equal((await inspectCredential({ env: env() })).state, STATE.ready);
  });

  it('reports size and identity but never the tokens', async () => {
    const secret = 'token-value-that-must-not-be-printed';
    await writeAuthFile(path(), credential({ accessToken: secret, refreshToken: secret, nickname: '小明', uid: 'u1' }));
    const report = await inspectCredential({ env: env() });
    assert.ok(typeof report.bytes === 'number' && report.bytes > 0);
    assert.equal(report.summary?.nickname, '小明');
    // The raw credential stays on the report so the probe can use it; what
    // must never carry it is the summary and the text a human or a model reads.
    assert.equal(JSON.stringify(report.summary).includes(secret), false);
    assert.equal(formatStatus(report).includes(secret), false);
  });
});

describe('state tables', () => {
  it('has a label and a fix for every state', () => {
    for (const state of Object.values(STATE)) {
      assert.equal(typeof STATE_LABEL[state], 'string');
      assert.equal(typeof STATE_FIX[state], 'string');
      assert.ok(STATE_FIX[state].length > 5, `${state} fix`);
    }
  });
});

describe('modeIsLoose', () => {
  it('flags group-readable files where permissions mean something', () => {
    const expected = process.platform === 'win32' ? false : true;
    assert.equal(modeIsLoose(0o644), expected);
  });

  it('accepts 600', () => {
    assert.equal(modeIsLoose(0o600), false);
  });

  it('says nothing about an unknown mode', () => {
    assert.equal(modeIsLoose(undefined), false);
  });
});

describe('formatStatus', () => {
  it('prints the path, the state and the next step', async () => {
    await writeAuthFile(path(), credential({ nickname: '小明', uid: 'u1' }));
    const text = formatStatus(await inspectCredential({ env: env() }));
    assert.match(text, /凭据文件：/);
    assert.match(text, /已登录/);
    assert.match(text, /身份：小明/);
    assert.match(text, /建议：/);
  });

  it('prints something useful when there is no file', async () => {
    const text = formatStatus(await inspectCredential({ env: env() }));
    assert.match(text, /没有凭据/);
    assert.match(text, /export/);
  });
});
