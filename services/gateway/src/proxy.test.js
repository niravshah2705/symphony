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
