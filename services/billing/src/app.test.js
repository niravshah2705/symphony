'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the file store BEFORE the store is required: without this the suite
// writes real JSON into the repo's ./data directory.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-app-test-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const store = require('@ai-fleet/shared-core/store');
const { createApp } = require('./app');

const ORG = 'org-test-svc';
const ADMIN = { 'x-ai-fleet-billing-org-id': ORG, 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
const MEMBER = { 'x-ai-fleet-billing-org-id': ORG, 'x-ai-fleet-billing-org-role': 'ORG_MEMBER' };

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
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).service, 'billing');
  } finally {
    await server.close();
  }
});

test('billing standalone UI dashboard serves HTML', async () => {
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /AI Fleet · Billing Control Center/);
  } finally {
    await server.close();
  }
});

// The Firestore store backend throws on any read until initStore() has hydrated
// its mirror, and billing's records are read synchronously inside the handlers —
// so hydration must happen ahead of them. Unhydrated reads are what blanked the
// Cost screen in production.
test('billing routes hydrate the store before reading it; probes do not', async () => {
  const calls = [];
  const server = await listen(createApp({ initStore: async () => { calls.push('init'); } }));
  try {
    await fetch(`${server.url}/healthz`);
    assert.deepEqual(calls, [], 'readiness probes must not depend on the store');

    const summary = await fetch(`${server.url}/api/billing/summary`, { headers: ADMIN });
    assert.equal(summary.status, 200);
    assert.deepEqual(calls, ['init']);

    await fetch(`${server.url}/`);
    assert.equal(calls.length, 2, 'the dashboard reads the store too');
  } finally {
    await server.close();
  }
});

test('a store that will not hydrate fails closed instead of reading stale state', async () => {
  const server = await listen(createApp({
    initStore: async () => { throw new Error('firestore unavailable'); },
  }));
  try {
    const res = await fetch(`${server.url}/api/billing/summary`, { headers: ADMIN });
    assert.equal(res.status, 500);
  } finally {
    await server.close();
  }
});

test('reads scope to the injected org and report isAdmin from the injected role', async () => {
  const server = await listen(createApp());
  try {
    const admin = await (await fetch(`${server.url}/api/billing/summary`, { headers: ADMIN })).json();
    assert.equal(admin.orgId, ORG);
    assert.equal(admin.isAdmin, true);

    const member = await (await fetch(`${server.url}/api/billing/summary`, { headers: MEMBER })).json();
    assert.equal(member.orgId, ORG);
    assert.equal(member.isAdmin, false);
  } finally {
    await server.close();
  }
});

test('a client-controlled org header is ignored without the trusted billing header', async () => {
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/api/billing/summary`, {
      headers: { 'x-ai-fleet-organization-id': 'org-victim' },
    });
    const body = await res.json();
    assert.notEqual(body.orgId, 'org-victim');
    assert.equal(body.isAdmin, false);
  } finally {
    await server.close();
  }
});

test('mutations require the admin role on the trusted header', async () => {
  const server = await listen(createApp());
  try {
    const denied = await fetch(`${server.url}/api/billing/recharge`, {
      method: 'POST',
      headers: { ...MEMBER, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 50 }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'access_denied');

    const allowed = await fetch(`${server.url}/api/billing/recharge`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 50 }),
    });
    assert.equal(allowed.status, 200);
    const account = store.getBillingAccount(ORG);
    assert.ok(Number(account.balancePaise) >= 5000);
  } finally {
    await server.close();
  }
});

test('config update with percentage mode keeps Cashfree mandate fields', async () => {
  const server = await listen(createApp());
  try {
    store.upsertBillingAccount(ORG, {
      autoRecharge: { enabled: true, cashfreeSubscriptionId: 'sub_keep_me', paymentMethodType: 'upi' },
    });
    const res = await fetch(`${server.url}/api/billing/config`, {
      method: 'PUT',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ autoRecharge: { enabled: true, mode: 'percentage', thresholdPercent: 25, amountInr: 1500 } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.autoRecharge.mode, 'percentage');
    assert.equal(body.autoRecharge.thresholdPercent, 25);
    assert.equal(body.autoRecharge.cashfreeSubscriptionId, 'sub_keep_me');
    assert.equal(store.getBillingAccount(ORG).autoRecharge.cashfreeSubscriptionId, 'sub_keep_me');
  } finally {
    await server.close();
  }
});

test('billing /pubsub/billing-tick runs sweep', async () => {
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/pubsub/billing-tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  } finally {
    await server.close();
  }
});

test('cashfree order flow credits the wallet once and stays idempotent', async () => {
  const prevEnv = process.env.CASHFREE_ENV;
  delete process.env.CASHFREE_APP_ID;
  delete process.env.CASHFREE_SECRET_KEY;
  const server = await listen(createApp());
  try {
    const created = await (await fetch(`${server.url}/api/billing/cashfree/create-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 1000 }),
    })).json();
    assert.ok(created.paymentSessionId, 'mock client still returns a session id');
    assert.ok(created.orderId.startsWith(`order_${ORG}_`));

    const verified = await (await fetch(`${server.url}/api/billing/cashfree/verify-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: created.orderId }),
    })).json();
    assert.equal(verified.orderStatus, 'PAID');
    const afterFirst = Number(store.getBillingAccount(ORG).balancePaise);

    const again = await (await fetch(`${server.url}/api/billing/cashfree/verify-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: created.orderId }),
    })).json();
    assert.equal(again.alreadyProcessed, true);
    assert.equal(Number(store.getBillingAccount(ORG).balancePaise), afterFirst);
  } finally {
    await server.close();
    if (prevEnv !== undefined) process.env.CASHFREE_ENV = prevEnv;
  }
});

test('cashfree mandate creation fails closed when Cashfree is not configured', async () => {
  const prevAppId = process.env.CASHFREE_APP_ID;
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  delete process.env.CASHFREE_APP_ID;
  delete process.env.CASHFREE_SECRET_KEY;
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/api/billing/cashfree/create-mandate`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not configured/);
  } finally {
    await server.close();
    if (prevAppId !== undefined) process.env.CASHFREE_APP_ID = prevAppId;
    if (prevKey !== undefined) process.env.CASHFREE_SECRET_KEY = prevKey;
  }
});

test('cashfree webhook rejects a bad signature in production and credits a good one', async () => {
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  const prevEnv = process.env.NODE_ENV;
  const secret = 'wh-secret-for-test';
  process.env.CASHFREE_SECRET_KEY = secret;
  process.env.NODE_ENV = 'production';
  const server = await listen(createApp());
  try {
    const orderId = `order_${ORG}_wh_${Date.now()}`;
    const payload = JSON.stringify({
      type: 'ORDER_PAID_SUCCESS',
      data: { order: { order_id: orderId, order_amount: 250 } },
    });

    const timestamp = new Date().toISOString();
    const bad = await fetch(`${server.url}/api/billing/cashfree/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': crypto.createHmac('sha256', 'wrong').update(`${timestamp}${payload}`).digest('base64'),
      },
      body: payload,
    });
    assert.equal(bad.status, 401);

    const goodTs = new Date().toISOString();
    const good = await fetch(`${server.url}/api/billing/cashfree/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': goodTs,
        'x-webhook-signature': crypto.createHmac('sha256', secret).update(`${goodTs}${payload}`).digest('base64'),
      },
      body: payload,
    });
    assert.equal(good.status, 200);

    const entry = store.listLedgerEntries({ orgId: ORG }).find((e) => e.meta && e.meta.cashfreeOrderId === orderId);
    assert.ok(entry, 'the webhook credited the matching org');
    assert.equal(Number(entry.amountPaise), 25000);

    const replay = await fetch(`${server.url}/api/billing/cashfree/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(replay.status, 401, 'an unsigned replay is rejected before crediting');
    const count = store.listLedgerEntries({ orgId: ORG }).filter((e) => e.meta && e.meta.cashfreeOrderId === orderId).length;
    assert.equal(count, 1, 'replay does not double-credit');
  } finally {
    await server.close();
    if (prevKey !== undefined) process.env.CASHFREE_SECRET_KEY = prevKey; else delete process.env.CASHFREE_SECRET_KEY;
    if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv; else delete process.env.NODE_ENV;
  }
});

// --- hourly auto-recharge tick ------------------------------------------------
// The route is the only thing between a scheduler tick and real money, so its two
// branches are pinned: in the cloud it must LAUNCH the one-shot Job and do nothing
// else; locally (no Job to launch) it must run the entrypoint in-process.
test('billing recharge tick launches the Cloud Run Job instead of sweeping in-request', async () => {
  const launched = [];
  let ranInProcess = 0;
  const server = await listen(createApp({
    rechargeTrigger: {
      isCloudJobEnabled: () => true,
      runRechargeJob: async (params) => {
        launched.push(params);
        return { execution: 'projects/p/locations/r/jobs/billing-auto-recharge/executions/e', job: 'jobs/billing-auto-recharge' };
      },
    },
    runAutoRechargeJob: async () => { ranInProcess += 1; return {}; },
  }));
  try {
    const res = await fetch(`${server.url}/pubsub/billing-recharge-tick`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'launched');
    assert.match(body.execution, /executions\/e$/);
    assert.equal(ranInProcess, 0, 'the cloud path must never charge inside the service');
    assert.equal(launched.length, 1);
  } finally {
    await server.close();
  }
});

test('billing recharge tick runs the sweep in-process when no Job is configured', async () => {
  let jobOptions = null;
  const server = await listen(createApp({
    rechargeTrigger: { isCloudJobEnabled: () => false, runRechargeJob: async () => { throw new Error('must not launch'); } },
    runAutoRechargeJob: async (opts) => {
      jobOptions = opts;
      return { checked: 2, charged: 1, alerted: 1, skipped: 0, dryRun: false };
    },
  }));
  try {
    const res = await fetch(`${server.url}/pubsub/billing-recharge-tick`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: 'completed', checked: 2, charged: 1, alerted: 1, skipped: 0, dryRun: false,
    });
    // The entrypoint exits the process on a fully-failed sweep, so a request handler
    // must hand it a no-op: one bad org cannot kill the serving container.
    assert.equal(typeof jobOptions.exit, 'function');
    jobOptions.exit(1);
  } finally {
    await server.close();
  }
});

test('billing recharge tick reports a launch failure as 500 so the scheduler retries', async () => {
  const server = await listen(createApp({
    rechargeTrigger: {
      isCloudJobEnabled: () => true,
      runRechargeJob: async () => { throw new Error('run.jobs.run denied'); },
    },
  }));
  try {
    const res = await fetch(`${server.url}/pubsub/billing-recharge-tick`, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /run\.jobs\.run denied/);
  } finally {
    await server.close();
  }
});

test('a Cashfree credential rejection surfaces as a typed 502, not an opaque 500', async () => {
  // Regression: with no error handler the express default returned an HTML 500,
  // so Cashfree's 401 authentication_failed reached the browser as an
  // unattributable Internal Server Error.
  const prevAppId = process.env.CASHFREE_APP_ID;
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  const realFetch = global.fetch;
  process.env.CASHFREE_APP_ID = 'TEST_probe_app_id';
  process.env.CASHFREE_SECRET_KEY = 'cfsk_probe_wrong_key';
  global.fetch = async (url, init) => {
    if (String(url).includes('cashfree.com')) {
      return {
        ok: false,
        status: 401,
        json: async () => ({
          message: 'authentication Failed',
          code: 'request_failed',
          type: 'authentication_error',
        }),
      };
    }
    return realFetch(url, init);
  };
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/api/billing/cashfree/create-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    });
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.code, 'cashfree_authentication_failed');
    assert.match(body.error, /rejected the configured API credentials/);
    assert.doesNotMatch(JSON.stringify(body), /cfsk_probe_wrong_key|TEST_probe_app_id/, 'never echoes the key');
  } finally {
    global.fetch = realFetch;
    await server.close();
    if (prevAppId !== undefined) process.env.CASHFREE_APP_ID = prevAppId; else delete process.env.CASHFREE_APP_ID;
    if (prevKey !== undefined) process.env.CASHFREE_SECRET_KEY = prevKey; else delete process.env.CASHFREE_SECRET_KEY;
  }
});
