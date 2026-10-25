/**
 * The transfer token: one line of text that carries a whole WorkBuddy
 * credential from a desktop machine to the phone.
 *
 * The shape is `wb1.` followed by base64url(gzip(JSON)). Compression is not
 * decoration: a CN credential is roughly 2 KB of JSON (a 1361-character access
 * token plus a 700-character refresh token), and gzip brings that under a
 * single screenful of characters so it can be pasted into a terminal, a chat
 * message, or read off a QR code without wrapping.
 *
 * The prefix carries the version, not the machine. A token minted on Windows is
 * the same token imported on Android — which is the entire point of this
 * package.
 */

import { gzipSync, gunzipSync } from 'node:zlib';

/** Every token this package emits starts with this. */
export const TOKEN_PREFIX = 'wb1.';

/** Encoding input larger than this is certainly not a credential. */
export const MAX_TOKEN_CHARS = 64 * 1024;

/**
 * A token without a little redundant data on both ends.
 *
 * This exists so a truncated paste fails loudly at the edges instead of
 * decoding into a half credential that fails later as "token expired".
 */
const CHECK_LENGTH = 8;

/** @param {string} text */
function checksum(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0').slice(-CHECK_LENGTH);
}

/** @param {string} text */
function hashBody(text) {
  return `#${checksum(text)}`;
}

/**
 * @param {Record<string, unknown>} credential
 * @returns {string} the transfer token
 */
export function encodeToken(credential) {
  const json = JSON.stringify(credential);
  const padded = `${json}${hashBody(json)}`;
  const packed = gzipSync(Buffer.from(padded, 'utf8'), { level: 9 });
  return `${TOKEN_PREFIX}${packed.toString('base64url')}`;
}

/** A decode failure the caller is expected to show to a human. */
export class TokenError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
  }
}

/**
 * @param {unknown} text
 * @returns {Record<string, unknown>} the credential object carried by the token
 */
export function decodeToken(text) {
  if (typeof text !== 'string') {
    throw new TokenError('TOKEN_NOT_TEXT', '传输令牌必须是一段文本');
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new TokenError('TOKEN_EMPTY', '没有收到传输令牌');
  }
  if (trimmed.length > MAX_TOKEN_CHARS) {
    throw new TokenError('TOKEN_TOO_LONG', `传输令牌过长（${trimmed.length} 字符），不可能是一条凭据`);
  }
  if (!trimmed.startsWith(TOKEN_PREFIX)) {
    const looksLikeJson = trimmed.startsWith('{');
    throw new TokenError(
      'TOKEN_BAD_PREFIX',
      looksLikeJson
        ? `这看起来是 JSON 而不是传输令牌。请改用 workbuddy-android import --file <文件> 导入整份 JSON`
        : `传输令牌必须以 "${TOKEN_PREFIX}" 开头`,
    );
  }
  const body = trimmed.slice(TOKEN_PREFIX.length).replace(/\s+/g, '');
  if (body.length === 0) {
    throw new TokenError('TOKEN_EMPTY', '传输令牌里没有内容');
  }

  let raw;
  try {
    raw = gunzipSync(Buffer.from(body, 'base64url')).toString('utf8');
  } catch {
    throw new TokenError('TOKEN_CORRUPT', '传输令牌解不开：可能复制时被截断或改动了字符');
  }

  const marker = raw.lastIndexOf('#');
  if (marker < 0) {
    throw new TokenError('TOKEN_CORRUPT', '传输令牌缺少校验尾，可能被截断');
  }
  const json = raw.slice(0, marker);
  const expected = raw.slice(marker + 1);
  if (expected !== checksum(json)) {
    throw new TokenError('TOKEN_CHECKSUM', '传输令牌校验不通过：内容在复制过程中损坏了');
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TokenError('TOKEN_CORRUPT', '传输令牌里的内容不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TokenError('TOKEN_CORRUPT', '传输令牌里不是一份凭据对象');
  }
  return parsed;
}

/**
 * Whether a string is shaped like a transfer token, without decoding it.
 * @param {unknown} text
 */
export function looksLikeToken(text) {
  return typeof text === 'string' && text.trim().startsWith(TOKEN_PREFIX);
}
