/**
 * Where the credential lands on the phone.
 *
 * `/root/.dsh/.workbuddy-auth.json`, mode 0600 — the same file
 * `dsh-workbuddy-bridge` reads and the same shape it writes. This package
 * does not own that file's lifecycle; it only seeds it, so someone who has not
 * yet signed in anywhere can sign in on a desktop and carry the credential
 * over.
 *
 * Writes are atomic (temp file in the same directory, then rename) and the
 * parent directory is created 0700. A partial credential file that the bridge
 * reads at startup would be worse than no file at all.
 */

import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ownDocument } from './credential.js';

/** The filename the bridge plugin owns. */
export const AUTH_FILENAME = '.workbuddy-auth.json';

/** The env var the bridge lets you point at a different file. */
export const AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE';

/**
 * The DSH home directory.
 *
 * Mirrors what the bridge does: `DSH_HOME` wins, then `~/.dsh`. On DSHA the
 * app runs as root, so `~` is `/root` and the result is `/root/.dsh`.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveDshHome(env = process.env) {
  const configured = (env.DSH_HOME ?? '').trim();
  if (configured !== '') return configured;
  return join(homedir(), '.dsh');
}

/**
 * The credential file path.
 *
 * `WORKBUDDY_AUTH_FILE` is honoured because the bridge honours it: if the user
 * pointed the bridge somewhere else, seeding the default path would write a
 * file nobody reads.
 * @param {{ env?: NodeJS.ProcessEnv, authFile?: string }} [options]
 */
export function resolveAuthPath(options = {}) {
  const explicit = (options.authFile ?? '').trim();
  if (explicit !== '') return explicit;
  const env = options.env ?? process.env;
  const fromEnv = (env[AUTH_FILE_ENV] ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  return join(resolveDshHome(env), AUTH_FILENAME);
}

/**
 * Write the credential document.
 *
 * @param {string} path
 * @param {Record<string, unknown>} credential
 * @param {{ mode?: number, now?: Date }} [options]
 * @returns {Promise<{ path: string, bytes: number, replaced: boolean }>}
 */
export async function writeAuthFile(path, credential, options = {}) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let replaced = false;
  try {
    await stat(path);
    replaced = true;
  } catch {
    replaced = false;
  }

  const body = `${JSON.stringify(ownDocument(credential), null, 2)}\n`;
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(temp, body, { mode: options.mode ?? 0o600 });
    // `writeFile`'s mode is masked by umask, so set it again on the real file
    // after the rename: a credential readable by another process in the same
    // container is exactly what 0600 is for.
    await rename(temp, path);
    await chmod(path, options.mode ?? 0o600);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }

  return { path, bytes: Buffer.byteLength(body), replaced };
}

/**
 * Read back the credential, for `status` and for verifying a write.
 * @param {string} path
 * @returns {Promise<{ exists: boolean, document?: unknown, mode?: number, bytes?: number }>}
 */
export async function readAuthFile(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { exists: false };
  }
  const raw = await readFile(path, 'utf8');
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    document = undefined;
  }
  // On Windows the mode bits are meaningless (always 0666), so report what the
  // file really says and let the caller decide whether to mention it.
  return { exists: true, document, mode: info.mode & 0o777, bytes: info.size };
}

/**
 * Remove the credential file. Only ever called by an explicit `remove`.
 * @param {string} path
 */
export async function removeAuthFile(path) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
    throw error;
  }
}
