'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the JSON store + set deterministic billing config BEFORE config/store load.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-ledger-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.INITIAL_CREDIT_INR = '500';

const store = require('../store');
const ledger = require('./ledger');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('ensureAccount seeds the initial credit once and is idempotent', () => {
  const a = ledger.ensureAccount('org-1');
  assert.equal(a.balancePaise, 50000); // 500 INR
  assert.equal(a.initialCreditPaise, 50000);
  assert.equal(store.listLedgerEntries({ orgId: 'org-1' }).filter((e) => e.type === 'credit').length, 1);
  // Spend it down, then call ensureAccount again — it must NOT re-credit.
  ledger.postEntry('org-1', { type: 'usage', amountPaise: -50000, description: 'spend' });
  const again = ledger.ensureAccount('org-1');
  assert.equal(again.balancePaise, 0);
  assert.equal(store.listLedgerEntries({ orgId: 'org-1' }).filter((e) => e.type === 'credit').length, 1);
});

test('balanceFromLedger is the signed sum of entries; snapshot matches', () => {
  ledger.ensureAccount('org-2');
  ledger.postEntry('org-2', { type: 'usage', amountPaise: -12345, description: 'x' });
  ledger.postEntry('org-2', { type: 'recharge', amountPaise: 20000, description: 'y' });
  const expected = 50000 - 12345 + 20000;
  assert.equal(ledger.balanceFromLedger('org-2'), expected);
  assert.equal(store.getBillingAccount('org-2').balancePaise, expected);
});

test('postEntry rounds amounts to integer paise and never mutates prior entries', () => {
  ledger.ensureAccount('org-3');
  const before = store.listLedgerEntries({ orgId: 'org-3' }).length;
  ledger.postEntry('org-3', { type: 'usage', amountPaise: -10.6, description: 'round' });
  const entries = store.listLedgerEntries({ orgId: 'org-3' });
  assert.equal(entries.length, before + 1);
  assert.equal(entries[0].amountPaise, -11); // Math.round(-10.6)
});

test('refreshBalance recomputes the snapshot from the ledger (self-heals drift)', () => {
  ledger.ensureAccount('org-4');
  // Simulate a stale snapshot, then refresh.
  store.upsertBillingAccount('org-4', { balancePaise: 999999 });
  const healed = ledger.refreshBalance('org-4');
  assert.equal(healed.balancePaise, 50000);
});
