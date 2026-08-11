'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-recharge-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.INITIAL_CREDIT_INR = '0';

const store = require('../store');
const ledger = require('./ledger');
const { maybeAutoRecharge, RECHARGE_COOLDOWN_MS } = require('./recharge');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('does nothing when auto-recharge is disabled', () => {
  ledger.ensureAccount('org-a');
  ledger.postEntry('org-a', { type: 'usage', amountPaise: -100, description: 'x' }); // balance -100
  assert.equal(maybeAutoRecharge('org-a'), null);
});

test('tops up with a recharge credit when enabled and below threshold', () => {
  ledger.ensureAccount('org-b');
  ledger.postEntry('org-b', { type: 'usage', amountPaise: -500, description: 'x' }); // balance -500
  store.upsertBillingAccount('org-b', { autoRecharge: { enabled: true, thresholdPaise: 0, amountPaise: 50000, lastRechargedAt: null } });
  const entry = maybeAutoRecharge('org-b', 1_000_000);
  assert.ok(entry);
  assert.equal(entry.type, 'recharge');
  assert.equal(store.getBillingAccount('org-b').balancePaise, 49500); // -500 + 50000
});

test('respects a cooldown so a persistently-low balance is not recharged every tick', () => {
  ledger.ensureAccount('org-c');
  ledger.postEntry('org-c', { type: 'usage', amountPaise: -500, description: 'x' });
  store.upsertBillingAccount('org-c', { autoRecharge: { enabled: true, thresholdPaise: 0, amountPaise: 10000, lastRechargedAt: null } });
  const t0 = 5_000_000;
  assert.ok(maybeAutoRecharge('org-c', t0)); // first recharge
  // Drain again immediately; within cooldown → no recharge.
  ledger.postEntry('org-c', { type: 'usage', amountPaise: -20000, description: 'y' });
  assert.equal(maybeAutoRecharge('org-c', t0 + RECHARGE_COOLDOWN_MS - 1), null);
  // After the cooldown → recharges again.
  assert.ok(maybeAutoRecharge('org-c', t0 + RECHARGE_COOLDOWN_MS + 1));
});
