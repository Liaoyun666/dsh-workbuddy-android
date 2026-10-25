import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  AtRestError,
  buildAad,
  credentialFromDesktop,
  decryptField,
  deriveKey,
  documentIsEncrypted,
  encryptField,
  isEncryptedField,
  openDesktopDocument,
  parseEnvelope,
} from '../lib/atrest.js';

/** A base64 secret shaped like the one the desktop app hands out. */
const SECRET = randomBytes(32).toString('base64');

describe('deriveKey', () => {
  it('derives a 32-byte key and a 16-hex key id', () => {
    const { key, keyId } = deriveKey(SECRET);
    assert.equal(key.length, 32);
    assert.match(keyId, /^[0-9a-f]{16}$/);
  });

  it('is stable for the same secret and different for another', () => {
    assert.equal(deriveKey(SECRET).keyId, deriveKey(SECRET).keyId);
    assert.notEqual(deriveKey(SECRET).keyId, deriveKey(randomBytes(32).toString('base64')).keyId);
  });

  it('rejects an empty secret', () => {
    assert.throws(() => deriveKey(''), (error) => error instanceof AtRestError && error.code === 'SECRET_EMPTY');
  });

  it('hashes the base64 text, not the decoded bytes', () => {
    // Round-trip tests cannot catch this: encrypt and decrypt both go through
    // deriveKey, so a wrong derivation stays self-consistent. Only the envelope's
    // own keyId exposes it — real credentials failed with KEY_ID_MISMATCH until
    // this was fixed. Pin the rule against an independent computation.
    const secret = 'AAAA' + 'Zm9vYmFy'.repeat(6);
    const textKey = createHash('sha256').update(secret, 'utf8').digest();
    const byteKey = createHash('sha256').update(Buffer.from(secret, 'base64')).digest();
    const idOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

    assert.equal(deriveKey(secret).keyId, idOf(textKey));
    assert.notEqual(deriveKey(secret).keyId, idOf(byteKey));
    assert.deepEqual(deriveKey(secret).key, textKey);
  });
});

describe('AAD', () => {
  it('is length-prefixed so two different key ids cannot collide', () => {
    const a = buildAad(1, 'aaaaaaaaaaaaaaaa');
    const b = buildAad(1, 'aaaaaaaaaaaaaaab');
    assert.notDeepEqual(a, b);
    assert.ok(a.length > 0);
  });

  it('starts with the domain prefix and version byte', () => {
    const aad = buildAad(1, 'k');
    assert.equal(aad.subarray(0, 7).toString('ascii'), 'WB-AAD\0');
    assert.equal(aad[7], 1);
  });

  it('distinguishes suites', () => {
    assert.notDeepEqual(buildAad(1, 'k'), buildAad(2, 'k'));
  });
});

describe('encrypt / decrypt round trip', () => {
  it('recovers the plaintext', () => {
    const derived = deriveKey(SECRET);
    const field = encryptField('the-access-token', derived);
    assert.equal(isEncryptedField(field), true);
    assert.equal(decryptField(field, derived), 'the-access-token');
  });

  it('round-trips unicode', () => {
    const derived = deriveKey(SECRET);
    assert.equal(decryptField(encryptField('大肥鱼 🐟', derived), derived), '大肥鱼 🐟');
  });

  it('fails with a different key', () => {
    const field = encryptField('secret', deriveKey(SECRET));
    const other = deriveKey(randomBytes(32).toString('base64'));
    assert.throws(() => decryptField(field, other), (error) => {
      // The key id mismatch is caught before the cipher runs, which is the
      // better error: it names the real problem.
      assert.equal(error.code, 'KEY_ID_MISMATCH');
      return true;
    });
  });

  it('fails when the ciphertext is altered', () => {
    const derived = deriveKey(SECRET);
    const field = encryptField('secret', derived);
    const envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'));
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    envelope.ciphertext = bytes.toString('base64');
    const tampered = { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') };
    assert.throws(() => decryptField(tampered, derived), (error) => error.code === 'DECRYPT_FAILED');
  });

  it('rejects an unknown suite', () => {
    const derived = deriveKey(SECRET);
    const field = encryptField('secret', derived, { suite: 7 });
    assert.throws(() => decryptField(field, derived), (error) => error.code === 'SUITE_UNSUPPORTED');
  });
});

describe('parseEnvelope', () => {
  it('rejects a plain value', () => {
    assert.throws(() => parseEnvelope('just a string'), (error) => error.code === 'NOT_ENCRYPTED');
  });

  it('rejects an envelope that is not a string', () => {
    // This is the mistake that produces an opaque cipher error: the real file
    // stores the envelope as a base64 string, not as an object.
    assert.throws(() => parseEnvelope({ $wbEncrypted: 1, envelope: { nonce: 'x' } }), (error) => {
      assert.equal(error.code, 'ENVELOPE_MISSING');
      return true;
    });
  });

  it('rejects an envelope missing its parts', () => {
    const envelope = Buffer.from(JSON.stringify({ suite: 1, keyId: 'k' }), 'utf8').toString('base64');
    assert.throws(() => parseEnvelope({ $wbEncrypted: 1, envelope }), (error) => error.code === 'ENVELOPE_INCOMPLETE');
  });

  it('rejects an envelope that is not JSON', () => {
    const envelope = Buffer.from('not json', 'utf8').toString('base64');
    assert.throws(() => parseEnvelope({ $wbEncrypted: 1, envelope }), (error) => error.code === 'ENVELOPE_CORRUPT');
  });
});

describe('openDesktopDocument', () => {
  it('decrypts auth and account fields', () => {
    const derived = deriveKey(SECRET);
    const document = {
      auth: {
        accessToken: encryptField('access', derived),
        refreshToken: encryptField('refresh', derived),
        domain: 'www.workbuddy.cn',
        expiresAt: 1795340065461,
      },
      account: { uid: 'uid-1', nickname: encryptField('大肥鱼', derived) },
    };
    const opened = openDesktopDocument(document, derived);
    assert.equal(opened.auth.accessToken, 'access');
    assert.equal(opened.auth.refreshToken, 'refresh');
    assert.equal(opened.auth.domain, 'www.workbuddy.cn');
    assert.equal(opened.account.nickname, '大肥鱼');
  });

  it('passes plaintext documents through untouched', () => {
    const document = { auth: { accessToken: 'plain', domain: 'd' }, account: { uid: 'u' } };
    const opened = openDesktopDocument(document, undefined);
    assert.equal(opened.auth.accessToken, 'plain');
    assert.equal(opened.account.uid, 'u');
  });

  it('refuses an encrypted document when no key was given', () => {
    const derived = deriveKey(SECRET);
    const document = { auth: { accessToken: encryptField('access', derived) } };
    assert.throws(() => openDesktopDocument(document, undefined), (error) => error.code === 'NEED_SECRET');
  });

  it('says to sign in when there is no access token', () => {
    assert.throws(() => openDesktopDocument({ auth: { domain: 'd' } }, undefined), (error) => {
      assert.equal(error.code, 'NO_ACCESS_TOKEN');
      assert.match(error.message, /登录/);
      return true;
    });
  });

  it('rejects a document that is not an object', () => {
    // @ts-expect-error deliberately wrong input
    assert.throws(() => openDesktopDocument('nope', undefined), (error) => error.code === 'NOT_OBJECT');
  });
});

describe('credentialFromDesktop', () => {
  it('maps the auth and account fields to credential fields', () => {
    const credential = credentialFromDesktop({
      auth: { accessToken: 'a', refreshToken: 'r', domain: 'www.workbuddy.cn', expiresAt: 1795340065461 },
      account: { uid: 'u', nickname: 'n', enterpriseId: 'e' },
    });
    assert.deepEqual(credential, {
      accessToken: 'a',
      refreshToken: 'r',
      domain: 'www.workbuddy.cn',
      uid: 'u',
      expiresAtMs: 1795340065461,
      enterpriseId: 'e',
      nickname: 'n',
    });
  });

  it('omits what is missing instead of writing undefined', () => {
    const credential = credentialFromDesktop({ auth: { accessToken: 'a' }, account: {} });
    assert.equal('expiresAtMs' in credential, false);
    assert.equal('enterpriseId' in credential, false);
  });
});

describe('documentIsEncrypted', () => {
  it('detects encryption under auth', () => {
    const derived = deriveKey(SECRET);
    assert.equal(documentIsEncrypted({ auth: { accessToken: encryptField('a', derived) } }), true);
  });

  it('detects encryption under accounts', () => {
    const derived = deriveKey(SECRET);
    assert.equal(documentIsEncrypted({ accounts: { 0: { nickname: encryptField('n', derived) } } }), true);
  });

  it('reports plaintext documents as not encrypted', () => {
    assert.equal(documentIsEncrypted({ auth: { accessToken: 'a' }, account: { uid: 'u' } }), false);
  });
});
