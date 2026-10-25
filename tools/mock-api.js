/**
 * A stand-in for the WorkBuddy API, so the tests can exercise the real HTTP
 * code paths without a live credential or a network.
 *
 * It reproduces the behaviours that actually bit us during development, since
 * those are the ones the tests are worth having for:
 *
 *   - `POST /v2/chat/completions` with `stream: false` answers 400 / 11101.
 *   - a refresh response carries no `domain` and a huge `expiresIn`.
 *   - `/v3/config` answers 401 when the bearer token is wrong.
 *   - thinking goes in `delta.reasoning_content`, the answer in `delta.content`.
 */

import { createServer } from 'node:http';

/** The tokens the mock accepts. Anything else is a 401. */
export const VALID_ACCESS_TOKEN = 'access-token-for-tests';
export const VALID_REFRESH_TOKEN = 'refresh-token-for-tests';
export const RENEWED_ACCESS_TOKEN = 'access-token-renewed';
export const RENEWED_REFRESH_TOKEN = 'refresh-token-renewed';

/** The model list the mock's `/v3/config` returns. */
export const MOCK_MODELS = [
  { id: 'default', name: 'Default', vendor: 'tencent', maxInputTokens: 128000, maxOutputTokens: 8192 },
  { id: 'hy4-preview', name: 'Hunyuan 4', vendor: 'tencent', supportsToolCall: true },
];

/**
 * Start the fake service.
 * @param {{
 *   port?: number,
 *   rejectRefresh?: boolean,
 *   expiredRefresh?: boolean,
 *   chatContent?: string,
 *   chatReasoning?: string,
 *   emptyChat?: boolean,
 * }} [options]
 */
export async function startMockApi(options = {}) {
  const state = {
    refreshCalls: 0,
    configCalls: 0,
    chatCalls: 0,
    lastChatBody: /** @type {any} */ (undefined),
    lastRefreshHeaders: /** @type {Record<string, string>} */ ({}),
    lastConfigHeaders: /** @type {Record<string, string>} */ ({}),
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status, body) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(payload);
    };

    if (url.pathname === '/v2/plugin/auth/token/refresh') {
      state.refreshCalls += 1;
      const headers = /** @type {Record<string, string>} */ ({});
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value;
      }
      state.lastRefreshHeaders = headers;
      const provided = headers['x-refresh-token'] ?? '';
      if (options.rejectRefresh === true) {
        send(401, { code: 401, msg: 'refresh token rejected' });
        return;
      }
      if (provided !== VALID_REFRESH_TOKEN && provided !== RENEWED_REFRESH_TOKEN) {
        send(401, { code: 401, msg: 'unknown refresh token' });
        return;
      }
      if (options.expiredRefresh === true) {
        send(403, { code: 403, msg: 'refresh token expired' });
        return;
      }
      // Note: no `domain` in the response — the client must keep its own.
      send(200, {
        code: 0,
        msg: 'OK',
        data: {
          accessToken: RENEWED_ACCESS_TOKEN,
          refreshToken: RENEWED_REFRESH_TOKEN,
          expiresIn: 2419200,
          refreshExpiresIn: 2592000,
          tokenType: 'Bearer',
          scope: 'openid profile offline_access email',
        },
      });
      return;
    }

    if (url.pathname === '/v3/config') {
      state.configCalls += 1;
      const headers = /** @type {Record<string, string>} */ ({});
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value;
      }
      state.lastConfigHeaders = headers;
      const authorization = headers.authorization ?? '';
      if (authorization !== `Bearer ${VALID_ACCESS_TOKEN}` && authorization !== `Bearer ${RENEWED_ACCESS_TOKEN}`) {
        send(401, { code: 401, msg: 'unauthorized' });
        return;
      }
      send(200, {
        code: 0,
        msg: 'OK',
        data: { models: MOCK_MODELS, enterpriseId: '', agents: [], productFeatures: [], productFeaturesConfig: {} },
      });
      return;
    }

    if (url.pathname === '/v2/chat/completions') {
      state.chatCalls += 1;
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', async () => {
        try {
          state.lastChatBody = JSON.parse(body);
        } catch {
          state.lastChatBody = undefined;
        }
        const parsed = state.lastChatBody;
        if (parsed === undefined || parsed.stream !== true) {
          // This is the real service's answer, and the reason the probe streams.
          send(400, {
            code: 11101,
            msg: 'Non-stream chat request is currently not supported',
            displayMsg: '非流式请求暂不支持',
            actions: ['RETRY', 'SUBMIT_FEEDBACK'],
          });
          return;
        }
        const chunks = [];
        const model = 'hy4-preview';
        if (options.emptyChat === true) {
          chunks.push({
            id: 'cmb-1',
            model,
            object: 'chat.completion.chunk',
            created: 1,
            choices: [{ index: 0, delta: { content: '' }, finish_reason: '' }],
            usage: null,
          });
        } else {
          chunks.push({
            id: 'cmb-1',
            model,
            object: 'chat.completion.chunk',
            created: 1,
            choices: [
              {
                index: 0,
                delta: { content: '', reasoning_content: options.chatReasoning ?? '用户只要求两个字，我照做。' },
                finish_reason: '',
              },
            ],
            usage: null,
          });
          chunks.push({
            id: 'cmb-1',
            model,
            object: 'chat.completion.chunk',
            created: 1,
            choices: [
              { index: 0, delta: { content: options.chatContent ?? '收到' }, reasoning_content: null },
            ],
            usage: null,
          });
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for (const chunk of chunks) {
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
          // The real service sends one chunk per flush, so the thinking always
          // arrives in its own read. Writing them together would let a single
          // `reader.read()` see both and hide the bug where a probe stops after
          // the first chunk and reports an empty answer.
          if (chunks.length > 1) await new Promise((resolve) => setTimeout(resolve, 30));
        }
        response.write('data: [DONE]\n\n');
        response.end();
      });
      return;
    }

    send(404, { code: 404, msg: `no route ${url.pathname}` });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
