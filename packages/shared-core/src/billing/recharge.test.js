'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'core-billing-recharge-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.INITIAL_CREDIT_INR = '0';

const store = require('../store');
const ledger = require('./ledger');
const { maybeAutoRecharge } = require('./recharge');

const COOLDOWN_MS = 60 * 60 * 1000;

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

function belowThreshold(orgId, debitPaise) {
  ledger.ensureAccount(orgId);
  ledger.postEntry(orgId, { type: 'usage', amountPaise: -debitPaise, description: 'synthetic debit' });
  store.upsertBillingAccount(orgId, {
    autoRecharge: { enabled: true, mode: 'amount', thresholdPaise: 0, amountPaise: debitPaise, lastRechargedAt: null },
  });
}

// The stamp and the credit are one sequence: the Cashfree charge has already
// been captured by the time they run, so a recharge that credits the wallet but
// does not persist lastRechargedAt re-charges the customer on the next tick.
test('an auto-recharge credits the wallet and persists the cooldown stamp', async () => {
  belowThreshold('org-rc-1', 500);
  const t0 = Date.now();

  const result = await maybeAutoRecharge('org-rc-1', t0);

  assert.ok(result, 'a recharge is returned');
  assert.equal(result.entry.type, 'auto_recharge');
  const account = store.getBillingAccount('org-rc-1');
  assert.equal(account.balancePaise, 0, '-500 debit + 500 credit');
  assert.equal(account.autoRecharge.lastRechargedAt, new Date(t0).toISOString());
});

test('a persistently low balance is not recharged again inside the cooldown', async () => {
  belowThreshold('org-rc-2', 500);
  const t0 = Date.now();
  assert.ok(await maybeAutoRecharge('org-rc-2', t0));

  ledger.postEntry('org-rc-2', { type: 'usage', amountPaise: -1000, description: 'more usage' });
  assert.equal(await maybeAutoRecharge('org-rc-2', t0 + COOLDOWN_MS - 1), null);
  assert.ok(await maybeAutoRecharge('org-rc-2', t0 + COOLDOWN_MS + 1));
});
