/**
 * Credential shapes: what this package accepts, and the one shape
 * `dsh-workbuddy-bridge` reads back.
 *
 * The bridge plugin owns `/root/.dsh/.workbuddy-auth.json` and only ever
 * writes it itself. On a phone there is no WorkBuddy desktop app and no system
 * keychain, so that file is the *only* way the plugin can get a credential —
 * and this module is what puts it there, in exactly the shape the bridge's own
 * `parseOwnDocument` accepts:
 *
 * ```json
 * { "version": 1, "credential": { "accessToken": "…" } }
 * ```
 *
 * Everything else in here is leniency about the *source*: a desktop
 * plaintext auth document, a credential object lifted out of one, or a
 * transfer token. Leniency stops at the door — what gets written is one
 * canonical document, so there is exactly one parser downstream.
 */

import { TOKEN_PREFIX, decodeToken, looksLikeToken } from './token.js';

/** The format version the bridge plugin writes and reads. */
export const OWN_FORMAT_VERSION = 1;

/** A credential this package refuses to write. */
export class CredentialError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
  }
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Epoch milliseconds from a value that may be seconds or milliseconds.
 *
 * The desktop document has always carried milliseconds here, but a hand-made
 * JSON file may carry seconds, and silently reading 1.79e9 as milliseconds
 * would date the credential to 1970 and look "expired" forever. The same
 * threshold the bridge uses separates the two.
 * @param {unknown} value
 */
function toMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value <= 0) return 0;
  if (value > 0xe8d4a51000) return value;
  return Math.round(value * 1000);
}

/** @param {unknown} value */
function objectOf(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/**
 * Pull a credential out of whatever the caller handed us.
 *
 * Accepted, in order: a transfer token, an own document, a desktop auth
 * document (`{auth, account}`), or a bare credential object. The order
 * matters only in that a token is unambiguous — everything else is decided by
 * the presence of an `accessToken` string.
 *
 * @param {unknown} input
 * @returns {Record<string, unknown>} the credential fields, unvalidated
 */
export function extractCredential(input) {
  if (looksLikeToken(input)) return decodeToken(input);

  let parsed = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) throw new CredentialError('EMPTY', '没有收到凭据内容');
    if (trimmed.startsWith(TOKEN_PREFIX)) return decodeToken(trimmed);
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new CredentialError(
        'NOT_JSON',
        '这段内容既不是传输令牌，也不是 JSON。请粘贴 "wb1." 开头的令牌，或整份 .workbuddy-auth.json',
      );
    }
  }

  const document = objectOf(parsed);
  if (document === undefined) {
    throw new CredentialError('NOT_OBJECT', '凭据必须是一个 JSON 对象');
  }

  // An own document wraps the fields one level down.
  const own = objectOf(document.credential);
  if (own !== undefined && typeof own.accessToken === 'string') return own;

  // A desktop auth document keeps tokens under `auth` and identity under
  // `account`; this is the branch that makes a plain `workbuddy-desktop.info`
  // importable when someone exported it as plaintext.
  const auth = objectOf(document.auth);
  if (auth !== undefined && typeof auth.accessToken === 'string') {
    const account = objectOf(document.account) ?? {};
    return {
      accessToken: auth.accessToken,
      refreshToken: text(auth.refreshToken) ?? '',
      expiresAtMs: toMs(auth.expiresAt) ?? 0,
      refreshExpiresAtMs: toMs(auth.refreshExpiresAt),
      domain: text(auth.domain) ?? '',
      uid: text(account.uid) ?? '',
      enterpriseId: text(account.enterpriseId),
      nickname: text(account.nickname),
    };
  }

  // A bare credential object.
  if (typeof document.accessToken === 'string') return document;

  throw new CredentialError(
    'NO_ACCESS_TOKEN',
    '这份 JSON 里找不到 accessToken。请确认它是 WorkBuddy 的凭据文件（含 auth.accessToken），而不是别的配置',
  );
}

/**
 * Validate and canonicalize a credential into the fields the bridge stores.
 *
 * The output is deliberately narrow: the six fields `parseOwnDocument` reads,
 * plus the two optional ones. Anything else a source document carried is
 * dropped rather than copied — a credential file is the last place to be
 * keeping data nobody reads.
 *
 * @param {Record<string, unknown>} raw
 * @param {{ now?: number }} [options]
 */
export function normalizeCredential(raw, options = {}) {
  const now = options.now ?? Date.now();
  const accessToken = text(raw.accessToken) ?? '';
  if (accessToken === '') {
    throw new CredentialError('NO_ACCESS_TOKEN', '凭据里没有 accessToken');
  }

  const refreshToken = text(raw.refreshToken) ?? '';
  const expiresAtMs = toMs(raw.expiresAtMs) ?? 0;
  const refreshExpiresAtMs = toMs(raw.refreshExpiresAtMs);
  const domain = (text(raw.domain) ?? '').trim();
  const uid = (text(raw.uid) ?? '').trim();
  const enterpriseId = text(raw.enterpriseId);
  const nickname = text(raw.nickname);

  const credential = {
    accessToken,
    refreshToken,
    expiresAtMs,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain,
    uid,
    ...(enterpriseId === undefined || enterpriseId === '' ? {} : { enterpriseId }),
    ...(nickname === undefined || nickname === '' ? {} : { nickname }),
  };

  // A refresh token that has itself expired cannot renew anything, so it must
  // not count towards usability — otherwise an entirely dead credential is
  // accepted and fails later as a confusing 401.
  const refreshExpired = refreshExpiresAtMs !== undefined && refreshExpiresAtMs !== 0 && refreshExpiresAtMs <= now;
  const accessValid = expiresAtMs === 0 || expiresAtMs > now;
  const canRenew = refreshToken !== '' && !refreshExpired;

  return {
    credential,
    /**
     * Whether the credential can be used, or at least renewed, right now.
     * A credential with an expired access token is still worth importing when
     * a refresh token can renew it — the bridge refreshes it on first read.
     */
    usable: accessToken !== '' && (accessValid || canRenew),
    expired: expiresAtMs !== 0 && expiresAtMs <= now,
    refreshExpired,
  };
}

/**
 * The document written to `/root/.dsh/.workbuddy-auth.json`.
 * @param {Record<string, unknown>} credential
 */
export function ownDocument(credential) {
  return { version: OWN_FORMAT_VERSION, credential };
}

/**
 * Describe a credential without exposing it.
 * @param {Record<string, unknown>} credential
 */
export function describeCredential(credential) {
  const accessToken = text(credential.accessToken) ?? '';
  const refreshToken = text(credential.refreshToken) ?? '';
  return {
    accessTokenLength: accessToken.length,
    refreshTokenLength: refreshToken.length,
    domain: text(credential.domain) ?? '',
    uid: text(credential.uid) ?? '',
    nickname: text(credential.nickname),
    enterpriseId: text(credential.enterpriseId),
    expiresAt: msToIso(credential.expiresAtMs),
    refreshExpiresAt: msToIso(credential.refreshExpiresAtMs),
  };
}

/** @param {unknown} value */
function msToIso(value) {
  if (typeof value !== 'number' || value <= 0) return undefined;
  return new Date(value).toISOString();
}
