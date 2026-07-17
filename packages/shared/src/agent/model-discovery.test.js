'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG } = require('../config');
const { discoverModels, getCachedModel, _test } = require('./model-discovery');
const { createChatModel } = require('./llm');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test.beforeEach(() => {
  _test.resetCacheForTests();
});

test('fallback catalogs are synchronously seeded with current hosted models', async () => {
  const sol = getCachedModel('codex', 'gpt-5.6-sol');
  assert.equal(sol.defaultReasoningEffort, 'xhigh');
  assert.deepEqual(sol.reasoningEfforts.map((item) => item.value), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

  const fable = getCachedModel('claude', 'claude-fable-5');
  assert.equal(fable.contextWindow, 1000000);
  assert.equal(fable.maxOutputTokens, 128000);
  assert.equal(fable.reasoningAdapter, 'anthropic-adaptive');

  const disconnected = await discoverModels('claude', { credentials: null });
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.source, 'fallback');
  assert.equal(disconnected.refreshedAt, null);
  assert.ok(disconnected.models.some((model) => model.id === 'claude-sonnet-5'));
});

test('Codex discovery maps the live account catalog, filters hidden models, and caches it', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    const parsed = new URL(url);
    assert.equal(parsed.pathname.endsWith('/models'), true);
    assert.equal(parsed.searchParams.get('client_version'), CONFIG.OAUTH.clientVersion);
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.headers['chatgpt-account-id'], 'acct_1');
    return jsonResponse({
      models: [
        {
          slug: 'gpt-5.6-sol',
          display_name: 'GPT-5.6-Sol',
          description: 'Live Sol',
          default_reasoning_level: 'xhigh',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Quick' },
            { effort: 'xhigh', description: 'Deep' },
            { effort: 'max', description: 'Maximum' },
            { effort: 'ultra', description: 'Delegates' },
          ],
          visibility: 'list',
          supported_in_api: true,
          priority: 1,
          context_window: 372000,
        },
        {
          slug: 'codex-auto-review',
          display_name: 'Hidden',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium', description: 'Medium' }],
          visibility: 'hide',
          supported_in_api: true,
          priority: 0,
        },
      ],
    });
  };

  const options = {
    credentials: { accessToken: 'token', accountId: 'acct_1' },
    fetchImpl,
    now: Date.UTC(2026, 6, 10),
  };
  const first = await discoverModels('codex', options);
  assert.equal(first.source, 'live');
  assert.equal(first.connected, true);
  assert.equal(first.refreshedAt, '2026-07-10T00:00:00.000Z');
  assert.equal(first.models.length, 1);
  assert.equal(first.models[0].id, 'gpt-5.6-sol');
  assert.equal(first.models[0].contextWindow, 372000);
  assert.equal(first.models[0].maxOutputTokens, 128000);
  assert.deepEqual(first.models[0].reasoningEfforts.map((item) => item.value), ['low', 'xhigh', 'max', 'ultra']);
  assert.equal(first.models[0].reasoningEfforts[3].description, 'Delegates');

  const cached = await discoverModels('codex', options);
  assert.equal(calls, 1);
  assert.deepEqual(cached, first);

  await discoverModels('codex', { ...options, refresh: true });
  assert.equal(calls, 2, 'refresh bypasses the live cache');
  assert.equal(getCachedModel('codex', 'gpt-5.6-sol').source, 'live');
});

test('metered OpenAI discovery merges fallbacks and never exposes Codex ultra effort', async () => {
  const discovered = await discoverModels('codex', {
    backend: 'api',
    credentials: { accessToken: 'api-token' },
    fetchImpl: async (url) => {
      assert.equal(url.endsWith('/models'), true);
      return jsonResponse({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.7' }, { id: 'text-embedding-3-large' }] });
    },
    now: Date.UTC(2026, 6, 10),
  });

  assert.equal(discovered.source, 'live');
  const sol = discovered.models.find((model) => model.id === 'gpt-5.6-sol');
  assert.equal(sol.source, 'live');
  assert.equal(sol.contextWindow, 1050000);
  assert.ok(sol.reasoningEfforts.some((item) => item.value === 'none'));
  assert.ok(discovered.models.every((model) => model.reasoningEfforts.every((item) => item.value !== 'ultra')));
  const unknown = discovered.models.find((model) => model.id === 'gpt-5.7');
  assert.equal(unknown.reasoningAdapter, 'none', 'unknown API models must not inherit invented effort values');
  assert.deepEqual(unknown.reasoningEfforts.map((item) => item.value), ['none']);
  assert.ok(!discovered.models.some((model) => model.id === 'text-embedding-3-large'));
});

test('Claude discovery maps SDK limits and model-specific effort capabilities', async () => {
  let receivedOptions = null;
  const discovered = await discoverModels('claude', {
    credentials: { accessToken: 'claude-token' },
    createAnthropicClient: (options) => {
      receivedOptions = options;
      return {
        models: {
          list: async () => ({
            data: [
              {
                id: 'claude-sonnet-5',
                display_name: 'Claude Sonnet 5',
                max_input_tokens: 1000000,
                max_tokens: 128000,
                capabilities: {
                  effort: {
                    supported: true,
                    low: { supported: true },
                    medium: { supported: true },
                    high: { supported: true },
                    xhigh: { supported: true },
                    max: { supported: true },
                  },
                },
              },
              {
                id: 'claude-haiku-4-5-20251001',
                display_name: 'Claude Haiku 4.5',
                max_input_tokens: 200000,
                max_tokens: 64000,
                capabilities: { effort: { supported: false } },
              },
              {
                id: 'claude-opus-4-5-20251101',
                display_name: 'Claude Opus 4.5',
                max_input_tokens: 200000,
                max_tokens: 64000,
                capabilities: {
                  effort: {
                    supported: true,
                    low: { supported: true },
                    high: { supported: true },
                  },
                  thinking: { types: { adaptive: { supported: false } } },
                },
              },
            ],
          }),
        },
      };
    },
    now: Date.UTC(2026, 6, 10),
  });

  assert.equal(receivedOptions.apiKey, null);
  assert.equal(receivedOptions.authToken, 'claude-token');
  assert.equal(receivedOptions.defaultHeaders['anthropic-beta'], CONFIG.CLAUDE.betaHeader);
  assert.equal(discovered.source, 'live');
  const sonnet = discovered.models[0];
  assert.equal(sonnet.reasoningAdapter, 'anthropic-adaptive');
  assert.deepEqual(sonnet.reasoningEfforts.map((item) => item.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(sonnet.defaultReasoningEffort, 'high');
  const haiku = discovered.models[1];
  assert.equal(haiku.reasoningAdapter, 'none');
  assert.deepEqual(haiku.reasoningEfforts.map((item) => item.value), ['none']);
  const manual = discovered.models[2];
  assert.equal(manual.reasoningAdapter, 'anthropic-effort');
  assert.deepEqual(manual.reasoningEfforts.map((item) => item.value), ['low', 'high']);
});

test('live discovery failures return connected static fallback data', async () => {
  const codex = await discoverModels('codex', {
    credentials: { accessToken: 'token', accountId: 'acct_1' },
    fetchImpl: async () => { throw new Error('offline'); },
    refresh: true,
  });
  assert.equal(codex.connected, true);
  assert.equal(codex.source, 'fallback');
  assert.equal(codex.refreshedAt, null);
  assert.ok(codex.models.some((model) => model.id === 'gpt-5.6-sol'));
});

test('strict discovery surfaces provider failures for agent readiness checks', async () => {
  await assert.rejects(
    () => discoverModels('codex', {
      credentials: { accessToken: 'token', accountId: 'acct_1' },
      fetchImpl: async () => jsonResponse({ error: 'forbidden' }, 403),
      refresh: true,
      strict: true,
    }),
    /HTTP 403/
  );
});

test('ultra is forwarded only by the ChatGPT Codex backend', () => {
  const subscription = createChatModel({
    provider: 'codex',
    backend: 'chatgpt',
    baseUrl: 'http://localhost/codex',
    model: 'gpt-5.6-sol',
    accessToken: 'token',
    accountId: 'acct_1',
    reasoningAdapter: 'openai',
    reasoningEffort: 'ultra',
  });
  assert.deepEqual(subscription.reasoning, { effort: 'ultra' });

  const metered = createChatModel({
    provider: 'codex',
    backend: 'api',
    baseUrl: 'http://localhost/v1',
    model: 'gpt-5.6-sol',
    accessToken: 'token',
    numTokens: 128000,
    reasoningAdapter: 'openai',
    reasoningEffort: 'ultra',
  });
  assert.equal(metered.reasoning, undefined);
});
