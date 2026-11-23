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

/**
 * Whether the card row that priced a run is free on purpose. `0` from ollama is an
 * answer; `0` from a row that quotes ₹5.22/1M is a rounding, and only the second one
 * is worth a log line.
 */
function pricedAllZero(prices) {
  return [prices.input, prices.output, prices.cacheRead, prices.cacheWrite].every((rate) => !Number(rate));
}

/**
 * Reduce a normalized-usage object to the small persisted shape.
 *
 * The four priced dimensions come from `pricing.tokenCountsOf`, so the counts on the
 * record and the counts the debit was computed from are the same object — two
 * extractions would be two chances to disagree about what a run consumed.
 */
function pickUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const counts = pricing.tokenCountsOf(u);
  return {
    ...counts,
    totalTokens: num(u.totalTokens) || counts.inputTokens + counts.outputTokens,
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
    const priced = pricing.priceRun({ usage, llm, result });
    const grossTokenCredits = priced.tokenCredits;
    const orgId = resolveOrgId(attribution);
    const billingSource = resolveBillingSource(attribution);
    // 'Exact' | 'Default' — whether the rate card models this run's model or answered
    // from its last-resort row. The value is an alert contract: `observability.tf`
    // counts `jsonPayload.meta.priceMatch="Default"`, and the sentence below is the
    // line that metric is built from, so it is worded deliberately and asserted
    // literally by deploy/gcp/observability-config.test.js.
    const priceMatch = priced.priceMatch;
    if (priceMatch === 'Default' && grossTokenCredits > 0) {
      log.warn(`cost estimate priced an unmodeled provider from the fallback rate: ${llm.provider}`, {
        priceMatch,
        provider: (llm && llm.provider) || 'unknown',
        model: (llm && llm.model) || 'unknown',
        runId: attribution.runId || null,
      });
    }
    // `costTokenCredits` is the only field that becomes a FlexPrice quantity, and so
    // the only one that can become a debit. A run on the org's own key posts zero:
    // the platform never spent that money and cannot bill it. The same amount is kept
    // as `notionalCostTokenCredits` so the org still sees the value it consumed.
    // Exactly one of the two is ever non-zero, and their sum is the gross.
    const isCustomerKey = billingSource === 'customer';
    if (!isCustomerKey && grossTokenCredits === 0 && !pricedAllZero(priced.prices)) {
      // The card prices this run's family above zero, yet the run rounds to nothing:
      // a small, cache-read-heavy run under a cheap row. The outbox refuses a zero
      // quantity quietly, because zero is the normal BYOK answer, so without this line
      // that spend would be unmetered with no signal at all. It counts the rounding;
      // it does not change it — a debit is never inflated to clear a floor.
      log.warn('billing_usage_cost_rounded_to_zero', {
        provider: (llm && llm.provider) || 'unknown',
        model: (llm && llm.model) || 'unknown',
        runId: attribution.runId || null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      });
    }
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
      priceMatch,
      // 'Card' | 'Provider' | 'Default' — how precisely the card answered, kept
      // beside the coarser alert label so a drill-down can tell a model row from a
      // provider blend without re-resolving either.
      rateMatch: priced.rateMatch,
      // What the provider says it billed, the rate the card was stamped at, and the
      // rupee value of the debit. Provenance for the event and for a dispute — never
      // read back to compute money (see balance-authority.test.js).
      providerCost: priced.providerCost,
      providerCurrency: priced.providerCurrency,
      fxRateToInr: priced.fxRateToInr,
      inrCost: priced.inrCost,
      costTokenCredits: isCustomerKey ? 0 : grossTokenCredits,
      notionalCostTokenCredits: isCustomerKey ? grossTokenCredits : 0,
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

function recordActorUsage(session, deps = {}) {
  const { priceActorUsage } = require('./compute-pricing');
  const priced = priceActorUsage(session);
  const record = store.addUsageRecord({
    orgId: session.orgId,
    projectId: session.projectId,
    userId: session.userId,
    userEmail: session.userEmail || null,
    runId: session.runId || null,
    actorSessionId: session.id,
    agentId: session.agentId,
    tier: session.tier,
    source: 'substrate-actor',
    meter: 'actor-compute',
    durationSeconds: priced.meterValue,
    costTokenCredits: priced.expectedTokenCredits,
    createdAt: new Date(session.stoppedAt * 1000).toISOString(),
  });
  const row = billingOutbox.enqueue({
    kind: 'actorCompute', orgId: record.orgId, projectId: record.projectId, userId: record.userId,
    runId: record.runId, actorSessionId: session.id, recordId: record.id, agentId: record.agentId, tier: record.tier,
    quantity: record.durationSeconds, occurredAt: record.createdAt,
  }, deps);
  if (billingOutbox.isEnabled(deps) && record.durationSeconds > 0
    && record.orgId !== require('./org-context').SHARED_ORG_ID && !row) {
    throw new Error('actor usage has no outbox row');
  }
  return record;
}

module.exports = {
  recordActorUsage,
  pickUsage,
  resolveBillingSource,
  recordUsage,
};
