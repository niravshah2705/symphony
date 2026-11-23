'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-usage-'));
process.env.SOFTWARE_FACTORY_DATA_DIR = TMP_DIR;
process.env.FLEET_ORG_ID = 'org-usage';

const store = require('../store');
const { recordUsage, resolveBillingSource } = require('./usage');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

// Hand figures from deploy/billing/credit-rates.yaml: the claude rows are ₹261 per 1M
// input and ₹1,305 per 1M output tokens, so 1k in + 1k out is ₹1.566 = 157 token
// credits, rounded once at the credit boundary. `costUsd` on these fixtures is
// deliberately a number that does NOT match the debit — it is provenance now, and if it
// ever priced a run again, every expectation below fails.
const ONE_K = { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 };

test('recordUsage persists one record tagged with the deployment org + attribution', () => {
  const rec = recordUsage(
    { projectId: 'p1', projectName: 'Proj', userId: 'u1', taskId: 't1', taskIdentifier: 'ENG-1', source: 'coder' },
    { usage: ONE_K, costUsd: 0.03 },
    { provider: 'claude', model: 'c-1' },
  );
  assert.ok(rec);
  assert.equal(rec.orgId, 'org-usage');
  assert.equal(rec.projectName, 'Proj');
  assert.equal(rec.taskIdentifier, 'ENG-1');
  assert.equal(rec.provider, 'claude');
  assert.equal(rec.costTokenCredits, 157);
  assert.equal(store.listUsageRecords({ orgId: 'org-usage' }).length, 1);
});

test('the record states the money, the rate and the provider figure it was recorded beside', () => {
  // Provenance for the event and for a dispute: what the SDK said, in what currency, at
  // what rate the card was stamped, and the rupee value of the debit. None of it is ever
  // read back to compute money (balance-authority.test.js holds that line).
  const rec = recordUsage(
    { projectId: 'p-prov', source: 'coder' },
    { usage: { inputTokens: 100000, outputTokens: 20000, totalTokens: 120000 }, costUsd: 0.1, costCurrency: 'USD' },
    { provider: 'claude', model: 'claude-sonnet-5' },
  );
  assert.equal(rec.costTokenCredits, 5220, '₹52.20 at the card, not $0.10 at an FX rate');
  assert.equal(rec.inrCost, '52.20');
  assert.equal(rec.fxRateToInr, '87.00');
  assert.equal(rec.providerCost, '0.1');
  assert.equal(rec.providerCurrency, 'USD');
  assert.equal(rec.rateMatch, 'Card', 'the model itself is priced, not its provider blend');
  assert.equal(rec.priceMatch, 'Exact');
  assert.deepEqual(rec.usage, {
    inputTokens: 100000, outputTokens: 20000, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 120000, reasoningOutputTokens: 0,
  });
});

test('recordUsage skips empty runs (no tokens) to avoid ledger noise', () => {
  const before = store.listUsageRecords().length;
  const rec = recordUsage({ source: 'planner' }, { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, costUsd: 0 }, { provider: 'ollama' });
  assert.equal(rec, null);
  assert.equal(store.listUsageRecords().length, before);
});

test('recordUsage is fail-open: a bad result never throws', () => {
  assert.doesNotThrow(() => recordUsage({ source: 'coder' }, null, null));
  assert.doesNotThrow(() => recordUsage(undefined, undefined, undefined));
});

// Bring-your-own-key: the run is metered in full but the platform never paid for
// it, so the chargeable field is zero and the same money is kept as notional. The
// visible zero is the product — if it were folded into costTokenCredits the org could not
// tell a free run from one it had already paid Anthropic for.
test('a customer-key run is recorded at zero charge with its value kept as notional', () => {
  const rec = recordUsage(
    { projectId: 'p-byok', source: 'coder', providerSource: 'customer' },
    { usage: ONE_K, costUsd: 0.03 },
    { provider: 'claude', model: 'c-1' },
  );
  assert.equal(rec.billingSource, 'customer');
  assert.equal(rec.costTokenCredits, 0, 'nothing to debit: the org paid the provider directly');
  assert.equal(rec.notionalCostTokenCredits, 157);
  assert.equal(rec.usage.inputTokens, 1000, 'the measurement survives; only the charge is zero');
});

test('a platform-key run charges in full and carries no notional figure', () => {
  const rec = recordUsage(
    { projectId: 'p-managed', source: 'coder', providerSource: 'managed' },
    { usage: ONE_K, costUsd: 0.03 },
    { provider: 'claude', model: 'c-1' },
  );
  assert.equal(rec.billingSource, 'managed');
  assert.equal(rec.costTokenCredits, 157);
  assert.equal(rec.notionalCostTokenCredits, 0);
});

// A run that never carried the decision could only have used a platform key on the
// shared stack, and defaulting the other way would hand every run a free pass.
test('an unlabelled run meters as managed, never as free', () => {
  assert.equal(resolveBillingSource({}), 'managed');
  assert.equal(resolveBillingSource({ providerSource: null }), 'managed');
  assert.equal(resolveBillingSource({ providerSource: ' CuStOmEr ' }), 'customer');
  assert.equal(resolveBillingSource({ providerSource: 'whatever-else' }), 'managed');
  const rec = recordUsage(
    { projectId: 'p-legacy', source: 'coder' },
    { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, costUsd: 0.02 },
    { provider: 'claude' },
  );
  assert.equal(rec.billingSource, 'managed');
  assert.equal(rec.costTokenCredits, 2, '₹0.01566 rounds to 2 token credits, and a managed run pays it');
});

test('usage records filter by billing source, and legacy rows read as managed', () => {
  const orgId = 'org-source-filter';
  recordUsage({ orgId, providerSource: 'customer' },
    { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, costUsd: 0.01 }, { provider: 'claude' });
  recordUsage({ orgId },
    { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, costUsd: 0.01 }, { provider: 'claude' });
  const unlabeled = store.addUsageRecord({
    orgId, provider: 'claude', usage: { totalTokens: 10 }, costTokenCredits: 100, createdAt: new Date().toISOString(),
  });
  assert.equal(unlabeled.billingSource, undefined, 'a pre-BYOK row really has no label');

  const customer = store.listUsageRecords({ orgId, billingSource: 'customer' });
  const managed = store.listUsageRecords({ orgId, billingSource: 'managed' });
  assert.equal(customer.length, 1);
  assert.equal(managed.length, 2, 'the labelled run and the unlabelled legacy row are both managed spend');
  assert.equal(customer.length + managed.length, 3);
});

// Price-match visibility: an estimate built from the fallback row is a guess, and a
// guess that only exists inside `credit-rates.js` is unalertable. The record carries the
// label and the warn line is what a log metric counts — that sentence is an alert
// contract, asserted literally by deploy/gcp/observability-config.test.js.
test('the price match is recorded, and an unmodeled provider says so out loud', () => {
  const logger = require('../logger');
  const realWarn = logger.warn;
  const warnings = [];
  logger.warn = (message, meta) => warnings.push({ message, meta });
  try {
    const modeled = recordUsage(
      { orgId: 'org-price-match', source: 'coder' },
      { usage: ONE_K },
      { provider: 'claude', model: 'c-1' },
    );
    assert.equal(modeled.priceMatch, 'Exact', 'a provider in the card, priced from it');
    assert.equal(warnings.length, 0, 'an exact card price is not an incident');

    const billed = recordUsage(
      { orgId: 'org-price-match', source: 'coder' },
      { usage: ONE_K, costUsd: 0.02 },
      { provider: 'brand-new-runtime', model: 'm-1' },
    );
    assert.equal(billed.priceMatch, 'Default', 'the SDK billed it, and the card still set the debit');
    assert.equal(billed.costTokenCredits, 157, 'priced by fallback: plausible, wrong, and now labeled');
    assert.equal(warnings.length, 1, 'one loud line per guessed record, which is what the alert counts');
    assert.equal(warnings[0].meta.priceMatch, 'Default');
    assert.match(warnings[0].message, /unmodeled provider/);
  } finally {
    logger.warn = realWarn;
  }
});

// A run whose usage names no priced dimension is ₹0 under a card that prices the family
// above zero, and the outbox refuses a zero quantity quietly because zero is the normal
// BYOK answer. Without this line that spend would be unmetered with no signal at all.
test('a run that prices into nothing is loud about it', () => {
  const logger = require('../logger');
  const realWarn = logger.warn;
  const warnings = [];
  logger.warn = (message, meta) => warnings.push({ message, meta });
  try {
    const bare = recordUsage(
      { orgId: 'org-rounding', source: 'coder' },
      { usage: { totalTokens: 2000 }, costUsd: 0.02 },
      { provider: 'claude' },
    );
    assert.equal(bare.costTokenCredits, 0, 'the quantity is not inflated to clear a floor');
    assert.deepEqual(warnings.map((w) => w.message), ['billing_usage_cost_rounded_to_zero']);
    assert.equal(warnings[0].meta.totalTokens, undefined, 'the line names the counts it rounded');
    assert.equal(warnings[0].meta.inputTokens, 0);
  } finally {
    logger.warn = realWarn;
  }
});

test('a zero-cost local run is modeled, not missing', () => {
  const rec = recordUsage(
    { orgId: 'org-price-match-local', source: 'coder' },
    { usage: ONE_K },
    { provider: 'ollama', model: 'qwen' },
  );
  assert.equal(rec.priceMatch, 'Exact', 'ollama is in the card at 0/0 — modeled on purpose');
  assert.equal(rec.costTokenCredits, 0);
});
