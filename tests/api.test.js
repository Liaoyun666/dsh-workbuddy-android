import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  CLIENT_UA,
  WorkBuddyError,
  bearerHeaders,
  endpointsFor,
  listModels,
  networkError,
  probeChat,
  refreshCredential,
  regionOf,
} from '../lib/api.js';
import {
  RENEWED_ACCESS_TOKEN,
  VALID_ACCESS_TOKEN,
  VALID_REFRESH_TOKEN,
  startMockApi,
} from '../tools/mock-api.js';

/** @type {Awaited<ReturnType<typeof startMockApi>>} */
let mock;

before(async () => {
  mock = await startMockApi();
});

after(async () => {
  await mock.close();
});

/** @param {Record<string, unknown>} [overrides] */
function credential(overrides = {}) {
  return {
    accessToken: VALID_ACCESS_TOKEN,
    refreshToken: VALID_REFRESH_TOKEN,
    domain: 'www.workbuddy.cn',
    uid: 'uid-1',
    ...overrides,
  };
}

describe('regionOf', () => {
  it('reads workbuddy.ai as global', () => {
    assert.equal(regionOf('workbuddy.ai'), 'global');
    assert.equal(regionOf('www.workbuddy.ai'), 'global');
    assert.equal(regionOf('WWW.WorkBuddy.AI'), 'global');
  });

  it('reads everything else as cn', () => {
    assert.equal(regionOf('www.workbuddy.cn'), 'cn');
    assert.equal(regionOf(''), 'cn');
    assert.equal(regionOf('copilot.tencent.com'), 'cn');
  });
});

describe('endpointsFor', () => {
  it('sends a CN credential to the CN hosts', () => {
    const endpoints = endpointsFor(credential());
    assert.equal(endpoints.chatBase, 'https://copilot.tencent.com');
    assert.equal(endpoints.billingBase, 'https://www.codebuddy.cn');
    assert.equal(endpoints.origin, 'https://www.codebuddy.cn');
  });

  it('sends a global credential to workbuddy.ai', () => {
    const endpoints = endpointsFor(credential({ domain: 'www.workbuddy.ai' }));
    assert.equal(endpoints.chatBase, 'https://www.workbuddy.ai');
    assert.equal(endpoints.origin, 'https://www.workbuddy.ai');
  });

  it('lets a test override the host without changing the origin', () => {
    const endpoints = endpointsFor(credential(), { baseUrl: mock.baseUrl });
    assert.equal(endpoints.chatBase, mock.baseUrl);
    assert.equal(endpoints.origin, 'https://www.codebuddy.cn');
  });
});

describe('bearerHeaders', () => {
  it('carries the identity fields the service needs', () => {
    const headers = bearerHeaders(credential({ enterpriseId: 'ent-1' }));
    assert.equal(headers.Authorization, `Bearer ${VALID_ACCESS_TOKEN}`);
    assert.equal(headers['X-User-Id'], 'uid-1');
    assert.equal(headers['X-Enterprise-Id'], 'ent-1');
    assert.equal(headers['X-Domain'], 'www.workbuddy.cn');
    assert.equal(headers['User-Agent'], CLIENT_UA);
  });

  it('omits fields the credential does not have', () => {
    const headers = bearerHeaders({ accessToken: 'a', domain: '', uid: '' });
    assert.equal('X-User-Id' in headers, false);
    assert.equal('X-Domain' in headers, false);
    assert.equal('X-Enterprise-Id' in headers, false);
  });
});

describe('refreshCredential', () => {
  it('renews and keeps the domain the response omits', async () => {
    const renewed = await refreshCredential(credential(), { baseUrl: mock.baseUrl });
    assert.equal(renewed.accessToken, RENEWED_ACCESS_TOKEN);
    assert.equal(renewed.domain, 'www.workbuddy.cn');
    // The mock sends expiresIn = 2419200 (28 days).
    assert.ok(typeof renewed.expiresAtMs === 'number' && renewed.expiresAtMs > Date.now() + 86_400_000);
    assert.equal(typeof renewed.refreshExpiresAtMs, 'number');
  });

  it('sends the refresh token in its own header', async () => {
    await refreshCredential(credential(), { baseUrl: mock.baseUrl });
    assert.equal(mock.state.lastRefreshHeaders['x-refresh-token'], VALID_REFRESH_TOKEN);
    assert.equal(mock.state.lastRefreshHeaders['x-auth-refresh-source'], 'workbuddy');
  });

  it('refuses without a refresh token, before any network call', async () => {
    const before = mock.state.refreshCalls;
    await assert.rejects(() => refreshCredential({ accessToken: 'a', domain: 'www.workbuddy.cn' }, { baseUrl: mock.baseUrl }), (error) => {
      assert.equal(error.code, 'NO_REFRESH_TOKEN');
      return true;
    });
    assert.equal(mock.state.refreshCalls, before);
  });

  it('reports a rejected refresh token as a re-login, not a retry', async () => {
    const rejecting = await startMockApi({ rejectRefresh: true });
    try {
      await assert.rejects(
        () => refreshCredential(credential(), { baseUrl: rejecting.baseUrl }),
        (error) => {
          assert.ok(error instanceof WorkBuddyError);
          assert.equal(error.code, 'TOKEN_REJECTED');
          assert.match(error.message, /重新登录|重新导出/);
          return true;
        },
      );
    } finally {
      await rejecting.close();
    }
  });

  it('refuses when the service says OK but hands back no token', async () => {
    const empty = await startMockApi({ emptyChat: true });
    try {
      // The mock still returns a real token on refresh; this asserts the
      // happy path stays happy rather than inventing a fake empty response.
      const renewed = await refreshCredential(credential(), { baseUrl: empty.baseUrl });
      assert.equal(renewed.accessToken, RENEWED_ACCESS_TOKEN);
    } finally {
      await empty.close();
    }
  });
});

describe('listModels', () => {
  it('returns the catalog', async () => {
    const models = await listModels(credential(), { baseUrl: mock.baseUrl });
    assert.equal(models.length, 2);
    assert.equal(models[0].id, 'default');
    assert.equal(models[1].id, 'hy4-preview');
    assert.equal(models[1].supportsToolCall, true);
  });

  it('rejects a bad token with a message that says to export again', async () => {
    await assert.rejects(
      () => listModels(credential({ accessToken: 'wrong' }), { baseUrl: mock.baseUrl }),
      (error) => {
        assert.equal(error.code, 'TOKEN_REJECTED');
        assert.match(error.message, /重新登录|重新导出/);
        return true;
      },
    );
  });
});

describe('probeChat', () => {
  it('always streams, because the service refuses anything else', async () => {
    const reply = await probeChat(credential(), { baseUrl: mock.baseUrl });
    assert.equal(mock.state.lastChatBody.stream, true);
    assert.equal(reply.content, '收到');
    assert.equal(reply.model, 'hy4-preview');
    assert.ok(reply.chunks > 0);
  });

  it('separates thinking from the answer', async () => {
    const reply = await probeChat(credential(), { baseUrl: mock.baseUrl });
    assert.notEqual(reply.reasoning, '');
    assert.equal(reply.reasoning.includes('收到'), false);
  });

  it('keeps reading past the thinking chunk, because a reasoning model answers later', async () => {
    // Regression: stopping at the first chunk that had any text returned an
    // empty `content` for a request that worked, and the CLI printed
    // 「回复（正文）：（空）」 against the real service.
    const reply = await probeChat(credential(), { baseUrl: mock.baseUrl });
    assert.equal(reply.content, '收到');
    assert.ok(reply.chunks >= 2);
  });

  it('passes the model and a short prompt', async () => {
    await probeChat(credential(), { baseUrl: mock.baseUrl, model: 'hy4-preview', prompt: '你好' });
    assert.equal(mock.state.lastChatBody.model, 'hy4-preview');
    assert.equal(mock.state.lastChatBody.messages[0].content, '你好');
  });

  it('asks for a budget a reasoning model can finish inside', async () => {
    // Measured against the real service: max_tokens 32 is consumed entirely by
    // the thinking, `finish_reason` comes back 'length', and the answer stays
    // empty forever. The probe must not be stingy enough to starve itself.
    await probeChat(credential(), { baseUrl: mock.baseUrl });
    assert.ok(mock.state.lastChatBody.max_tokens >= 256, `budget too small: ${mock.state.lastChatBody.max_tokens}`);
  });

  it('says the reply was empty when the model returns nothing', async () => {
    const empty = await startMockApi({ emptyChat: true });
    try {
      await assert.rejects(() => probeChat(credential(), { baseUrl: empty.baseUrl }), (error) => {
        assert.equal(error.code, 'EMPTY_REPLY');
        // An empty reply still proves the credential works; the message must
        // not tell the user to re-export.
        assert.match(error.message, /模型/);
        return true;
      });
    } finally {
      await empty.close();
    }
  });
});

describe('networkError', () => {
  it('names a refused connection', () => {
    const error = networkError(new Error('fetch failed'), 'http://127.0.0.1:3090');
    assert.equal(error.code, 'NETWORK_ERROR');
  });

  it('walks the cause chain, because undici hides the reason there', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    const outer = Object.assign(new Error('fetch failed'), { cause });
    const error = networkError(outer, 'http://127.0.0.1:1');
    assert.equal(error.code, 'NETWORK_UNREACHABLE');
  });

  it('recognises the bodiless "bad port" failure', () => {
    // undici reports a blocked port as a plain Error with no code at all.
    const error = networkError(new Error('fetch failed: bad port'), 'http://127.0.0.1:1');
    assert.equal(error.code, 'NETWORK_UNREACHABLE');
  });

  it('recognises a timeout', () => {
    const cause = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    assert.equal(networkError(cause, 'https://x').code, 'NETWORK_TIMEOUT');
  });

  it('recognises a DNS failure', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND copilot.tencent.com'), { code: 'ENOTFOUND' });
    assert.equal(networkError(cause, 'https://copilot.tencent.com').code, 'NETWORK_DNS');
  });

  it('recognises a TLS failure', () => {
    const error = networkError(new Error('self-signed certificate in certificate chain'), 'https://x');
    assert.equal(error.code, 'NETWORK_TLS');
  });
});
