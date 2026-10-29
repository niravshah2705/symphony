'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const store = require('@ai-fleet/shared-core/store');
const { createApp } = require('./app');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

test('billing service health probes', async () => {
  const app = createApp();
  const server = await listen(app);
  try {
    const res = await fetch(`${server.url}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'billing');
  } finally {
    await server.close();
  }
});

test('billing standalone UI dashboard serves HTML', async () => {
  const app = createApp();
  const server = await listen(app);
  try {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /AI Fleet · Billing Control Center/);
    assert.match(html, /Configure Auto-Renew Threshold/);
  } finally {
    await server.close();
  }
});

test('billing summary and config update with percentage mode', async () => {
  const app = createApp();
  const server = await listen(app);
  try {
    // Get summary
    const resSummary = await fetch(`${server.url}/api/billing/summary`, {
      headers: { 'x-ai-fleet-organization-id': 'org-test-ui' },
    });
    assert.equal(resSummary.status, 200);
    const summary = await resSummary.json();
    assert.equal(summary.orgId, 'org-test-ui');

    // Update config with percentage mode
    const resConfig = await fetch(`${server.url}/api/billing/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-ai-fleet-organization-id': 'org-test-ui',
      },
      body: JSON.stringify({
        autoRecharge: {
          enabled: true,
          mode: 'percentage',
          thresholdPercent: 25,
          amountInr: 1500,
        },
      }),
    });
    assert.equal(resConfig.status, 200);
    const configResult = await resConfig.json();
    assert.equal(configResult.success, true);
    assert.equal(configResult.autoRecharge.mode, 'percentage');
    assert.equal(configResult.autoRecharge.thresholdPercent, 25);
    assert.equal(configResult.autoRecharge.amountPaise, 150000);
  } finally {
    await server.close();
  }
});

test('billing /pubsub/billing-tick runs sweep', async () => {
  const app = createApp();
  const server = await listen(app);
  try {
    const res = await fetch(`${server.url}/pubsub/billing-tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  } finally {
    await server.close();
  }
});

test('cashfree create and verify mandate mock flow', async () => {
  const app = createApp();
  const server = await listen(app);
  try {
    const createRes = await fetch(`${server.url}/api/billing/cashfree/create-mandate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ai-fleet-organization-id': 'org-cf-test',
      },
      body: JSON.stringify({}),
    });
    assert.equal(createRes.status, 200);
    const createData = await createRes.json();
    assert.ok(createData.subscriptionId);

    const verifyRes = await fetch(`${server.url}/api/billing/cashfree/verify-mandate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ai-fleet-organization-id': 'org-cf-test',
      },
      body: JSON.stringify({ subscriptionId: createData.subscriptionId }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.success, true);
    assert.equal(verifyData.subscriptionId, createData.subscriptionId);
  } finally {
    await server.close();
  }
});
