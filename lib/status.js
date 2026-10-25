/**
 * One place that turns "what is in the file" into "what to do next".
 *
 * Both the CLI and the DSHA tool print this, because the interesting question
 * after an import is never "did the bytes land" — it is "am I signed in, and if
 * not, whose fault is it". Every state below is a distinct thing a user has to
 * do differently, so they are kept distinct instead of collapsing into
 * ok/failed.
 */

import { describeCredential } from './credential.js';
import { readAuthFile, resolveAuthPath } from './store.js';

/** The states a credential file can be in. */
export const STATE = {
  /** No file at all — nothing has been imported. */
  missing: 'missing',
  /** A file exists but is not the shape the bridge reads. */
  unreadable: 'unreadable',
  /** The file holds a credential, but its access token has expired and cannot be renewed. */
  expired: 'expired',
  /** The access token has expired, but a refresh token can renew it. */
  renewable: 'renewable',
  /** There is a valid access token. */
  ready: 'ready',
};

/** How the states read in one line each. */
export const STATE_LABEL = {
  missing: '没有凭据',
  unreadable: '凭据文件读不了',
  expired: '凭据已过期',
  renewable: '可以用，但需要续期',
  ready: '已登录',
};

/** What to do about each state. Written as an instruction, not a description. */
export const STATE_FIX = {
  missing:
    '在安装了 WorkBuddy 桌面版并已登录的电脑上运行 workbuddy-android export，把输出的令牌带过来，本机运行 workbuddy-android import --token <令牌>',
  unreadable:
    '这个文件不是本插件或 dsh-workbuddy-bridge 能读的格式。请删掉它重新 import；如果里面是别的重要数据，先备份',
  expired: 'access token 和 refresh token 都过期了。请在电脑上重新登录 WorkBuddy 桌面版，再导出一次',
  renewable: '不用管，dsh-workbuddy-bridge 读到时会自动续期（前提是这台设备能连上 WorkBuddy）',
  ready: '不需要做什么',
};

/**
 * Inspect the credential file.
 *
 * @param {{ authFile?: string, env?: NodeJS.ProcessEnv, now?: number }} [options]
 * @returns {Promise<{
 *   path: string,
 *   state: string,
 *   label: string,
 *   fix: string,
 *   exists: boolean,
 *   mode?: number,
 *   bytes?: number,
 *   credential?: Record<string, unknown>,
 *   summary?: ReturnType<typeof describeCredential>,
 * }>}
 */
export async function inspectCredential(options = {}) {
  const path = resolveAuthPath(options);
  const now = options.now ?? Date.now();
  const file = await readAuthFile(path);

  const base = { path, label: '', fix: '' };

  if (!file.exists) {
    return { ...base, state: STATE.missing, label: STATE_LABEL.missing, fix: STATE_FIX.missing, exists: false };
  }

  const document = file.document;
  const credential =
    typeof document === 'object' && document !== null && typeof (/** @type {any} */ (document).credential) === 'object'
      ? /** @type {Record<string, unknown>} */ (/** @type {any} */ (document).credential)
      : undefined;
  const version = typeof document === 'object' && document !== null ? /** @type {any} */ (document).version : undefined;

  if (credential === undefined || typeof credential.accessToken !== 'string' || credential.accessToken === '') {
    return {
      ...base,
      state: STATE.unreadable,
      label: STATE_LABEL.unreadable,
      fix: STATE_FIX.unreadable,
      exists: true,
      mode: file.mode,
      bytes: file.bytes,
    };
  }
  if (version !== 1) {
    return {
      ...base,
      state: STATE.unreadable,
      label: STATE_LABEL.unreadable,
      fix: `这个文件的 version 是 ${String(version)}，本插件只认 version 1。请删掉它重新 import`,
      exists: true,
      mode: file.mode,
      bytes: file.bytes,
      credential,
    };
  }

  const expiresAtMs = typeof credential.expiresAtMs === 'number' ? credential.expiresAtMs : 0;
  const refreshToken = typeof credential.refreshToken === 'string' ? credential.refreshToken : '';
  const refreshExpiresAtMs = typeof credential.refreshExpiresAtMs === 'number' ? credential.refreshExpiresAtMs : 0;

  const accessValid = expiresAtMs === 0 || expiresAtMs > now;
  const refreshValid = refreshToken !== '' && (refreshExpiresAtMs === 0 || refreshExpiresAtMs > now);
  const state = accessValid ? STATE.ready : refreshValid ? STATE.renewable : STATE.expired;

  return {
    ...base,
    state,
    label: STATE_LABEL[state],
    fix: STATE_FIX[state],
    exists: true,
    mode: file.mode,
    bytes: file.bytes,
    credential,
    summary: describeCredential(credential),
  };
}

/**
 * Whether the credential file's permissions are tight enough to mention.
 *
 * Only meaningful where permissions mean something: on Windows `stat` reports
 * 0666 for any writable file and the check would always complain.
 * @param {number | undefined} mode
 */
export function modeIsLoose(mode) {
  if (process.platform === 'win32') return false;
  if (mode === undefined) return false;
  return (mode & 0o077) !== 0;
}

/**
 * The one-line human summary of an inspection.
 * @param {Awaited<ReturnType<typeof inspectCredential>>} report
 */
export function formatStatus(report) {
  const lines = [`凭据文件：${report.path}`, `状态：${report.label}（${report.state}）`];
  if (report.exists) {
    const bits = [];
    if (report.bytes !== undefined) bits.push(`${report.bytes} 字节`);
    if (report.mode !== undefined && process.platform !== 'win32') bits.push(`权限 ${report.mode.toString(8)}`);
    if (bits.length > 0) lines.push(`文件：${bits.join('，')}`);
    if (modeIsLoose(report.mode)) lines.push('⚠️ 这个文件的权限太宽：同一个容器里的其它进程能读到凭据，建议 chmod 600');
  }
  if (report.summary) {
    const summary = /** @type {NonNullable<typeof report.summary>} */ (report.summary);
    const identity = summary.nickname || summary.uid || '（没有身份信息）';
    lines.push(`身份：${identity}`);
    if (summary.domain !== '') lines.push(`域：${summary.domain}`);
    if (summary.accessTokenLength > 0) lines.push(`access token：${summary.accessTokenLength} 字符`);
    if (summary.refreshTokenLength > 0) lines.push(`refresh token：${summary.refreshTokenLength} 字符`);
    if (summary.expiresAt !== undefined) lines.push(`access token 到期：${summary.expiresAt}`);
    if (summary.refreshExpiresAt !== undefined) lines.push(`refresh token 到期：${summary.refreshExpiresAt}`);
  }
  lines.push(`建议：${report.fix}`);
  return lines.join('\n');
}
