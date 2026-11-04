'use strict';

/**
 * LIVE Cashfree sandbox end-to-end for the auto-recharge money path.
 *
 * Skipped by `npm test`: it needs real sandbox credentials and makes one real
 * (inert, no-redirect) API call. Run explicitly with:
 *
 *   CASHFREE_SANDBOX_E2E=1 node --test services/billing/src/sandbox-e2e.test.js
 *
 * It creates an ORDER, not a subscription charge: an ON_DEMAND charge needs a
 * mandate that only a real, consenting customer can sign, so no dummy org can
 * have one. What this proves is the part the recharge path depends on and that
 * unit tests cannot — the credentials resolve, the base URL is right, the API
 * version is accepted, and a response comes back in the shape the code parses.
 * Production is refused outright: this file must never move real money.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-sandbox-e2e-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const cashfreeClient = require('@ai-fleet/shared-core/billing/cashfree-client');
const ledger = require('@ai-fleet/shared-core/billing/ledger');
const job = require('./auto-recharge-job');

const DATASET = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'test-data', 'sandbox-recharge.json'), 'utf8'),
);
const ENV = String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
const ENABLED = process.env.CASHFREE_SANDBOX_E2E === '1' && cashfreeClient.isConfigured();
const SKIP = ENABLED ? false
  : `requires CASHFREE_SANDBOX_E2E=1 and CASHFREE_APP_ID / CASHFREE_SECRET_KEY (sandbox keys)`;

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('the sandbox credentials reach Cashfree and return a parseable order', { skip: SKIP }, async () => {
  assert.notEqual(ENV, 'production', 'CASHFREE_ENV must be sandbox for this test');
  assert.match(cashfreeClient.getBaseUrl(), /^https:\/\/sandbox\.cashfree\.com\/pg$/, 'sandbox base URL');

  const spec = DATASET.orgs[0];
  const orderId = `e2e_${spec.orgId.slice(0, 8)}_${crypto.randomUUID().slice(0, 8)}`;
  const order = await cashfreeClient.createOrder({
    orderId,
    orderAmount: spec.account.autoRecharge.amountPaise / 100,
    customerId: `dummy_${spec.orgId.slice(0, 8)}`,
    customerName: spec.name,
    customerEmail: spec.admins[0].email,
    customerPhone: '9999999999',
    orderNote: 'AI Fleet auto-recharge sandbox verification (no payment expected)',
  });

  assert.equal(order.order_id, orderId);
  assert.equal(Number(order.order_amount), 500);
  assert.equal(order.order_status, 'ACTIVE');
  assert.match(String(order.payment_session_id), /^session_/, 'the session id shape the SPA SDK needs');
  assert.ok(Number(order.cf_order_id) > 0, 'Cashfree assigned its own order id');

  // Reading it back is the same GET the job's validation step performs.
  const fetched = await cashfreeClient.getOrder(orderId);
  assert.equal(fetched.order_id, orderId);
  assert.equal(fetched.order_status, 'ACTIVE');
});

test('a dummy org without a signed mandate is validated and NOT charged', { skip: SKIP }, async () => {
  const spec = DATASET.orgs[0];
  ledger.ensureAccount(spec.orgId);
  assert.notEqual(
    job.rechargeBlockers(spec.orgId, { ...spec.account.autoRecharge, cashfreeSubscriptionId: null },
      { cashfreeApi: cashfreeClient }),
    null,
    'no mandate on file must block the charge before any call is made',
  );

  // The dataset's subscription id is a fixture, not a mandate this App ID owns.
  // Cashfree answers 404, which is exactly what the job's gate turns into a
  // skip — the proof that a dummy org can never be charged for real.
  await assert.rejects(
    () => cashfreeClient.getSubscription(spec.account.autoRecharge.cashfreeSubscriptionId),
    /404|not found/i,
    'the fixture mandate must not exist on the sandbox account',
  );
});
