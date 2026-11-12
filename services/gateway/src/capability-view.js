'use strict';

/**
 * GET /api/capabilities — one read-only view of what this organization can do
 * right now, and why anything it cannot do is unavailable.
 *
 * The four faces come from the services that already own each answer; nothing is
 * stored here, because a second copy of a capability decision is a second source
 * of truth that will disagree with the first:
 *
 *   harnesses     settings preflight (`POST /api/v1/settings/preflight`) — the
 *                 same call pipeline admission makes, with the org's configured
 *                 stage defaults and no browser-supplied selections.
 *   budget        `billing/gate.js`, the only monetary gate in the product.
 *   modelUsage    billing `GET /api/billing/summary`, the `bySource` series that
 *                 separates what the platform charged from what the org's own
 *                 key already paid for.
 *   environment   org `GET /api/v1/me/environment`, the initialization run.
 *
 * Three things this endpoint is honest about, because the code underneath is not
 * obvious:
 *
 * 1. `allowed`, `available`, `supported` and `brokered` are FOUR different
 *    predicates and admission requires all of them plus `credential.ready`
 *    (`pipeline-admission.js:269-277`). They mean different things to an operator
 *    — "the harness exists", "this workflow uses it", "we broker its credentials"
 *    — so each stage reports its components AND the conjunction, with `blocking`
 *    naming which ones failed. "Why is this tile greyed out" is the entire
 *    purpose of the endpoint; a single boolean would not answer it.
 *
 * 2. **Budget is a token limit in the glossary and a balance in the code.**
 *    `GLOSSARY.md` defines Budget as a token allowance; `billing/gate.js` blocks on
 *    the FlexPrice wallet balance — the `state` it derives from
 *    `real_time_credit_balance`, not an amount compared against a locally held
 *    figure — and nothing anywhere enforces a token count. So this
 *    reports the money gate it can observe and `tokenBudget.configured: false`
 *    for the one it cannot. Inventing a Firestore field to fill the shape would
 *    make the API a lie with storage behind it.
 *
 * 3. Usage history is pruned. `MAX_USAGE_RECORDS` caps the store's granular rows
 *    and `CONFIG.BILLING.usageRetentionDays` ages them out, so a zero-cost window
 *    can mean "nothing ran" or "we dropped the rows". `retention` discloses which.
 *
 * A face that failed to resolve reports `{ ok: false, error }` and appears in
 * `degraded`; the rest still returns. Failing the whole view because the settings
 * service is down would hide the balance an operator needs in order to fix it —
 * but note that no face ever *guesses*: an unavailable predicate is never
 * reported as satisfied.
 */

const { CONFIG } = require('@ai-fleet/shared-core/config');
const { PIPELINE_STAGES } = require('@ai-fleet/shared-core/pipeline/contracts');
const { billingStatus: defaultBillingStatus } = require('@ai-fleet/shared-core/billing/gate');
const { DEFAULT_ALERT_THRESHOLDS_PAISE } = require('@ai-fleet/shared-core/billing/ledger');
const { paiseToInr } = require('@ai-fleet/shared-core/billing/pricing');
const log = require('@ai-fleet/shared-core/logger');
const store = require('@ai-fleet/shared-core/store');
const { SETTINGS_PREFLIGHT_PATH, stageModelSelections } = require('./pipeline-admission');
const { callJson: defaultCallJson } = require('./service-client');
const { bearerToken } = require('./auth');
const { requestContext } = require('./request-context');
const { BILLING_HEADERS } = require('./billing-access');

// The predicates admission requires, in the order an operator should read them:
// is the harness offered at all → does it run this workflow → may this org use it
// → are its credentials brokered → is a usable credential actually present.
const PREDICATES = Object.freeze([
  ['available', 'This harness is not offered by the deployment.'],
  ['supported', 'This harness does not run that workflow.'],
  ['allowed', 'Policy does not allow this harness for your organization.'],
  ['brokered', 'This workflow needs brokered credentials the platform does not broker.'],
  ['providerReady', 'No usable credential is configured for this provider.'],
]);

function failedPredicates(stage) {
  return PREDICATES.filter(([key]) => stage[key] !== true).map(([key, message]) => ({
    predicate: key,
    message,
  }));
}

/**
 * The settings preflight response → the harnesses face. Reuses admission's own
 * validator, so "what the view says is runnable" and "what admission will accept"
 * cannot drift into two different answers.
 */
function harnessesFace(decision) {
  const stages = Array.isArray(decision && decision.stages) ? decision.stages : [];
  const rows = stages.map((item) => {
    const blocking = failedPredicates(item);
    return {
      stage: item.stage,
      workflow: item.workflow || null,
      harness: item.harness || null,
      provider: item.provider || null,
      modelId: item.modelId || null,
      providerSource: item.providerSource || null,
      available: item.available === true,
      supported: item.supported === true,
      allowed: item.allowed === true,
      brokered: item.brokered === true,
      providerReady: item.providerReady === true,
      ready: blocking.length === 0,
      blocking,
    };
  });
  return {
    ok: true,
    decisionId: (decision && decision.decisionId) || null,
    // The conjunction pipeline admission actually applies.
    ready: rows.length > 0 && rows.every((row) => row.ready),
    stages: rows,
  };
}

function budgetFace(status, alertThresholdsPaise) {
  const raw = status ? status.balancePaise : null;
  const balancePaise = raw === null || raw === undefined ? null : Number(raw) || 0;
  return {
    ok: true,
    currency: 'INR',
    balancePaise,
    balanceInr: balancePaise === null ? null : paiseToInr(balancePaise),
    // Passed through from the gate instead of recomputed: a null balance means
    // "there is no wallet account to draw on", which is a different claim from
    // "the balance is zero" — and an operator who read zero would hunt for a
    // charge that never happened.
    blocked: status ? status.blocked === true : false,
    fundsAvailable: status ? status.fundsAvailable !== false : false,
    fundStatus: (status && status.fundStatus) || null,
    reason: (status && status.reason) || null,
    gateActive: balancePaise !== null,
    // The same constant the alerting policy is built on, not a restatement.
    alertThresholdsPaise: [...(alertThresholdsPaise || DEFAULT_ALERT_THRESHOLDS_PAISE)],
    tokenBudget: {
      configured: false,
      note: 'The glossary defines Budget as a token allowance; no token-counting '
        + 'enforcement exists in code. Runs stop on the monetary balance above, '
        + 'not on tokens.',
    },
  };
}

function usageFace(summary) {
  const month = (summary && summary.bySource && summary.bySource.month) || {};
  const sources = month.sources || {};
  const retention = month.retentionDays ?? null;
  return {
    ok: true,
    windowDays: 31,
    // Two series, because the BYOK promise is a visible zero: `customer` spend is
    // recorded at what the org's own key cost the provider, and charged nothing.
    sources: {
      managed: sources.managed || { runs: 0, tokens: 0, costPaise: 0, notionalPaise: 0 },
      customer: sources.customer || { runs: 0, tokens: 0, costPaise: 0, notionalPaise: 0 },
    },
    retention: {
      days: retention,
      // `historyTruncated` is billing's own statement that the store hit its
      // record cap, so a small number here may be a pruned number.
      truncated: month.historyTruncated === true,
      recordCap: store.USAGE_RECORD_CAP,
    },
  };
}

function environmentFace(data) {
  const steps = Array.isArray(data && data.steps) ? data.steps : [];
  return {
    ok: true,
    initialized: data ? data.initialized === true : false,
    runId: (data && data.run_id) || null,
    status: (data && data.status) || null,
    desiredRevision: (data && data.desired_revision) || '',
    attemptedRevision: (data && data.attempted_revision) || null,
    trigger: (data && data.trigger) || null,
    steps: steps.map((step) => ({
      key: step.key,
      status: step.status,
      detail: step.detail || null,
      updatedAt: step.updated_at || null,
    })),
    deployment: data && data.deployment
      ? { status: data.deployment.status, gatewayUrl: data.deployment.gateway_url || '' }
      : null,
  };
}

function createCapabilityView({
  callJson = defaultCallJson,
  getBillingStatus = defaultBillingStatus,
  settingsUrl = CONFIG.SERVICES.settingsUrl,
  orgUrl = CONFIG.SERVICES.orgUrl,
  billingUrl = CONFIG.SERVICES.billingUrl,
  getSettings = store.getSettings,
  stages = PIPELINE_STAGES,
  alertThresholdsPaise = DEFAULT_ALERT_THRESHOLDS_PAISE,
} = {}) {
  const unavailable = (service) => ({
    ok: false,
    error: `${service} is not configured for this deployment.`,
  });
  // Admission's own failure messages are short and curated, so they can be
  // surfaced; anything else becomes a generic line rather than a leaked body.
  const explain = (err, fallback) => (err && err.code && err.message ? err.message : fallback);

  return async function handleCapabilities(req, res) {
    res.set('Cache-Control', 'no-store');
    const context = requestContext(req);
    let bearer = '';
    try {
      bearer = bearerToken(req);
    } catch (_) {
      bearer = '';
    }
    const view = {
      organizationId: context.organizationId || null,
      projectId: context.projectId || null,
      generatedAt: new Date().toISOString(),
      faces: ['harnesses', 'budget', 'modelUsage', 'environment'],
      degraded: [],
    };

    // 1. harnesses — the org's own configured defaults, never a browser choice.
    if (!settingsUrl) {
      view.harnesses = unavailable('Settings preflight');
    } else {
      try {
        const selections = stageModelSelections(stages, getSettings());
        const { status, data } = await callJson(settingsUrl, SETTINGS_PREFLIGHT_PATH, {
          method: 'POST',
          body: {
            ...(context.projectId ? { project_id: context.projectId } : {}),
            stages,
            harnesses: {},
            providers: Object.fromEntries(stages.map((s) => [s, selections[s].provider])),
            models: Object.fromEntries(stages.map((s) => [s, selections[s].modelId])),
          },
          userAuth: bearer,
          context,
        });
        if (status !== 200 || !data) throw new Error(`preflight returned ${status}`);
        view.harnesses = harnessesFace(data);
      } catch (err) {
        log.warn(`capabilities: settings preflight failed (${err && err.message ? err.message : err})`);
        view.harnesses = { ok: false, error: explain(err, 'Harness availability could not be resolved.') };
      }
    }

    // 2. budget — the gate the runner itself consults, read in the gateway's own
    //    process so this cannot disagree with what admission would do.
    try {
      view.budget = budgetFace(
        await Promise.resolve(getBillingStatus({
          orgId: context.organizationId,
          projectId: context.projectId,
        })),
        alertThresholdsPaise,
      );
    } catch (err) {
      log.warn(`capabilities: billing status failed (${err && err.message ? err.message : err})`);
      view.budget = { ok: false, error: 'Balance could not be resolved.' };
    }

    // 3. model usage — scoped by the caller's billing identity, which the gateway
    //    resolved server-side and hands over as trusted headers (billing-access).
    if (!billingUrl) {
      view.modelUsage = unavailable('Billing service');
    } else {
      const caller = req.billingCaller || {};
      try {
        const { status, data } = await callJson(billingUrl, '/api/billing/summary', {
          userAuth: bearer,
          context,
          headers: {
            [BILLING_HEADERS.org]: caller.orgId || '',
            [BILLING_HEADERS.role]: caller.isAdmin ? 'ORG_ADMIN' : 'ORG_MEMBER',
            [BILLING_HEADERS.user]: caller.userId || '',
          },
        });
        if (status !== 200 || !data) throw new Error(`summary returned ${status}`);
        view.modelUsage = usageFace(data);
      } catch (err) {
        log.warn(`capabilities: billing summary failed (${err && err.message ? err.message : err})`);
        view.modelUsage = { ok: false, error: explain(err, 'Model usage could not be resolved.') };
      }
    }

    // 4. environment — the initialization run, addressed by the caller's token.
    if (!orgUrl) {
      view.environment = unavailable('Organization service');
    } else {
      try {
        const { status, data } = await callJson(orgUrl, '/api/v1/me/environment', {
          userAuth: bearer,
          context,
        });
        if (status !== 200 || !data) throw new Error(`environment returned ${status}`);
        view.environment = environmentFace(data);
      } catch (err) {
        log.warn(`capabilities: environment run failed (${err && err.message ? err.message : err})`);
        view.environment = { ok: false, error: explain(err, 'Environment state could not be resolved.') };
      }
    }

    for (const face of view.faces) {
      if (view[face] && view[face].ok !== true) view.degraded.push(face);
    }
    return res.json(view);
  };
}

module.exports = { createCapabilityView, harnessesFace, budgetFace, usageFace, environmentFace, PREDICATES };
