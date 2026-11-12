'use strict';

const store = require('../store');
const log = require('../logger');
const pricing = require('./pricing');
const billingOutbox = require('./billing-outbox');
const { resolveOrgId } = require('./org-context');

/**
 * First-party usage metering — the ONLY place an agent run's token/cost usage is
 * persisted. Two call sites, and which one applies depends on where the run
 * executed: in-process harnesses call it from harnesses/contract.js meterRun,
 * and a Substrate actor run is metered by the dispatching planner pod (see
 * agent/substrate-runner.js) because the actor itself has no tenant store.
 *
 * The runtime already NORMALIZES usage (agent/runtimes normalizeUsage) before we
 * see it, so this module only picks the persisted subset and computes cost. It
 * MUST be fail-open: any error is swallowed so metering never breaks a run.
 */

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/** Reduce a normalized-usage object to the small persisted shape. */
function pickUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    totalTokens: num(u.totalTokens) || num(u.inputTokens) + num(u.outputTokens),
    cachedInputTokens: num(u.cachedInputTokens),
    reasoningOutputTokens: num(u.reasoningOutputTokens),
  };
}

/**
 * Which key paid the provider for this run. `'customer'` must be ASSERTED by the
 * caller — it arrives as `providerSource`, threaded from the settings preflight
 * that actually made the managed-vs-customer decision — and anything else records
 * as `'managed'`. Defaulting the unknown case to `'managed'` is the conservative
 * direction: an unlabelled bring-your-own-key run over-charges the organization and
 * the spend reconciliation finds the delta, whereas defaulting to `'customer'` would
 * hand every run an unmetered free pass.
 *
 * The field is named `providerSource`, not `credentialSource`: the pipeline
 * contract's secret-shape guard rejects any key that reads as a credential, and a
 * billing label is not one.
 */
function resolveBillingSource(attribution = {}) {
  return String(attribution.providerSource || '').trim().toLowerCase() === 'customer'
    ? 'customer'
    : 'managed';
}

/**
 * Persist one granular usage record for a completed (or errored) agent run.
 * @param {object} attribution { orgId?, projectId?, projectName?, userId?, userEmail?, taskId?, taskIdentifier?, source?, runId?, traceId?, gatewayMode?, providerSource? }
 * @param {object} result      the runtime result { usage, costUsd }
 * @param {object} [llm]        { provider, model } for cost estimation + labels
 * @returns {object|null} the stored record, or null when skipped / on error
 */
function recordUsage(attribution = {}, result = {}, llm = {}) {
  try {
    const usage = pickUsage(result.usage);
    // Skip empty runs (no tokens) to avoid noise in the ledger/drill-down.
    if (!usage.totalTokens && !usage.inputTokens && !usage.outputTokens) return null;
    const costUsd = pricing.costUsdFromResult(result, llm);
    const grossPaise = pricing.usdToPaise(costUsd);
    const orgId = resolveOrgId(attribution);
    const billingSource = resolveBillingSource(attribution);
    const priceMatch = pricing.priceMatchOf(llm && llm.provider, result && result.costUsd);
    // Loud, because a silently-guessed rate is a billing error that reads as a
    // number. The record still posts — an estimate beats an unmetered run — but
    // the alert on this line is how a new provider gets added to the catalog.
    if (priceMatch === 'Default' && grossPaise > 0) {
      log.warn(`cost estimate priced an unmodeled provider from the fallback rate: ${llm.provider}`, {
        priceMatch,
        provider: (llm && llm.provider) || 'unknown',
        model: (llm && llm.model) || 'unknown',
        runId: attribution.runId || null,
      });
    }
    // `costPaise` is the ONLY field the billing sweep turns into a debit, so a
    // run on the org's own key posts zero: the platform never spent that money
    // and cannot bill it. The same amount is kept as `notionalCostPaise` so the
    // org still sees the value it consumed. Exactly one of the two is ever
    // non-zero, and `costPaise + notionalCostPaise` is the gross.
    const isCustomerKey = billingSource === 'customer';
    const record = store.addUsageRecord({
      orgId,
      projectId: attribution.projectId || null,
      projectName: attribution.projectName || null,
      userId: attribution.userId || null,
      userEmail: attribution.userEmail || null,
      taskId: attribution.taskId || null,
      taskIdentifier: attribution.taskIdentifier || null,
      source: attribution.source || 'run',
      // Correlation handles: the trace id links this row to Langfuse + the
      // service logs, and runId links it to the job that made it. Both are
      // best-effort — a run recorded without them is still billable.
      runId: attribution.runId || null,
      traceId: attribution.traceId || null,
      gatewayMode: attribution.gatewayMode || null,
      // Which key paid the provider, and the two money fields that follow from
      // it (see the comment above): a customer run is recorded, never charged.
      billingSource,
      provider: (llm && llm.provider) || 'unknown',
      model: (llm && llm.model) || 'unknown',
      usage,
      costUsd,
      // 'Reported' | 'Exact' | 'Default' — how much to trust the two fields below.
      priceMatch,
      costPaise: isCustomerKey ? 0 : grossPaise,
      notionalCostPaise: isCustomerKey ? grossPaise : 0,
    });
    // Hand the same number to FlexPrice, through the outbox rather than the
    // network: this is the one place a run's cost becomes a fact, so it is also
    // the place the delivery record has to be written. Nothing here awaits.
    billingOutbox.enqueueLlmCost(record);
    return record;
  } catch (err) {
    log.warn(`recordUsage failed: ${err && err.message ? err.message : err}`);
    return null;
  }
}

module.exports = {
  pickUsage,
  resolveBillingSource,
  recordUsage,
};
