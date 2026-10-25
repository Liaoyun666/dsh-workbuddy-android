import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CredentialError,
  describeCredential,
  extractCredential,
  normalizeCredential,
  ownDocument,
} from '../lib/credential.js';
import { encodeToken } from '../lib/token.js';

const NOW = 1_792_900_000_000;

const CREDENTIAL = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: NOW + 86_400_000,
  refreshExpiresAtMs: NOW + 1_728_000_000,
  domain: 'www.workbuddy.cn',
  uid: 'uid-1',
};

describe('extractCredential', () => {
  it('reads a transfer token', () => {
    const token = encodeToken(CREDENTIAL);
    assert.deepEqual(extractCredential(token), CREDENTIAL);
  });

  it('reads an own document', () => {
    assert.equal(extractCredential(ownDocument(CREDENTIAL)).accessToken, 'access');
  });

  it('reads a desktop auth document and lifts the identity out of account', () => {
    const document = {
      auth: {
        accessToken: 'desktop-access',
        refreshToken: 'desktop-refresh',
        expiresAt: 1795340065461,
        refreshExpiresAt: 1795512865461,
        domain: 'www.workbuddy.cn',
      },
      account: { uid: 'uid-desktop', nickname: '大肥鱼', enterpriseId: 'ent-1' },
    };
    const credential = extractCredential(document);
    assert.equal(credential.accessToken, 'desktop-access');
    assert.equal(credential.expiresAtMs, 1795340065461);
    assert.equal(credential.domain, 'www.workbuddy.cn');
    assert.equal(credential.uid, 'uid-desktop');
    assert.equal(credential.nickname, '大肥鱼');
    assert.equal(credential.enterpriseId, 'ent-1');
  });

  it('reads a bare credential object', () => {
    assert.equal(extractCredential({ accessToken: 'bare' }).accessToken, 'bare');
  });

  it('parses JSON given as text', () => {
    assert.equal(extractCredential('{"accessToken":"from-text"}').accessToken, 'from-text');
  });

  it('says what to do when handed prose', () => {
    assert.throws(() => extractCredential('这是我的令牌'), (error) => {
      assert.ok(error instanceof CredentialError);
      assert.equal(error.code, 'NOT_JSON');
      assert.match(error.message, /wb1\./);
      return true;
    });
  });

  it('rejects JSON without an access token', () => {
    assert.throws(() => extractCredential({ foo: 1 }), (error) => error.code === 'NO_ACCESS_TOKEN');
  });

  it('rejects an array', () => {
    assert.throws(() => extractCredential([{ accessToken: 'x' }]), (error) => error.code === 'NOT_OBJECT');
  });

  it('rejects nothing at all', () => {
    assert.throws(() => extractCredential('   '), (error) => error.code === 'EMPTY');
  });
});

describe('normalizeCredential', () => {
  it('keeps only the fields the bridge reads', () => {
    const { credential } = normalizeCredential(
      { accessToken: 'a', refreshToken: 'r', domain: 'd', uid: 'u', extra: 'dropped', sessionState: 'x' },
      { now: NOW },
    );
    assert.deepEqual(Object.keys(credential).sort(), ['accessToken', 'domain', 'expiresAtMs', 'refreshToken', 'uid']);
  });

  it('reads seconds as seconds', () => {
    // 1.79e9 is seconds; read as ms it would be 1970 and look expired forever.
    const { credential } = normalizeCredential({ accessToken: 'a', expiresAtMs: 1795340065 }, { now: NOW });
    assert.equal(credential.expiresAtMs, 1795340065000);
  });

  it('leaves milliseconds alone', () => {
    const { credential } = normalizeCredential({ accessToken: 'a', expiresAtMs: 1795340065461 }, { now: NOW });
    assert.equal(credential.expiresAtMs, 1795340065461);
  });

  it('treats zero as "no expiry"', () => {
    const result = normalizeCredential({ accessToken: 'a', expiresAtMs: 0 }, { now: NOW });
    assert.equal(result.credential.expiresAtMs, 0);
    assert.equal(result.expired, false);
    assert.equal(result.usable, true);
  });

  it('keeps a credential with an expired access token when it can be renewed', () => {
    const result = normalizeCredential(
      { accessToken: 'a', refreshToken: 'r', expiresAtMs: NOW - 1000, refreshExpiresAtMs: NOW + 1000 },
      { now: NOW },
    );
    assert.equal(result.expired, true);
    assert.equal(result.usable, true);
    assert.equal(result.refreshExpired, false);
  });

  it('refuses a credential whose refresh token also expired', () => {
    const result = normalizeCredential(
      { accessToken: 'a', refreshToken: 'r', expiresAtMs: NOW - 1000, refreshExpiresAtMs: NOW - 1000 },
      { now: NOW },
    );
    assert.equal(result.refreshExpired, true);
    assert.equal(result.usable, false);
  });

  it('refuses an empty access token', () => {
    assert.throws(() => normalizeCredential({ accessToken: '' }), (error) => error.code === 'NO_ACCESS_TOKEN');
  });

  it('drops empty optional strings instead of writing them', () => {
    const { credential } = normalizeCredential({ accessToken: 'a', domain: '', uid: '', enterpriseId: '', nickname: '' });
    assert.equal('enterpriseId' in credential, false);
    assert.equal('nickname' in credential, false);
  });

  it('trims whitespace from domain and uid', () => {
    const { credential } = normalizeCredential({ accessToken: 'a', domain: ' www.workbuddy.cn ', uid: ' u ' });
    assert.equal(credential.domain, 'www.workbuddy.cn');
    assert.equal(credential.uid, 'u');
  });
});

describe('ownDocument', () => {
  it('wraps at version 1', () => {
    const document = ownDocument({ accessToken: 'a' });
    assert.equal(document.version, 1);
    assert.deepEqual(document.credential, { accessToken: 'a' });
  });
});

describe('describeCredential', () => {
  it('reports lengths and dates but never the token itself', () => {
    const summary = describeCredential({ ...CREDENTIAL, expiresAtMs: 1795340065461 });
    assert.equal(summary.accessTokenLength, 6);
    assert.equal(summary.expiresAt, '2026-11-22T09:34:25.461Z');
    // The field names contain "access", so assert on the secret values.
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes('"access"'), false);
    assert.equal(serialized.includes('"refresh"'), false);
  });

  it('omits dates it does not have', () => {
    const summary = describeCredential({ accessToken: 'a' });
    assert.equal(summary.expiresAt, undefined);
    assert.equal(summary.refreshExpiresAt, undefined);
  });
});
