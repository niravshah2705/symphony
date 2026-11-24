'use strict';

/**
 * The token-credit rename is a naming change with a money-shaped blast radius, so
 * it is enforced as two halves of one rule:
 *
 *   a number that becomes a wallet credit is `tokenCredits`;
 *   a number that is a payment or a tax is `paise`.
 *
 * Half the gate would be worthless on its own — a blanket rename that also put a
 * non-currency word on the GST invoice and the card charge would read as a clean
 * sweep and quietly break a tax document. So this file asserts BOTH directions,
 * plus the load-time key migration that lets a store written under the old
 * spelling keep working without touching a byte of data.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeStore } = require('../store');

const REPO = path.resolve(__dirname, '../../../..');
// The migration table's entire job is to spell the legacy names, so it is the one
// file the credit-side scan exempts — and the pair list it declares is asserted
// below to contain no rupee-side key, which is what keeps the exemption honest.
const EXEMPT = new Set(['billing/token-credit-migration.js']);
const SELF = 'token-credit-naming.test.js';
const SCAN_DIRS = ['packages', 'services', 'public', 'scripts', 'deploy'];
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.tf']);

/** Every code file, minus node_modules, coverage output and this gate itself. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'coverage') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!CODE_EXT.has(path.extname(entry.name))) continue;
      if (entry.name === SELF) continue;
      if (EXEMPT.has(`${path.basename(path.dirname(abs))}/${entry.name}`)) continue;
      out.push(abs);
    }
  };
  for (const dir of SCAN_DIRS) {
    const abs = path.join(REPO, dir);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out;
}

const FILES = sourceFiles();
const textOf = (file) => fs.readFileSync(file, 'utf8');
const rel = (file) => path.relative(REPO, file);

// Built by concatenation so this file can never match its own patterns.
const CREDIT_SIDE = [
  'cost', 'notionalCost', 'quantity', 'bonus', 'prepaid', 'promo', 'alertThresholds',
  'threshold', 'lastAlertedThreshold', 'getEffectiveThreshold', 'hourlyRate', 'initialCredit',
  'expected', 'billed', 'gross', 'netSaved', 'comparable', 'customerNotional', 'managed',
  'notional', 'rowAmount', 'rowCredit', 'used', 'usage', 'balance', 'walletBalance',
  'currentBalance', 'remaining', 'queued', 'net', 'actual', 'spend', 'baseline', 'debit',
].map((stem) => `${stem}Paise`);
CREDIT_SIDE.push('paiseFromMeter', 'walletPaiseOf', 'cost_paise', 'PAISE_PER_CREDIT',
  'assertPaise', 'creditsFromPaise', 'paiseToCredits', 'paiseFromCredits',
  'creditsToPaise', 'DEFAULT_ALERT_THRESHOLDS_PAISE', 'MATCH_TOLERANCE_PAISE',
  'PLATFORM_CHARGE_PAISE', 'RATE_PAISE_PER_HOUR', 'billing_alert_thresholds_paise');

test(`naming: no credit-side identifier still says paise (scanned ${FILES.length} files)`, () => {
  const offenders = [];
  for (const file of FILES) {
    const text = textOf(file);
    for (const name of CREDIT_SIDE) {
      const re = new RegExp(`\\b${name}\\b`);
      if (re.test(text)) offenders.push(`${rel(file)}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [], `credit-side money must be spelled tokenCredits:\n${offenders.join('\n')}`);
});

// The rupee side, named on purpose: a GST invoice must state taxable value and
// CGST/SGST in INR, and a card is charged ₹2,360. Renaming these would put a
// unit word nobody can file taxes in onto a legal money document.
const RUPEE_SIDE = [
  ['packages/shared-core/src/billing/gst.js', ['subtotalPaise', 'taxablePaise', 'gstPaise', 'totalPaise']],
  ['services/billing/src/payment-providers.js', ['decimalFromPaise']],
  ['packages/shared-core/src/billing/money-wire.js', ['paiseFromDecimal', 'decimalFromPaise', 'wholePaise']],
  ['packages/shared-core/src/billing/pricing.js', ['paiseToInr']],
  ['services/billing/src/billing-api.js', ['subtotalPaise', 'MAX_RECHARGE_PAISE']],
  ['packages/shared-core/src/store.js', ['subtotalPaise', 'gstPaise', 'totalPaise']],
  ['services/billing/src/recharge-settle.js', ['subtotal_paise', 'gst_paise', 'collected_paise']],
  ['packages/shared-core/src/billing/ledger.js', ['amountPaise']],
];

test('naming: the payment and tax side still says paise', () => {
  for (const [file, names] of RUPEE_SIDE) {
    const text = textOf(path.join(REPO, file));
    for (const name of names) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(text),
        `${file} must keep ${name} — a rupee amount is named for rupees`);
    }
  }
});

test('migration: a legacy store reads with credit keys and rupee keys intact', () => {
  const legacy = {
    usageRecords: [{ id: 'u1', costPaise: 2360, notionalCostPaise: 0 }],
    billingOutbox: [{ id: 'o1', status: 'pending', quantityPaise: 99 }],
    rechargeIntents: [{ id: 'i1', bonusPaise: 1500, subtotalPaise: 200000, gstPaise: 36000, totalPaise: 236000 }],
    billingAccounts: [{
      orgId: 'a',
      initialCreditPaise: 100000,
      alertThresholdsPaise: [10000, 0],
      autoRecharge: { thresholdPaise: 40000, amountPaise: 50000 },
    }],
    actorSessions: [{ id: 's1', hourlyRatePaise: 360 }],
  };
  const store = normalizeStore(structuredClone(legacy));

  assert.deepEqual(Object.keys(store.usageRecords[0]).sort(), ['costTokenCredits', 'id', 'notionalCostTokenCredits']);
  assert.equal(store.usageRecords[0].costTokenCredits, 2360, 'naming, not rescaling: the integer is the number');
  assert.equal(store.billingOutbox[0].quantityTokenCredits, 99,
    'a pending outbox row must resolve its quantity, or a real cost lands `failed` after 12 retries');
  assert.equal(store.billingAccounts[0].autoRecharge.thresholdTokenCredits, 40000);
  assert.equal(store.actorSessions[0].hourlyRateTokenCredits, 360);

  // The same record keeps its rupee fields spelled in rupees — quote money and the
  // charge amount are what the invoice states and what the card is billed.
  assert.deepEqual(
    [store.rechargeIntents[0].subtotalPaise, store.rechargeIntents[0].gstPaise, store.rechargeIntents[0].totalPaise],
    [200000, 36000, 236000],
  );
  assert.equal(store.rechargeIntents[0].bonusTokenCredits, 1500, 'the bonus IS a credit, so it renames');
  assert.equal(store.billingAccounts[0].autoRecharge.amountPaise, 50000, 'the top-up is money charged, so it stays');
});

test('migration: normalizeStore is idempotent, so a re-read never drifts a number', () => {
  const once = normalizeStore({
    usageRecords: [{ id: 'u1', costPaise: 1 }],
    billingAccounts: [{ orgId: 'a', autoRecharge: { thresholdPaise: 2 } }],
  });
  assert.deepEqual(normalizeStore(structuredClone(once)), once);
  assert.ok(!('costPaise' in once.usageRecords[0]));
});

test('migration: the legacy key table names no rupee-side money field', () => {
  const { TOKEN_CREDIT_KEY_MIGRATIONS, TOKEN_CREDIT_NESTED_MIGRATIONS } = require('./token-credit-migration');
  const legacy = [
    ...TOKEN_CREDIT_KEY_MIGRATIONS.map(([from]) => from),
    ...Object.values(TOKEN_CREDIT_NESTED_MIGRATIONS).flat().map(([from]) => from),
  ];
  const rupee = /^\s*(subtotal|taxable|gst|total|collected|amount|unpaidInvoices)Paise\s*$/;
  assert.deepEqual(legacy.filter((k) => rupee.test(k)), [],
    'migrating a rupee key would move tax money into the credit vocabulary');
  assert.ok(legacy.includes('thresholdPaise') && legacy.includes('costPaise'));
});

test('migration: an unmigrated record is returned untouched, not cloned per read', () => {
  const clean = { usageRecords: [{ id: 'u1', costTokenCredits: 5 }] };
  const store = normalizeStore(clean);
  assert.equal(store.usageRecords[0], clean.usageRecords[0],
    'assemble() runs on every read; a record with nothing to rename must not be reallocated');
});
