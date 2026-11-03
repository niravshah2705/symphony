'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxy } = require('./proxy');

test('gateway proxy authenticates direct internal-service requests with the shared token', async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.INTERNAL_API_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = originalToken;
  });
  process.env.INTERNAL_API_TOKEN = 'gateway-service-token';
  let seen;
  global.fetch = async (url, init) => {
    seen = { url, init };
    return {
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{}',
    };
  };
  const req = {
    method: 'GET',
    originalUrl: '/api/agent/status',
    body: {},
    fleetContext: { organizationId: 'org-1', projectId: 'project-1' },
    get: () => '',
  };
  const res = {
    status() { return this; },
    set() { return this; },
    send() { return this; },
    json() { return this; },
  };

  await createProxy('http://planner.internal')(req, res);

  assert.equal(seen.url, 'http://planner.internal/api/agent/status');
  assert.equal(seen.init.headers['x-internal-token'], 'gateway-service-token');
  assert.equal(seen.init.headers['x-ai-fleet-organization-id'], 'org-1');
  assert.equal(seen.init.headers['x-ai-fleet-project-id'], 'project-1');
});

test('gateway proxy forwards raw bytes and injected headers when asked', async (t) => {
  const originalFetch = global.fetch;
  const originalMode = process.env.MESSAGING_MODE;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.MESSAGING_MODE;
    else process.env.MESSAGING_MODE = originalMode;
  });
  process.env.MESSAGING_MODE = 'direct';
  let seen;
  global.fetch = async (url, init) => {
    seen = { url, init };
    return { status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' };
  };
  // Whitespace distinguishes the signed bytes from a re-serialization.
  const rawBody = '{"amountInr": 100}';
  const req = {
    method: 'POST',
    originalUrl: '/api/billing/cashfree/webhook',
    body: JSON.parse(rawBody),
    rawBody,
    get(name) {
      return {
        'content-type': 'application/json',
        'x-webhook-signature': 'sig-value',
        'x-webhook-timestamp': '2026-11-02T00:00:00Z',
        authorization: 'Bearer browser-token',
      }[String(name).toLowerCase()] || '';
    },
  };
  const res = { status() { return this; }, set() { return this; }, send() { return this; } };

  await createProxy('http://billing.internal', {
    forwardRawBody: true,
    forwardHeaders: ['x-webhook-signature', 'x-webhook-timestamp'],
    injectHeaders: () => ({ 'x-ai-fleet-billing-org-id': 'org-9', 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' }),
  })(req, res);

  assert.equal(seen.init.body, rawBody, 'the exact received bytes are forwarded');
  assert.equal(seen.init.headers['x-ai-fleet-billing-org-id'], 'org-9');
  assert.equal(seen.init.headers['x-ai-fleet-billing-org-role'], 'ORG_ADMIN');
  // The service verifies Cashfree's HMAC, so the signing headers must survive.
  assert.equal(seen.init.headers['x-webhook-signature'], 'sig-value');
  assert.equal(seen.init.headers['x-webhook-timestamp'], '2026-11-02T00:00:00Z');
  assert.equal(seen.init.headers.authorization, undefined, 'no bearer is forwarded without forwardUserAuth');

  await createProxy('http://billing.internal')(req, res);
  assert.equal(seen.init.body, '{"amountInr":100}', 'without the option the body is re-serialized as before');
  assert.equal(seen.init.headers['x-ai-fleet-billing-org-id'], undefined);
  assert.equal(seen.init.headers['x-webhook-signature'], undefined, 'no inbound header is copied by default');
});
