import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { TOKEN_PREFIX, TokenError, decodeToken, encodeToken, looksLikeToken } from '../lib/token.js';

const CREDENTIAL = {
  accessToken: 'a'.repeat(1361),
  refreshToken: 'r'.repeat(700),
  expiresAtMs: 1795340065461,
  refreshExpiresAtMs: 1795512865461,
  domain: 'www.workbuddy.cn',
  uid: 'fa72dd9b-1a14-4d1c-b982-79d9e5769eaa',
};

describe('transfer token', () => {
  it('round-trips a realistic credential', () => {
    const token = encodeToken(CREDENTIAL);
    assert.deepEqual(decodeToken(token), CREDENTIAL);
  });

  it('keeps a 2 KB credential under a pasteable length', () => {
    const token = encodeToken(CREDENTIAL);
    // The whole point of compressing: a repeated-character body shrinks hard.
    // Real tokens are random, so this asserts the ceiling rather than a ratio.
    assert.ok(token.length < 4096, `token was ${token.length} chars`);
    assert.ok(token.startsWith(TOKEN_PREFIX));
  });

  it('stays below the ceiling for high-entropy tokens', () => {
    const random = (length) => {
      let out = '';
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
      return out;
    };
    const token = encodeToken({ accessToken: random(1361), refreshToken: random(700), domain: 'www.workbuddy.cn' });
    // High entropy does not compress; the ceiling is what matters for a paste.
    assert.ok(token.length < 3500, `token was ${token.length} chars`);
    assert.equal(decodeToken(token).accessToken.length, 1361);
  });

  it('tolerates surrounding whitespace and internal line breaks', () => {
    const token = encodeToken(CREDENTIAL);
    const wrapped = `  ${token.slice(0, 40)}\n${token.slice(40)}  \n`;
    assert.deepEqual(decodeToken(wrapped), CREDENTIAL);
  });

  it('rejects text that is not a token', () => {
    assert.throws(() => decodeToken('hello'), (error) => {
      assert.ok(error instanceof TokenError);
      assert.equal(error.code, 'TOKEN_BAD_PREFIX');
      return true;
    });
  });

  it('points a pasted JSON document at --file instead of failing obscurely', () => {
    assert.throws(() => decodeToken('{"accessToken":"x"}'), (error) => {
      assert.equal(error.code, 'TOKEN_BAD_PREFIX');
      assert.match(error.message, /--file/);
      return true;
    });
  });

  it('rejects empty and absurdly long input', () => {
    assert.throws(() => decodeToken(''), (error) => error.code === 'TOKEN_EMPTY');
    assert.throws(() => decodeToken('x'.repeat(70000)), (error) => error.code === 'TOKEN_TOO_LONG');
  });

  it('rejects a non-string', () => {
    assert.throws(() => decodeToken(42), (error) => error.code === 'TOKEN_NOT_TEXT');
  });

  it('detects truncation instead of decoding half a credential', () => {
    const token = encodeToken(CREDENTIAL);
    const truncated = token.slice(0, Math.floor(token.length * 0.7));
    assert.throws(() => decodeToken(truncated), (error) => {
      // Either the gzip stream or the checksum catches it; both are refusals.
      assert.ok(['TOKEN_CORRUPT', 'TOKEN_CHECKSUM'].includes(error.code), `got ${error.code}`);
      return true;
    });
  });

  it('catches a single changed character', () => {
    const token = encodeToken(CREDENTIAL);
    const index = token.length - 30;
    const flipped = token[index] === 'A' ? 'B' : 'A';
    const corrupted = `${token.slice(0, index)}${flipped}${token.slice(index + 1)}`;
    assert.throws(() => decodeToken(corrupted), (error) => {
      assert.ok(['TOKEN_CORRUPT', 'TOKEN_CHECKSUM'].includes(error.code), `got ${error.code}`);
      return true;
    });
  });

  it('rejects a payload that decodes but is not an object', () => {
    // Hand-build a token whose JSON body is an array: the shape is wrong, and
    // the error has to say the token is corrupt rather than crash.
    const body = '[1,2,3]';
    const packed = gzipSync(Buffer.from(body, 'utf8')).toString('base64url');
    // Deliberately skip the checksum marker: this must fail on the marker.
    assert.throws(() => decodeToken(`${TOKEN_PREFIX}${packed}`), (error) => error.code === 'TOKEN_CORRUPT');
  });

  it('recognises a token without decoding it', () => {
    assert.equal(looksLikeToken(encodeToken(CREDENTIAL)), true);
    assert.equal(looksLikeToken('  wb1.abc'), true);
    assert.equal(looksLikeToken('{"a":1}'), false);
    assert.equal(looksLikeToken(undefined), false);
  });
});
