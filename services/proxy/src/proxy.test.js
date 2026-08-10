'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EGRESS_ROUTES } = require('@ai-fleet/shared/egress');
const { buildUpstreamUrl, buildForwardHeaders, filterResponseHeaders } = require('./proxy');
const credentials = require('./credentials');

test('buildUpstreamUrl appends the path remainder', () => {
  assert.equal(
    buildUpstreamUrl(EGRESS_ROUTES.anthropic, '/v1/messages'),
    'https://api.anthropic.com/v1/messages'
  );
  // Root request (rest '/') hits the upstream base unchanged.
  assert.equal(buildUpstreamUrl(EGRESS_ROUTES.linear, '/'), 'https://api.linear.app/graphql');
  assert.equal(buildUpstreamUrl(EGRESS_ROUTES.openai, '/chat/completions'), 'https://api.openai.com/v1/chat/completions');
});

test('buildForwardHeaders strips inbound auth and retargets Host', () => {
  const out = buildForwardHeaders(
    {
      authorization: 'Bearer egress-proxy-sentinel',
      'x-internal-token': 'secret',
      'x-forwarded-authorization': 'Bearer user',
      cookie: 'session=abc',
      'content-type': 'application/json',
      host: '127.0.0.1:4030',
      'accept-encoding': 'gzip',
    },
    'https://api.anthropic.com/v1/messages',
    { authorization: 'Bearer real-token', 'anthropic-beta': 'oauth-2025-04-20' }
  );
  // Inbound secrets/sentinel are gone; injected credential is present.
  assert.equal(out.authorization, 'Bearer real-token');
  assert.equal(out['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(out['x-internal-token'], undefined);
  assert.equal(out['x-forwarded-authorization'], undefined);
  assert.equal(out.cookie, undefined);
  assert.equal(out['accept-encoding'], undefined);
  // Host is retargeted to the upstream, not the proxy loopback.
  assert.equal(out.host, 'api.anthropic.com');
  assert.equal(out['content-type'], 'application/json');
});

test('filterResponseHeaders drops body-frame + hop-by-hop but keeps content-type', () => {
  const out = filterResponseHeaders(
    new Map([
      ['content-type', 'text/event-stream'],
      ['content-length', '1234'],
      ['content-encoding', 'gzip'],
      ['transfer-encoding', 'chunked'],
      ['x-request-id', 'abc'],
    ])
  );
  assert.equal(out['content-type'], 'text/event-stream');
  assert.equal(out['x-request-id'], 'abc');
  assert.equal(out['content-length'], undefined);
  assert.equal(out['content-encoding'], undefined);
  assert.equal(out['transfer-encoding'], undefined);
});

// --- credential injection ---------------------------------------------------

test('resolveStaticKey: managed value from the settings payload (one path)', () => {
  const key = credentials.resolveStaticKey(
    'githubToken',
    { secrets: { githubToken: { source: 'managed', value: 'ghp_platform' } } }
  );
  assert.equal(key, 'ghp_platform');
});

test('resolveStaticKey: falls back to the platform env only when no payload', () => {
  const env = { GITHUB_TOKEN: 'ghp_env' };
  assert.equal(credentials.resolveStaticKey('githubToken', null, env), 'ghp_env');
});

test('buildInjection: managed static key injects the settings-resolved value (Bearer)', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.githubApi, {
    resolved: { secrets: { githubToken: { source: 'managed', value: 'ghp_managed' } } },
  });
  assert.equal(headers.authorization, 'Bearer ghp_managed');
});

test('buildInjection: customer static key uses the vault plaintext', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.linear, {
    resolved: { secrets: { linearApiKey: { source: 'customer', value: 'lin_customer' } } },
  });
  // Linear uses the raw scheme (no Bearer prefix).
  assert.equal(headers.authorization, 'lin_customer');
});

test('buildInjection: customer-selected but missing key FAILS CLOSED', async () => {
  await assert.rejects(
    () =>
      credentials.buildInjection(EGRESS_ROUTES.githubApi, {
        resolved: { secrets: { githubToken: { source: 'customer', value: null, error: 'missing' } } },
      }),
    (err) => err.name === 'FailClosed' && err.status === 502
  );
});

test('buildInjection: git route builds x-access-token Basic auth', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.git, {
    resolved: { secrets: { githubToken: { source: 'customer', value: 'ghp_c' } } },
  });
  const expected = 'Basic ' + Buffer.from('x-access-token:ghp_c').toString('base64');
  assert.equal(headers.authorization, expected);
});

test('buildInjection: langsmith uses x-api-key scheme', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.langsmith, {
    resolved: { secrets: { langsmithApiKey: { source: 'customer', value: 'ls_c' } } },
  });
  assert.equal(headers['x-api-key'], 'ls_c');
  assert.equal(headers.authorization, undefined);
});

test('buildInjection: native gemini uses x-goog-api-key scheme', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.geminiNative, {
    resolved: { secrets: { geminiApiKey: { source: 'managed', value: 'gm_key' } } },
  });
  assert.equal(headers['x-goog-api-key'], 'gm_key');
  assert.equal(headers.authorization, undefined);
});

test('buildInjection: claude route injects Bearer + anthropic-beta from oauth manager', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.anthropic, {
    oauthManager: {
      getClaudeAuth: async () => ({ accessToken: 'acc', betaHeader: 'oauth-2025-04-20' }),
    },
  });
  assert.equal(headers.authorization, 'Bearer acc');
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('buildInjection: codex chatgpt route injects Bearer + chatgpt-account-id', async () => {
  const headers = await credentials.buildInjection(EGRESS_ROUTES.codex, {
    oauthManager: {
      getCodexAuth: async () => ({ accessToken: 'acc', accountId: 'acct-123' }),
    },
  });
  assert.equal(headers.authorization, 'Bearer acc');
  assert.equal(headers['chatgpt-account-id'], 'acct-123');
});
