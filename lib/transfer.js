/**
 * The two halves of the move: export on the desktop, import on the phone.
 *
 * They live together because they are one idea — a credential that crosses
 * machines — and because the export half decides what the import half has to
 * accept. Export produces a plain credential object; import accepts that
 * object, a transfer token, or a whole desktop document, then writes one
 * canonical file.
 */

import { readFile } from 'node:fs/promises';
import {
  credentialFromDesktop,
  deriveKey,
  documentIsEncrypted,
  openDesktopDocument,
} from './atrest.js';
import { CredentialError, extractCredential, normalizeCredential } from './credential.js';
import { readDesktopSecret } from './desktop-key.js';
import { encodeToken } from './token.js';
import { resolveAuthPath, writeAuthFile } from './store.js';

/** Where the desktop app keeps its auth file, per platform. */
export const DESKTOP_AUTH_RELATIVE = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'];

/**
 * The desktop auth file candidates, in the order the desktop app would use.
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, platform?: string }} [options]
 */
export function desktopAuthCandidates(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? '';
  const suffix = DESKTOP_AUTH_RELATIVE.join('/');

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || `${home}\\AppData\\Local`;
    const roaming = env.APPDATA || `${home}\\AppData\\Roaming`;
    return [`${local}\\${suffix.replace(/\//g, '\\')}`, `${roaming}\\${suffix.replace(/\//g, '\\')}`];
  }
  if (platform === 'darwin') {
    return [`${home}/Library/Application Support/${suffix}`];
  }
  // Linux, which on Android means: the desktop app has never run here. The
  // XDG paths are still worth listing so a hand-placed file is found.
  const config = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : `${home}/.config`;
  const data = env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith('/') ? env.XDG_DATA_HOME : `${home}/.local/share`;
  return [`${config}/${suffix}`, `${data}/${suffix}`];
}

/**
 * Read the first desktop auth file that exists.
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, platform?: string, desktopPath?: string }} [options]
 */
export async function findDesktopAuthFile(options = {}) {
  const explicit = (options.desktopPath ?? '').trim();
  const candidates = explicit !== '' ? [explicit] : desktopAuthCandidates(options);
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      return { path, raw };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw new CredentialError('DESKTOP_UNREADABLE', `读不了桌面凭据文件 ${path}：${/** @type {Error} */ (error).message}`);
    }
  }
  throw new CredentialError(
    'DESKTOP_NOT_FOUND',
    explicit !== ''
      ? `指定的文件不存在：${explicit}`
      : '没找到 WorkBuddy 桌面版的凭据文件。请先在 WorkBuddy 桌面版登录，或用 --file 指定一份凭据文件',
  );
}

/**
 * The whole desktop side: read the auth file, decrypt what needs decrypting,
 * hand back a credential and a transfer token.
 *
 * `withToken: false` is for the case where the caller wants the JSON (to pipe
 * somewhere) rather than the line of text.
 *
 * @param {{
 *   desktopPath?: string,
 *   electronPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   platform?: string,
 *   now?: number,
 *   withToken?: boolean,
 *   runProbe?: (request: { binary: string, script: string, env: NodeJS.ProcessEnv, timeoutMs: number }) => Promise<string>,
 * }} [options]
 */
export async function exportCredential(options = {}) {
  const { path, raw } = await findDesktopAuthFile(options);

  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new CredentialError('DESKTOP_NOT_JSON', `${path} 不是 JSON：这个文件可能已经损坏`);
  }

  // Only ask the desktop app for its key when the file actually needs it.
  // Starting a GUI binary to read a plaintext file would be rude, and on a
  // machine without the app it would fail for no reason.
  let opened;
  if (documentIsEncrypted(document)) {
    const secret = await readDesktopSecret({
      electronPath: options.electronPath,
      env: options.env,
      runProbe: options.runProbe,
    });
    opened = openDesktopDocument(document, deriveKey(secret.secret));
  } else {
    opened = openDesktopDocument(document, undefined);
  }

  const rawCredential = credentialFromDesktop(opened);
  const normalized = normalizeCredential(rawCredential, { now: options.now });
  if (!normalized.usable) {
    throw new CredentialError(
      'UNUSABLE',
      normalized.refreshExpired
        ? '这份凭据的 access token 和 refresh token 都过期了。请先在 WorkBuddy 桌面版重新登录，再导出'
        : '这份凭据不能用：既没有有效的 access token，也没有可用的 refresh token。请重新登录桌面版',
    );
  }

  return {
    source: path,
    credential: normalized.credential,
    expired: normalized.expired,
    refreshExpired: normalized.refreshExpired,
    token: options.withToken === false ? undefined : encodeToken(normalized.credential),
  };
}

/**
 * The phone side: accept whatever text came in, write the canonical file.
 *
 * @param {{
 *   input?: unknown,
 *   authFile?: string,
 *   env?: NodeJS.ProcessEnv,
 *   now?: number,
 * }} [options]
 */
export async function importCredential(options = {}) {
  if (options.input === undefined || options.input === null) {
    throw new CredentialError('NO_INPUT', '没有收到要导入的内容：用 --token <令牌> 或 --file <文件>');
  }
  const extracted = extractCredential(options.input);
  const normalized = normalizeCredential(extracted, { now: options.now });
  if (!normalized.usable) {
    throw new CredentialError(
      'UNUSABLE',
      normalized.refreshExpired
        ? '这份凭据的 access token 与 refresh token 都已过期。请在电脑上重新登录 WorkBuddy 桌面版后重新导出'
        : '这份凭据没有有效的 access token，也没有可用的 refresh token。请在电脑上重新导出',
    );
  }

  const written = await writeAuthFile(resolveAuthPath({ authFile: options.authFile, env: options.env }), normalized.credential);
  return {
    ...written,
    credential: normalized.credential,
    expired: normalized.expired,
    refreshExpired: normalized.refreshExpired,
  };
}
