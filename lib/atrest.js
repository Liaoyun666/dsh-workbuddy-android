/**
 * Reading a WorkBuddy desktop auth file.
 *
 * On Windows the desktop app keeps `workbuddy-desktop.info` with its tokens
 * encrypted under a key that lives in the Electron app's own storage, not in
 * the OS keychain. That is why the file cannot simply be copied to a phone:
 * the phone has neither the key nor the app that would use it.
 *
 * So the export happens on the desktop (this module, driven by
 * `tools/cli.js export`) and only the *decoded* credential travels. Nothing
 * here runs on Android.
 *
 * The envelope format, established by reading the desktop app's storage:
 *
 *   field   = { $wbEncrypted: 1, envelope: base64(JSON{suite,keyId,nonce,authTag,ciphertext}) }
 *   key     = sha256(atRestSecretKey as UTF-8 text)   // NOT the base64-decoded bytes
 *   keyId   = sha256(key).hex.slice(0, 16)           // must equal envelope.keyId
 *   aad     = "WB-AAD\0" | 01 | LP("WBEV1") | LP("sym-v1") | u32(suite) | LP(keyId) | 02 00 00
 *   cipher  = AES-256-GCM(key, nonce, aad, authTag, ciphertext)
 *
 * The `sha256(text)` detail is not a guess: hashing the decoded bytes instead
 * yields a different keyId (28ad26a8… rather than 9127dea1… on the machine this
 * was developed against), so the two derivations are distinguishable and the
 * envelope says which one is right.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Marker key in the desktop document that flags an encrypted field. */
export const ENCRYPTED_MARKER = '$wbEncrypted';

/** Only suite 1 has ever been observed. */
const SUPPORTED_SUITES = new Set([1]);

const AAD_PREFIX = Buffer.from('WB-AAD\0', 'ascii');
const AAD_FORMAT = 'WBEV1';
const AAD_ALGORITHM = 'sym-v1';

/** A failure the CLI reports verbatim. */
export class AtRestError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'AtRestError';
    this.code = code;
  }
}

/** @param {string} value */
function lengthPrefixed(value) {
  const body = Buffer.from(value, 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** @param {number} value */
function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/**
 * The AES key derived from the desktop app's at-rest secret.
 *
 * The secret is base64, but the app hashes the **text**, not the decoded
 * bytes. Decoding first gives a plausible-looking 32-byte key and a wrong
 * keyId, which then fails as KEY_ID_MISMATCH on every real credential.
 *
 * @param {string} secret base64 text, exactly as `loggerGet()` returns it
 */
export function deriveKey(secret) {
  const text = String(secret ?? '');
  if (text === '') {
    throw new AtRestError('SECRET_EMPTY', '桌面密钥为空，无法解密凭据');
  }
  const key = createHash('sha256').update(text, 'utf8').digest();
  return { key, keyId: createHash('sha256').update(key).digest('hex').slice(0, 16) };
}

/**
 * @param {number} suite
 * @param {string} keyId
 */
export function buildAad(suite, keyId) {
  return Buffer.concat([
    AAD_PREFIX,
    Buffer.from([1]),
    lengthPrefixed(AAD_FORMAT),
    lengthPrefixed(AAD_ALGORITHM),
    uint32(suite),
    lengthPrefixed(keyId),
    Buffer.from([2, 0, 0]),
  ]);
}

/** @param {unknown} value */
export function isEncryptedField(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value[ENCRYPTED_MARKER] !== undefined
  );
}

/**
 * Unwrap `{ $wbEncrypted: 1, envelope }` into its parts.
 *
 * The envelope is a base64 *string* holding JSON. Getting this wrong is the
 * easy mistake — treating it as an object yields `keyId: undefined` and then an
 * opaque `ERR_INVALID_ARG_TYPE` from the cipher.
 * @param {unknown} value
 */
export function parseEnvelope(value) {
  if (!isEncryptedField(value)) {
    throw new AtRestError('NOT_ENCRYPTED', '这个字段不是加密信封');
  }
  const raw = /** @type {Record<string, unknown>} */ (value).envelope;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AtRestError('ENVELOPE_MISSING', '加密信封里没有 envelope 字符串');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new AtRestError('ENVELOPE_CORRUPT', '加密信封不是合法的 base64 JSON');
  }
  const envelope = typeof parsed === 'object' && parsed !== null ? parsed : {};
  const suite = Number(envelope.suite);
  const keyId = typeof envelope.keyId === 'string' ? envelope.keyId : '';
  const nonce = Buffer.from(String(envelope.nonce ?? ''), 'base64');
  const authTag = Buffer.from(String(envelope.authTag ?? ''), 'base64');
  const ciphertext = Buffer.from(String(envelope.ciphertext ?? ''), 'base64');
  if (!Number.isInteger(suite) || keyId === '' || nonce.length === 0 || authTag.length === 0) {
    throw new AtRestError('ENVELOPE_INCOMPLETE', '加密信封缺少 suite/keyId/nonce/authTag');
  }
  return { suite, keyId, nonce, authTag, ciphertext };
}

/**
 * Decrypt one encrypted field.
 *
 * The argument order matters: Node requires `setAAD` before `setAuthTag` for
 * GCM, and reversing them produces an authentication failure that looks like a
 * wrong key.
 * @param {unknown} value
 * @param {{ key: Buffer, keyId: string }} derived
 */
export function decryptField(value, derived) {
  const envelope = parseEnvelope(value);
  if (!SUPPORTED_SUITES.has(envelope.suite)) {
    throw new AtRestError('SUITE_UNSUPPORTED', `不认识的加密套件 suite=${envelope.suite}`);
  }
  if (envelope.keyId !== derived.keyId) {
    throw new AtRestError(
      'KEY_ID_MISMATCH',
      `信封 keyId=${envelope.keyId} 与当前密钥 keyId=${derived.keyId} 不一致：这份凭据不是用这台机器的密钥加密的`,
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', derived.key, envelope.nonce, { authTagLength: 16 });
  decipher.setAAD(buildAad(envelope.suite, envelope.keyId));
  decipher.setAuthTag(envelope.authTag);
  try {
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new AtRestError('DECRYPT_FAILED', '解密失败：密钥不匹配，或凭据文件已损坏');
  }
}

/**
 * Encrypt one field, for the test suite's round trip.
 * Nothing in the product path encrypts — the phone only ever decrypts
 * nothing at all; it receives plaintext and writes it to a 0600 file.
 * @param {string} plaintext
 * @param {{ key: Buffer, keyId: string }} derived
 * @param {{ suite?: number, nonce?: Buffer }} [options]
 */
export function encryptField(plaintext, derived, options = {}) {
  const suite = options.suite ?? 1;
  const nonce = options.nonce ?? randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derived.key, nonce, { authTagLength: 16 });
  cipher.setAAD(buildAad(suite, derived.keyId));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const envelope = {
    suite,
    keyId: derived.keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return { [ENCRYPTED_MARKER]: 1, envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') };
}

/**
 * Decrypt every encrypted field under `auth` and `account`.
 *
 * A field that is already a plain string is passed through: some WorkBuddy
 * builds write plaintext, and an export should work the same either way.
 *
 * @param {Record<string, unknown>} document the parsed `workbuddy-desktop.info`
 * @param {{ key: Buffer, keyId: string } | undefined} derived omit to require plaintext
 * @returns {{ auth: Record<string, unknown>, account: Record<string, unknown> }}
 */
export function openDesktopDocument(document, derived) {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new AtRestError('NOT_OBJECT', '凭据文件不是一个 JSON 对象');
  }
  const rawAuth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document;
  const rawAccount = typeof document.account === 'object' && document.account !== null ? document.account : {};

  const open = (source) => {
    const out = {};
    for (const [name, value] of Object.entries(source)) {
      if (!isEncryptedField(value)) {
        out[name] = value;
        continue;
      }
      if (derived === undefined) {
        throw new AtRestError(
          'NEED_SECRET',
          `字段 ${name} 是加密的，需要桌面密钥才能解开；请在安装了 WorkBuddy 桌面版的机器上导出`,
        );
      }
      out[name] = decryptField(value, derived);
    }
    return out;
  };

  const auth = open(/** @type {Record<string, unknown>} */ (rawAuth));
  if (typeof auth.accessToken !== 'string' || auth.accessToken === '') {
    throw new AtRestError(
      'NO_ACCESS_TOKEN',
      '解密后没有 accessToken：这个文件里没有登录态，请先在 WorkBuddy 桌面版里登录',
    );
  }
  return { auth, account: open(/** @type {Record<string, unknown>} */ (rawAccount)) };
}

/**
 * The credential fields an export needs, from an opened desktop document.
 * @param {{ auth: Record<string, unknown>, account: Record<string, unknown> }} opened
 */
export function credentialFromDesktop(opened) {
  const { auth, account } = opened;
  const out = {
    accessToken: auth.accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    domain: typeof auth.domain === 'string' ? auth.domain : '',
    uid: typeof account.uid === 'string' ? account.uid : '',
  };
  // `expiresAt` and `refreshExpiresAt` are epoch milliseconds in this file.
  // Guessing wrong here dates the credential to 1970, so only copy numbers.
  if (typeof auth.expiresAt === 'number') out.expiresAtMs = auth.expiresAt;
  if (typeof auth.refreshExpiresAt === 'number') out.refreshExpiresAtMs = auth.refreshExpiresAt;
  if (typeof account.enterpriseId === 'string' && account.enterpriseId !== '') {
    out.enterpriseId = account.enterpriseId;
  }
  if (typeof account.nickname === 'string' && account.nickname !== '') {
    out.nickname = account.nickname;
  }
  return out;
}

/**
 * Whether a parsed document needs the desktop secret at all.
 *
 * `accounts` is a collection of account objects rather than a flat field map,
 * so this looks one level deeper inside any value that is itself an object.
 * @param {Record<string, unknown>} document
 */
export function documentIsEncrypted(document) {
  /** @param {unknown} value @param {number} depth */
  const contains = (value, depth) => {
    if (isEncryptedField(value)) return true;
    if (depth <= 0) return false;
    if (typeof value !== 'object' || value === null) return false;
    for (const inner of Object.values(value)) {
      if (contains(inner, depth - 1)) return true;
    }
    return false;
  };
  for (const source of [document.auth, document.account, document.accounts, document.allAccounts]) {
    if (contains(source, 2)) return true;
  }
  return contains(document, 0);
}
