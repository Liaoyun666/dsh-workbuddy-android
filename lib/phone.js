/**
 * Taking the login state off the phone that already has it.
 *
 * Until now the only way in was "sign in on a desktop, export a token, carry it
 * over". That is fine for someone who has the desktop app — but the phone app
 * is usually signed in first, and then the desktop step is pure friction.
 *
 * The phone app (`com.tencent.workbuddy.app`, a Flutter build) keeps its token
 * in MMKV under `/data/data/<pkg>/files/mmkv/`. That directory is private, so
 * getting at it needs the DSHA device shell (`/root/dsh-bin/adb-shell`), which
 * runs through root, Shizuku or ADB — whichever the user has granted.
 *
 * The shell refuses to hand back binary: its read commands are `cat`/`head`/
 * `ls`/… and stdout is decoded as text, so a byte-exact copy has to go through
 * the filesystem. Hence the two-step dance, which is also why this cannot be
 * done by `/app/readfile` (256 KiB cap, credential areas refused):
 *
 *   1. `cp <private mmkv file> /storage/emulated/0/Download/DSHA/<name>`
 *   2. read that copy with ordinary `node:fs` and parse it in-process
 *
 * Everything here reports *why* it failed in terms the user can act on: a
 * blocked policy needs a trip to the permission screen, a missing root needs
 * `--su` granted, and no amount of retrying fixes either.
 */

import { readFile } from 'node:fs/promises';
import { parseMmkv, valueMillis, valueText } from './mmkv.js';

/** The app whose login state we are after. */
export const PHONE_PACKAGE = 'com.tencent.workbuddy.app';

/** Where DSHA keeps its own shell wrapper. */
export const DEVICE_SHELL = '/root/dsh-bin/adb-shell';

/** Shared storage scratch space; DSHA's own export route uses the same place. */
export const STAGING_DIR = '/storage/emulated/0/Download/DSHA';

/** Private dirs worth looking in, in order. */
export const MMKV_DIRS = [
  `/data/data/${PHONE_PACKAGE}/files/mmkv`,
  `/data/user/0/${PHONE_PACKAGE}/files/mmkv`,
];

/** Where the app would keep encrypted preferences, if it used them. */
export const SHARED_PREFS_DIRS = [
  `/data/data/${PHONE_PACKAGE}/shared_prefs`,
  `/data/user/0/${PHONE_PACKAGE}/shared_prefs`,
];

/**
 * The keys the app writes, as seen in its Dart AOT image.
 *
 * These are read out of `lib/arm64-v8a/libapp.so` of the shipped APK, not
 * guessed. `workbuddy_user` and `codebuddy_user` hold a JSON blob rather than a
 * bare id, so the uid is pulled out of that (see `uidFrom`). Kept in one table
 * so a future app version only needs this line edited.
 *
 * One thing that is deliberately absent: there is no `workbuddy_uid` key in the
 * app at all, even though "uid" is the natural name for it — it was checked
 * against the binary and does not exist.
 */
export const TOKEN_KEYS = {
  access: ['workbuddy_token', 'codebuddy_token'],
  refresh: ['workbuddy_refresh_token', 'codebuddy_refresh_token'],
  expiresAt: ['workbuddy_token_expire_at', 'codebuddy_token_expire_at'],
  expiresIn: ['workbuddy_original_expires_in'],
  uid: ['workbuddy_user', 'codebuddy_user'],
  enterprise: ['workbuddy_current_enterprise_id'],
  enterpriseName: ['workbuddy_current_enterprise_name'],
};

/** A shell call that could not be made, or that the policy refused. */
export class PhoneError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ detail?: string, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PhoneError';
    this.code = code;
    this.detail = extra.detail;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/**
 * Run one command through the device shell.
 *
 * `execFile`, never `exec`: the argument is a single string the shell wrapper
 * parses itself, and it forbids scripts, pipes and redirection — so there is
 * nothing gained by involving a shell of our own, and one more way to be wrong.
 *
 * @param {string} command
 * @param {{ binary?: string, timeoutMs?: number, runner?: (command: string, options: { binary: string, timeoutMs: number }) => Promise<{ code: number, stdout: string, stderr: string }> }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runShell(command, options = {}) {
  const binary = options.binary ?? DEVICE_SHELL;
  const timeoutMs = options.timeoutMs ?? 25_000;
  if (options.runner !== undefined) return options.runner(command, { binary, timeoutMs });

  let execFile;
  try {
    ({ execFile } = await import('node:child_process'));
  } catch (error) {
    throw new PhoneError('SHELL_UNAVAILABLE', '这个运行环境里没有 child_process，无法调用设备 shell', {
      cause: error,
    });
  }

  return new Promise((resolve) => {
    execFile(
      binary,
      [command],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        if (error !== null && error.code === 'ENOENT') {
          resolve({
            code: 127,
            stdout: '',
            stderr: `ENOENT: 没有 ${binary}`,
          });
          return;
        }
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/**
 * Turn a shell result into the right exception, or nothing at all.
 *
 * The wrapper's contract, from `adb-shell.py`: exit 126 is a policy block, 125
 * is "it may or may not have run", 124 is a connection failure. Those three
 * need completely different advice, so they get different codes.
 *
 * @param {{ code: number, stdout: string, stderr: string }} result
 * @param {string} command
 */
export function describeFailure(result, command) {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code === 0) return undefined;

  if (result.code === 126 || /POLICY_BLOCKED/.test(text)) {
    return new PhoneError(
      'POLICY_BLOCKED',
      '设备 shell 的策略拦住了这条命令。要读应用私有目录，需要先在 DSHA 的设备能力授权页里允许 root（或让 Shizuku 处于运行状态）——重试无效',
      { detail: text },
    );
  }
  if (result.code === 125 || /EXECUTION_UNKNOWN/.test(text)) {
    return new PhoneError(
      'EXECUTION_UNKNOWN',
      '命令是否执行了无法确定。先自己核对一下目标文件是否存在，不要直接重放',
      { detail: text },
    );
  }
  if (result.code === 127 || /^ENOENT/m.test(text)) {
    return new PhoneError(
      'SHELL_MISSING',
      `没有找到设备 shell（${DEVICE_SHELL}）。这个功能只能在 DSHA 里用`,
      { detail: text },
    );
  }
  if (result.code === 124 || /CONNECT_FAIL/.test(text)) {
    return new PhoneError(
      'ADB_UNAVAILABLE',
      '既没有 root 也没有连上 ADB。在 DSHA 的设备能力页授权 root，或用无线调试配对一次',
      { detail: text },
    );
  }
  if (/Permission denied|cannot open|No such file/i.test(text)) {
    return new PhoneError(
      'READ_DENIED',
      `读不到目标路径，多半是权限不够（没有 root 时任何应用都读不到别人的 /data/data）：${text.slice(-200)}`,
      { detail: text },
    );
  }
  return new PhoneError('SHELL_FAILED', `设备 shell 执行失败（退出码 ${result.code}）：${text.slice(-300)}`, {
    detail: text,
  });
}

/**
 * Compose a `cp` from a private path to shared storage.
 *
 * The shell's FILE kind accepts `cp`, and for `cp` it validates only the
 * *sources* (it resolves each through `readlink -f` and refuses just the SMS
 * database) — so reading another app's files this way is allowed once root is
 * granted. The destination must pass `write_allowed`, which is why it goes under
 * `Download/DSHA` rather than somewhere inventively named.
 *
 * @param {string} source
 * @param {string} destination
 */
export function copyCommand(source, destination) {
  for (const [label, path] of [
    ['源', source],
    ['目标', destination],
  ]) {
    if (!path.startsWith('/')) throw new PhoneError('BAD_PATH', `${label}路径必须是绝对路径：${path}`);
    if (path.includes('\0') || path.includes('\n') || path.includes('\r')) {
      throw new PhoneError('BAD_PATH', `${label}路径里不能有换行`);
    }
  }
  return `cp ${quote(source)} ${quote(destination)}`;
}

/**
 * Single-quote a path for the shell wrapper, which splits with `shlex`.
 * @param {string} value
 */
function quote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * List `*.crc`-less MMKV data files under a directory.
 *
 * MMKV writes `<id>` plus `<id>.crc`; the data lives in the file without the
 * extension. `ls -1` output is all we can rely on, so parse defensively.
 *
 * @param {string} output
 */
export function parseListing(output) {
  /** @type {string[]} */
  const names = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    // `ls -1` prints a bare name. `ls -la` prints a permission string, links,
    // owner, group, size, date and the name; only that form is columnar, and
    // its name is the last whitespace run.
    if (/^total\s+\d+$/.test(line)) continue;
    const columnar = /^[bcdlps-][rwxsStT-]{9}/.test(line);
    const name = columnar ? line.slice(line.lastIndexOf(' ') + 1) : line;
    if (name === '' || name === '.' || name === '..') continue;
    if (name.endsWith('.crc') || name.endsWith('.tmp')) continue;
    names.push(name);
  }
  return [...new Set(names)];
}

/**
 * Find the MMKV files for the phone app.
 *
 * @param {{ binary?: string, timeoutMs?: number, runner?: Function, dirs?: string[] }} [options]
 */
export async function findMmkvFiles(options = {}) {
  const dirs = options.dirs ?? MMKV_DIRS;
  /** @type {string[]} */
  const tried = [];

  for (const dir of dirs) {
    tried.push(dir);
    const result = await runShell(`ls -1 ${quote(dir)}`, options);
    if (result.code !== 0) {
      // "No such file" on the first candidate just means this device uses the
      // other plausible layout; keep going instead of failing the whole scan.
      if (/No such file|not found/i.test(`${result.stdout}${result.stderr}`)) continue;
      const failure = describeFailure(result, `ls -1 ${dir}`);
      if (failure !== undefined) throw failure;
      continue;
    }
    const names = parseListing(result.stdout);
    if (names.length > 0) {
      return { dir, files: names.map((name) => `${dir}/${name}`), tried };
    }
  }
  return { dir: '', files: [], tried };
}

/**
 * Copy files out of the private directory into shared storage and read them.
 *
 * @param {{ files: string[], staging?: string, binary?: string, timeoutMs?: number, runner?: Function, fs?: { readFile?: Function, mkdir?: Function, rm?: Function } }} options
 */
export async function pullFiles(options) {
  const staging = options.staging ?? STAGING_DIR;
  const copy = options.copyOut;
  /** @type {Array<{ source: string, local: string, bytes: Buffer }>} */
  const pulled = [];

  for (const [index, source] of options.files.entries()) {
    const name = `workbuddy-mmkv-${index + 1}.bin`;
    const destination = `${staging}/${name}`;

    // Reuse a copy that is already sitting there: a previous attempt may have
    // been interrupted between the copy and the read, and re-copying costs
    // another round trip through the shell.
    const local = await materialize(destination, options);
    if (local !== undefined) {
      pulled.push({ source, local: destination, bytes: local });
      continue;
    }

    if (copy === undefined) {
      const result = await runShell(copyCommand(source, destination), options);
      const failure = describeFailure(result, copyCommand(source, destination));
      if (failure !== undefined) throw failure;
    } else {
      await copy(source, destination);
    }

    const bytes = await materialize(destination, options);
    if (bytes === undefined) {
      throw new PhoneError(
        'COPY_MISSING',
        `复制到 ${destination} 之后读不到这个文件。可能被系统清理了，重试一次`,
      );
    }
    pulled.push({ source, local: destination, bytes });
  }

  return { staging, pulled };
}

/**
 * Read a staged file, or `undefined` if it is not there yet.
 * @param {string} path
 * @param {{ fs?: { readFile?: Function } }} options
 */
async function materialize(path, options) {
  const reader = options.fs?.readFile ?? ((target) => readFile(target));
  try {
    const data = await reader(path);
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  } catch {
    return undefined;
  }
}

/**
 * Pull a user id out of whatever the app stored under its user key.
 *
 * The key is called `workbuddy_user` / `codebuddy_user`, and it holds a JSON
 * blob describing the account, not a bare id — so `{"uid":"..."}` has to be
 * opened up. A bare id is still accepted, because that is what an older build
 * may have written, and an unparsable blob degrades to "no uid" rather than
 * failing the whole capture: the uid is nice to have, the token is the point.
 *
 * @param {string | undefined} text
 * @returns {string}
 */
export function uidFrom(text) {
  if (text === undefined) return '';
  const trimmed = text.trim();
  if (trimmed === '') return '';
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return '';
  }
  if (parsed === null || typeof parsed !== 'object') return '';

  // Depth-first, but only through plain containers: the id can sit at the top
  // level or under a `user` / `data` wrapper, and the first plausible hit wins.
  const names = ['uid', 'userid', 'user_id', 'userId', 'openid', 'open_id', 'openId', 'id'];
  const seen = new Set();
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 3 || seen.has(node)) return '';
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit !== '') return hit;
      }
      return '';
    }
    for (const name of names) {
      const value = node[name];
      if (typeof value === 'string' && value.trim() !== '' && value.trim() !== '0') return value.trim();
      if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return String(value);
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === 'object') {
        const hit = walk(value, depth + 1);
        if (hit !== '') return hit;
      }
    }
    return '';
  };
  return walk(parsed, 0);
}

/**
 * Map parsed MMKV entries onto a credential.
 *
 * Deliberately tolerant: the app has been observed to write both `workbuddy_*`
 * and `codebuddy_*` keys, and a single missing key should degrade the result
 * (no expiry, no uid) rather than fail it.
 *
 * @param {Map<string, ReturnType<typeof valueText>> | Record<string, unknown>} entries
 */
export function credentialFromEntries(entries) {
  const lookup = (names) => {
    for (const name of names) {
      const value = entries instanceof Map ? entries.get(name) : entries[name];
      const text = valueText(value);
      if (text !== undefined && text !== '') return text;
    }
    return undefined;
  };

  const rawAccess = lookup(TOKEN_KEYS.access);
  if (rawAccess === undefined) {
    throw new PhoneError(
      'NO_TOKEN_IN_STORE',
      'MMKV 里没有找到 access token。可能这个应用把登录态放在了加密存储里，或者还没在这台手机上登录',
    );
  }
  // Some builds store "Bearer <jwt>" rather than the bare token.
  const accessToken = rawAccess.replace(/^Bearer\s+/i, '').trim();
  const refreshToken = (lookup(TOKEN_KEYS.refresh) ?? '').replace(/^Bearer\s+/i, '').trim();

  const expiresEntry = TOKEN_KEYS.expiresAt.map((name) =>
    entries instanceof Map ? entries.get(name) : entries[name],
  ).find((value) => value !== undefined);
  const expiresAtMs = valueMillis(expiresEntry);

  const uid = uidFrom(lookup(TOKEN_KEYS.uid));
  const enterpriseId = lookup(TOKEN_KEYS.enterprise) ?? '';

  /** @type {Record<string, unknown>} */
  const credential = { accessToken };
  if (refreshToken !== '') credential.refreshToken = refreshToken;
  if (expiresAtMs !== undefined) credential.expiresAtMs = expiresAtMs;
  if (uid !== '') credential.uid = uid;
  if (enterpriseId !== '' && enterpriseId !== '0') credential.enterpriseId = enterpriseId;
  // The phone talks to the CN deployment; the region only changes when a
  // domain is present, and we cannot see one here.
  credential.domain = '';
  return credential;
}

/**
 * The whole flow: find the files, copy them out, parse, extract.
 *
 * @param {{ binary?: string, timeoutMs?: number, runner?: Function, staging?: string, dirs?: string[], claim?: (paths: string[]) => void, fs?: object }} [options]
 */
export async function captureFromPhone(options = {}) {
  const found = await findMmkvFiles(options);
  if (found.files.length === 0) {
    throw new PhoneError(
      'MMKV_NOT_FOUND',
      `没有找到这个应用的 MMKV 目录（找过 ${found.tried.join('、')}）。可能它还没在这台手机上登录过 WorkBuddy，或者用的是加密存储`,
    );
  }
  // Only the last few files matter: MMKV appends, so the newest file holds the
  // current state, and old ones are leftovers from a migration.
  const chosen = found.files.slice(-3);
  const pulled = await pullFiles({ ...options, files: chosen });
  options.claim?.(pulled.pulled.map((item) => item.local));

  /** @type {Map<string, ReturnType<typeof valueText>>} */
  const merged = new Map();
  /** @type {Array<{ file: string, entries: number, layout: string, complete: boolean }>} */
  const parsedFiles = [];

  for (const item of pulled.pulled) {
    const parsed = parseMmkv(item.bytes);
    parsedFiles.push({
      file: item.local,
      entries: parsed.entries.size,
      layout: parsed.layout,
      complete: parsed.complete,
    });
    for (const [key, value] of parsed.entries) {
      // Later files win: they are the more recent append.
      merged.set(key, value);
    }
  }

  if (merged.size === 0) {
    throw new PhoneError(
      'MMKV_EMPTY',
      'MMKV 文件读到了，但里面一条记录也没解析出来。多半是这个文件被 cryptKey 加密了（MMKV 支持整库加密），本插件解不开',
    );
  }

  const credential = credentialFromEntries(merged);
  return {
    credential,
    packageName: PHONE_PACKAGE,
    directory: found.dir,
    files: parsedFiles,
    keys: [...merged.keys()].sort(),
  };
}
