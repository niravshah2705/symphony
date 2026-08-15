'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  SENTINEL_TOKEN,
  EGRESS_ROUTES,
  EGRESS_SECRET_KEYS,
  LLM_GATEWAY_ORG_HEADER,
  egressUrl,
  llmGatewayUpstream,
  matchRoute,
  normalizeProxyBase,
} = require('./egress');

test('egressUrl: explicit override wins over proxy and fallback', () => {
  const url = egressUrl({
    proxyBase: 'http://127.0.0.1:4030',
    prefix: '/anthropic',
    explicit: 'https://custom.example',
    fallback: 'https://api.anthropic.com',
  });
  assert.equal(url, 'https://custom.example');
});

test('egressUrl: proxy base wins over fallback when no explicit', () => {
  assert.equal(
    egressUrl({ proxyBase: 'http://127.0.0.1:4030/', prefix: '/anthropic', fallback: 'https://api.anthropic.com' }),
    'http://127.0.0.1:4030/anthropic'
  );
});

test('egressUrl: fallback used when no proxy and no explicit', () => {
  assert.equal(
    egressUrl({ proxyBase: '', prefix: '/anthropic', fallback: 'https://api.anthropic.com' }),
    'https://api.anthropic.com'
  );
});

test('normalizeProxyBase strips trailing slashes', () => {
  assert.equal(normalizeProxyBase('http://x:4030//'), 'http://x:4030');
});

test('matchRoute: longest-prefix disambiguates /linear vs /linear-mcp', () => {
  assert.equal(matchRoute('/linear').route, EGRESS_ROUTES.linear);
  assert.equal(matchRoute('/linear-mcp').route, EGRESS_ROUTES.linearMcp);
});

test('matchRoute: /github-api and /git/github are distinct', () => {
  assert.equal(matchRoute('/github-api/repos/x/y').route, EGRESS_ROUTES.githubApi);
  assert.equal(matchRoute('/git/github/o/r.git/info/refs').route, EGRESS_ROUTES.git);
});

test('matchRoute: returns path remainder after the prefix', () => {
  assert.equal(matchRoute('/anthropic/v1/messages').rest, '/v1/messages');
  assert.equal(matchRoute('/linear').rest, '/');
});

test('matchRoute: unknown path returns null (no open relay)', () => {
  assert.equal(matchRoute('/evil.example/steal'), null);
  assert.equal(matchRoute('/'), null);
});

test('EGRESS_SECRET_KEYS is the deduped set of static-key routes', () => {
  assert.ok(EGRESS_SECRET_KEYS.includes('githubToken'));
  assert.ok(EGRESS_SECRET_KEYS.includes('linearApiKey'));
  // Deduped: githubToken backs both github-api and github-mcp but appears once.
  assert.equal(EGRESS_SECRET_KEYS.filter((k) => k === 'githubToken').length, 1);
});

test('SENTINEL_TOKEN is a non-empty constant', () => {
  assert.equal(typeof SENTINEL_TOKEN, 'string');
  assert.ok(SENTINEL_TOKEN.length > 0);
});

test('llmGateway route: one /llmgw prefix covers all three gateway surfaces', () => {
  assert.equal(matchRoute('/llmgw/v1/chat/completions').route, EGRESS_ROUTES.llmGateway);
  assert.equal(matchRoute('/llmgw/v1/chat/completions').rest, '/v1/chat/completions');
  assert.equal(matchRoute('/llmgw/v1/messages').rest, '/v1/messages');
  assert.equal(matchRoute('/llmgw/v1/responses').rest, '/v1/responses');
});

test('llmGatewayUpstream: hosted default, env override with trailing slash stripped', () => {
  assert.equal(llmGatewayUpstream({}), 'https://gateway.smith.langchain.com');
  assert.equal(
    llmGatewayUpstream({ LANGSMITH_GATEWAY_URL: 'https://dataplane.example/gateway/' }),
    'https://dataplane.example/gateway'
  );
});

test('llmGateway route uses the dedicated gateway secret, not the tracing key', () => {
  assert.equal(EGRESS_ROUTES.llmGateway.auth, 'llm-gateway');
  assert.equal(EGRESS_ROUTES.llmGateway.secretKey, 'langsmithGatewayApiKey');
  assert.ok(EGRESS_SECRET_KEYS.includes('langsmithGatewayApiKey'));
});

test('LLM_GATEWAY_ORG_HEADER names the per-org policy header', () => {
  assert.equal(LLM_GATEWAY_ORG_HEADER, 'x-fleet-org-id');
});
