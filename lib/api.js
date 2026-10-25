/**
 * The three WorkBuddy calls this package needs, and nothing else.
 *
 * The bridge plugin already speaks the full protocol (chat, catalog, billing,
 * credits). This package only needs enough of it to answer one question after
 * an import: *did the credential I just carried over actually work?* That is a
 * refresh, a model listing, and — when the caller explicitly asks — one tiny
 * streamed completion.
 *
 * Every endpoint here was confirmed against the live service. Two details are
 * easy to get wrong and are load-bearing:
 *
 *   - `POST /v2/chat/completions` rejects `stream: false` with code 11101, so
 *     the probe always streams and stops at the first content chunk.
 *   - the refresh response does not include `domain`; it must be carried over
 *     from the credential being refreshed.
 */

import { Buffer } from 'node:buffer';

/** CN deployments. */
export const CN_CHAT_BASE = 'https://copilot.tencent.com';
export const CN_BILLING_BASE = 'https://www.codebuddy.cn';

/** International deployments (domain ends with workbuddy.ai). */
export const GLOBAL_BASE = 'https://www.workbuddy.ai';

/** The UA the service expects; anything else trips bot handling. */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

const JSON_TIMEOUT_MS = 30000;
const STREAM_TIMEOUT_MS = 60000;

/** A WorkBuddy API failure, carrying the service's own code when it has one. */
export class WorkBuddyError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, serviceCode?: number }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'WorkBuddyError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.serviceCode !== undefined) this.serviceCode = extra.serviceCode;
  }
}

/**
 * `cn` or `global`, from the credential's domain.
 * @param {string} domain
 */
export function regionOf(domain) {
  const normalized = String(domain ?? '').trim().toLowerCase();
  if (normalized === 'workbuddy.ai' || normalized.endsWith('.workbuddy.ai')) return 'global';
  return 'cn';
}

/**
 * @param {Record<string, unknown>} credential
 * @param {{ baseUrl?: string }} [options] `baseUrl` exists for the tests, which
 *   point every call at a local mock; the product never passes it.
 * @returns {{ chatBase: string, billingBase: string, origin: string, region: string }}
 */
export function endpointsFor(credential, options = {}) {
  const region = regionOf(typeof credential.domain === 'string' ? credential.domain : '');
  const global = region === 'global';
  const override = (options.baseUrl ?? '').trim().replace(/\/+$/, '');
  const native = global ? GLOBAL_BASE : CN_CHAT_BASE;
  return {
    region,
    chatBase: override !== '' ? override : native,
    billingBase: override !== '' ? override : global ? GLOBAL_BASE : CN_BILLING_BASE,
    origin: global ? GLOBAL_BASE : CN_BILLING_BASE,
  };
}

/** @param {Record<string, unknown>} credential */
function commonHeaders(credential) {
  const { origin } = endpointsFor(credential);
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': CLIENT_UA,
  };
}

/**
 * Headers for a bearer call. The `X-No-*` variants exist because the service
 * distinguishes "empty" from "absent" and behaves differently on each.
 * @param {Record<string, unknown>} credential
 */
export function bearerHeaders(credential) {
  const headers = { ...commonHeaders(credential) };
  const accessToken = String(credential.accessToken ?? '');
  if (accessToken !== '') headers.Authorization = `Bearer ${accessToken}`;
  const uid = String(credential.uid ?? '');
  if (uid !== '') headers['X-User-Id'] = uid;
  const enterpriseId = String(credential.enterpriseId ?? '');
  if (enterpriseId !== '') headers['X-Enterprise-Id'] = enterpriseId;
  const domain = String(credential.domain ?? '');
  if (domain !== '') headers['X-Domain'] = domain;
  return headers;
}

/** @param {Record<string, unknown>} credential */
function refreshHeaders(credential) {
  const headers = { ...commonHeaders(credential), 'X-Auth-Refresh-Source': 'workbuddy' };
  headers['X-Refresh-Token'] = String(credential.refreshToken ?? '');
  const enterpriseId = String(credential.enterpriseId ?? '');
  if (enterpriseId !== '') headers['X-Enterprise-Id'] = enterpriseId;
  return headers;
}

/**
 * @param {Response} response
 * @returns {Promise<{ code: unknown, msg: unknown, data: unknown }>}
 */
async function readEnvelope(response) {
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkBuddyError(
      'BAD_RESPONSE',
      `WorkBuddy 返回的内容不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`,
      { status: response.status },
    );
  }
  const envelope = typeof parsed === 'object' && parsed !== null ? parsed : {};
  return {
    code: envelope.code,
    msg: typeof envelope.msg === 'string' ? envelope.msg : typeof envelope.message === 'string' ? envelope.message : '',
    data: envelope.data,
  };
}

/**
 * Envelope error → something the user can act on.
 * @param {{ code: unknown, msg: string }} envelope
 * @param {number} status
 */
function envelopeError(envelope, status) {
  if (status === 401 || status === 403 || envelope.code === 401) {
    return new WorkBuddyError(
      'TOKEN_REJECTED',
      '凭据被 WorkBuddy 拒绝了（HTTP ' + status + '）。它多半已经失效：请在电脑上重新登录 WorkBuddy 桌面版，再导出一次',
      { status, serviceCode: typeof envelope.code === 'number' ? envelope.code : undefined },
    );
  }
  const detail = envelope.msg !== '' ? envelope.msg : '没有给出原因';
  return new WorkBuddyError(
    'SERVICE_ERROR',
    `WorkBuddy 返回错误（HTTP ${status}）：${detail}`,
    { status, serviceCode: typeof envelope.code === 'number' ? envelope.code : undefined },
  );
}

/**
 * Renew an access token.
 *
 * The credential's `domain` is preserved because the refresh response omits
 * it; dropping it would silently switch a CN credential to the international
 * endpoints on the next call.
 *
 * @param {Record<string, unknown>} credential
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function refreshCredential(credential, options = {}) {
  const refreshToken = String(credential.refreshToken ?? '');
  if (refreshToken === '') {
    throw new WorkBuddyError(
      'NO_REFRESH_TOKEN',
      '这份凭据没有 refreshToken，无法续期。请重新从桌面版导出（导出内容应包含 refreshToken）',
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const { chatBase } = endpointsFor(credential, options);

  let response;
  try {
    response = await fetchImpl(`${chatBase}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(options.timeoutMs ?? JSON_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError(error, chatBase);
  }

  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) throw envelopeError(envelope, response.status);

  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {};
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
  if (accessToken === '') {
    throw new WorkBuddyError('REFRESH_NO_TOKEN', '续期接口返回成功，但没有给出新的 accessToken；请重新登录桌面版再导出');
  }
  const expiresIn = typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : undefined;
  const refreshExpiresIn =
    typeof data.refreshExpiresIn === 'number' && data.refreshExpiresIn > 0 ? data.refreshExpiresIn : undefined;

  return {
    ...credential,
    accessToken,
    ...(typeof data.refreshToken === 'string' && data.refreshToken !== '' ? { refreshToken: data.refreshToken } : {}),
    ...(expiresIn === undefined ? {} : { expiresAtMs: Date.now() + expiresIn * 1000 }),
    ...(refreshExpiresIn === undefined ? {} : { refreshExpiresAtMs: Date.now() + refreshExpiresIn * 1000 }),
    domain: String(credential.domain ?? ''),
  };
}

/**
 * List the models this credential can use.
 * @param {Record<string, unknown>} credential
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function listModels(credential, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { chatBase } = endpointsFor(credential, options);
  let response;
  try {
    response = await fetchImpl(`${chatBase}/v3/config`, {
      method: 'GET',
      headers: bearerHeaders(credential),
      signal: AbortSignal.timeout(options.timeoutMs ?? JSON_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError(error, chatBase);
  }
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) throw envelopeError(envelope, response.status);

  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {};
  const models = Array.isArray(data.models) ? data.models : [];
  return models.map((model) => {
    const entry = typeof model === 'object' && model !== null ? model : {};
    return {
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      vendor: typeof entry.vendor === 'string' ? entry.vendor : '',
      supportsImages: entry.supportsImages === true,
      supportsToolCall: entry.supportsToolCall === true,
      maxInputTokens: typeof entry.maxInputTokens === 'number' ? entry.maxInputTokens : undefined,
      maxOutputTokens: typeof entry.maxOutputTokens === 'number' ? entry.maxOutputTokens : undefined,
    };
  });
}

/**
 * Send one short prompt and stop at the first text chunk.
 *
 * `stream: false` is not an option — the service answers 11101 — so the probe
 * streams and aborts as soon as it has something. Reporting the reasoning text
 * separately matters: some models put everything in `reasoning_content` and
 * would otherwise look like an empty reply.
 *
 * @param {Record<string, unknown>} credential
 * @param {{ prompt?: string, model?: string, maxTokens?: number, baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function probeChat(credential, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { chatBase } = endpointsFor(credential, options);
  const headers = {
    ...bearerHeaders(credential),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-Product': 'SaaS',
  };

  let response;
  try {
    response = await fetchImpl(`${chatBase}/v2/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model ?? 'default',
        stream: true,
        messages: [{ role: 'user', content: options.prompt ?? '只回复两个字：收到' }],
        max_tokens: options.maxTokens ?? DEFAULT_PROBE_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? STREAM_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError(error, chatBase);
  }

  if (!response.ok) {
    const envelope = await readEnvelope(response);
    const serviceCode = typeof envelope.code === 'number' ? envelope.code : undefined;
    if (serviceCode === 11101) {
      throw new WorkBuddyError('STREAM_REQUIRED', 'WorkBuddy 拒绝非流式请求（11101），这是本插件不该出现的内部状态', {
        status: response.status,
        serviceCode,
      });
    }
    throw envelopeError(envelope, response.status);
  }

  const collected = await readSse(response, options.timeoutMs ?? STREAM_TIMEOUT_MS);
  // An echoed `model` name only proves the request reached a model router. If
  // neither the answer nor the thinking has a single character, the caller
  // should hear that instead of a bare success — but the message says the
  // credential is fine, because it is.
  if (collected.content === '' && collected.reasoning === '') {
    throw new WorkBuddyError('EMPTY_REPLY', 'WorkBuddy 接受了请求，但没有回任何内容；凭据是通的，只是这个模型暂时没答');
  }
  return collected;
}

/** Reading stops here even if the answer never starts; `max_tokens` already caps the spend. */
const MAX_PROBE_CHUNKS = 96;

/**
 * A reasoning model spends tokens thinking before it answers anything, and
 * `max_tokens` covers both. Measured against the real service: 32 tokens ran out
 * inside the reasoning with `finish_reason: 'length'` and a permanently empty
 * answer, 512 got the two-character reply out. The probe is not trying to read
 * a long answer, it is trying not to starve one.
 */
const DEFAULT_PROBE_MAX_TOKENS = 512;

/**
 * Read just enough of an SSE body to prove the credential works.
 * @param {Response} response
 * @param {number} timeoutMs
 */
async function readSse(response, timeoutMs) {
  const body = response.body;
  if (body === null) {
    return { content: '', reasoning: '', model: '', chunks: 0 };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let model = '';
  let chunks = 0;
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        chunks += 1;
        if (typeof chunk.model === 'string' && chunk.model !== '') model = chunk.model;
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        const delta = typeof choice === 'object' && choice !== null ? choice.delta : undefined;
        if (typeof delta === 'object' && delta !== null) {
          if (typeof delta.content === 'string') content += delta.content;
          if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        }
      }
      // Keep reading until the answer itself starts, not merely the thinking:
      // the first chunk of a reasoning model usually carries only
      // `reasoning_content`, and stopping there would report an empty reply
      // for a request that worked perfectly. `max_tokens` caps the spend, and
      // MAX_PROBE_CHUNKS caps the wait.
      if (content !== '' || chunks >= MAX_PROBE_CHUNKS) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return { content: content.trim(), reasoning: reasoning.trim(), model, chunks };
}

/**
 * Turn a transport failure into a message that names the likely cause.
 * `fetch failed` with no detail is what the model would otherwise try to
 * retry, so walk the cause chain.
 * @param {unknown} error
 * @param {string} base
 */
export function networkError(error, base) {
  const codes = [];
  const messages = [];
  let cursor = error;
  for (let depth = 0; depth < 5 && cursor; depth += 1) {
    if (typeof cursor === 'object' && cursor !== null) {
      const item = /** @type {{ code?: unknown, message?: unknown, cause?: unknown }} */ (cursor);
      if (typeof item.code === 'string') codes.push(item.code);
      if (typeof item.message === 'string') messages.push(item.message);
      cursor = item.cause;
    } else {
      break;
    }
  }
  const joined = `${codes.join(' ')} ${messages.join(' ')}`;

  if (/timeout|timed out|aborted due to timeout|ETIMEDOUT/i.test(joined)) {
    return new WorkBuddyError('NETWORK_TIMEOUT', `连接 ${base} 超时：网络不通或被拦截，稍后重试`);
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(joined)) {
    return new WorkBuddyError('NETWORK_DNS', `解析不了 ${base} 的域名：这台设备没有可用的网络或 DNS`);
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|bad port|other side closed/i.test(joined)) {
    return new WorkBuddyError('NETWORK_UNREACHABLE', `连不上 ${base}：网络被中断或服务不可达`);
  }
  if (/certificate|self-signed|SSL|TLS/i.test(joined)) {
    return new WorkBuddyError('NETWORK_TLS', `与 ${base} 的 TLS 握手失败：可能有中间人代理或系统证书有问题`);
  }
  const detail = messages[0] || '未知原因';
  return new WorkBuddyError('NETWORK_ERROR', `请求 ${base} 失败：${detail}`);
}
