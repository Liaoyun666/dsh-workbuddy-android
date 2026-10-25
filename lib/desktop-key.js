/**
 * Getting the WorkBuddy desktop at-rest secret, on the machine that has the
 * desktop app.
 *
 * The key is not in the OS keychain and not in the auth file: it lives inside
 * the Electron app's own storage, reachable only by asking the app. The app
 * exposes it through a binding (`electron_browser_workbuddy_storage`) that
 * returns a JSON blob including `atRestSecretKey`.
 *
 * Asking means starting the binary in "run as node" mode with a one-line
 * script, which is why every failure here has to say what to do next: this
 * code path only ever runs on a desktop, and only when the user asked to
 * export.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AtRestError } from './atrest.js';

/** How long the desktop binary may take to answer. */
const PROBE_TIMEOUT_MS = 30000;

/** What we ask the app for. Prints the raw blob and nothing else. */
const PROBE_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

/**
 * Where the desktop app usually is, per platform.
 * Only a hint: `--electron` and `WORKBUDDY_ELECTRON_BIN` override it.
 */
export function defaultElectronCandidates(env = process.env) {
  const home = homedir();
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
    return [
      join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
      join(local, 'WorkBuddy', 'WorkBuddy.exe'),
      join(roaming, 'WorkBuddy', 'WorkBuddy.exe'),
      'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
      'C:\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy',
      join(home, 'Applications', 'WorkBuddy.app', 'Contents', 'MacOS', 'WorkBuddy'),
    ];
  }
  // Linux desktops are not a target of the desktop app, but a wrapper may be.
  return ['/opt/WorkBuddy/workbuddy', '/usr/bin/workbuddy'];
}

/**
 * Find the desktop binary.
 * @param {{ electronPath?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function resolveElectronPath(options = {}) {
  const env = options.env ?? process.env;
  const explicit = options.electronPath || env.WORKBUDDY_ELECTRON_BIN || '';
  if (explicit !== '') {
    if (!existsSync(explicit)) {
      throw new AtRestError(
        'ELECTRON_NOT_FOUND',
        `指定的 WorkBuddy 程序不存在：${explicit}。请用 --electron 指向真实的 WorkBuddy 可执行文件`,
      );
    }
    return explicit;
  }
  const candidates = defaultElectronCandidates(env);
  const found = candidates.filter((path) => existsSync(path));
  if (found.length === 0) {
    // A portable copy (or an install on another drive) is outside every guess,
    // so show what was checked: "not found" alone leaves the user to search
    // their own disk for a path this message already knows it needs.
    throw new AtRestError(
      'ELECTRON_NOT_FOUND',
      `没找到 WorkBuddy 桌面版。查过：${candidates.join('、')}。` +
        '如果你装在其他位置（绿色版/其他盘），请用 --electron <路径> 指定，或设 WORKBUDDY_ELECTRON_BIN',
    );
  }
  return found[0];
}

/**
 * Actually start the desktop binary and capture its stdout.
 * @param {{ binary: string, script: string, env: NodeJS.ProcessEnv, timeoutMs: number }} request
 */
function probeBinary({ binary, script, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['-e', script],
      { encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, out) => {
        if (error) {
          // A running instance holds a single-instance lock, and the binary
          // then refuses to run as node — which is the most likely failure
          // here, so say so instead of surfacing a spawn error code.
          reject(
            new AtRestError(
              'ELECTRON_PROBE_FAILED',
              `无法从 WorkBuddy 桌面版读取密钥（${error.message.trim() || error.code || '未知原因'}）。请先完全退出 WorkBuddy 桌面版（包括托盘图标）后再试`,
            ),
          );
          return;
        }
        resolve(out);
      },
    );
  });
}

/**
 * Run the binary and read its at-rest secret.
 *
 * `runProbe` exists so the callers in tests can supply the answer without an
 * Electron binary: everything below it — parsing, key derivation, decryption —
 * is the part worth testing, and it should not need a 200 MB GUI app to run.
 *
 * @param {{
 *   electronPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   runProbe?: (request: { binary: string, script: string, env: NodeJS.ProcessEnv, timeoutMs: number }) => Promise<string>,
 * }} [options]
 * @returns {Promise<{ secret: string, publicKey?: unknown, version: number }>}
 */
export async function readDesktopSecret(options = {}) {
  const binary = resolveElectronPath(options);
  const env = { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' };
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  const stdout = await (options.runProbe ?? probeBinary)({ binary, script: PROBE_SCRIPT, env, timeoutMs });

  const trimmed = String(stdout ?? '').trim();
  if (trimmed === '') {
    throw new AtRestError('SECRET_EMPTY', 'WorkBuddy 桌面版没有返回密钥：请确认它已启动过一次并保持登录');
  }

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    throw new AtRestError('SECRET_UNREADABLE', 'WorkBuddy 桌面版返回的内容不是 JSON，可能是版本不兼容');
  }

  const secret = typeof payload === 'object' && payload !== null ? payload.atRestSecretKey : undefined;
  if (typeof secret !== 'string' || secret === '') {
    throw new AtRestError(
      'SECRET_MISSING',
      'WorkBuddy 桌面版没有给出 atRestSecretKey：这个版本可能不再用本地密钥加密凭据',
    );
  }
  return { secret, publicKey: payload.atRestDeveloperPublicKey, version: Number(payload.version) || 0 };
}
