'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-gate-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.BILLING_SWEEP_ENABLED = 'true';
process.env.INITIAL_CREDIT_INR = '500';
process.env.FLEET_ORG_ID = 'org-gate';

const store = require('../store');
const ledger = require('./ledger');
const { billingStatus, isBillingBlocked } = require('./gate');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('no account yet → not blocked (first sweep seeds credit)', () => {
  assert.equal(isBillingBlocked({}), false);
  assert.equal(billingStatus({}).orgId, 'org-gate');
});

test('positive balance → not blocked; negative balance → blocked with a reason', () => {
  ledger.ensureAccount('org-gate');
  assert.equal(isBillingBlocked({}), false);
  ledger.postEntry('org-gate', { type: 'usage', amountPaise: -60000, description: 'drain past zero' });
  const status = billingStatus({});
  assert.equal(status.blocked, true);
  assert.match(status.reason, /balance/i);
});

test('gateEnabled:false opts out of the pause even when negative', () => {
  store.upsertBillingAccount('org-gate', { gateEnabled: false });
  assert.equal(isBillingBlocked({}), false);
  store.upsertBillingAccount('org-gate', { gateEnabled: true });
  assert.equal(isBillingBlocked({}), true);
});
