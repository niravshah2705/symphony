'use strict';

/**
 * Operator-invoked one-shot: reconcile what the model gateway says a window cost
 * against what this platform metered for it, and print the difference. Run it
 * with `npm run billing:reconcile` (or `node services/billing/src/reconcile-gateway-spend.js`
 * against a hydrated store). It is deliberately Job-shaped — one selection pass,
 * one report per org, no server, no state — so a Cloud Run Job + scheduler can
 * wrap it without changing this file, but nothing schedules it yet: the
 * gateway-side read needs the per-org LiteLLM virtual key, and the `litellm`
 * mode is not shippable in GCP until the Cloud Run ↔ GKE path is proven
 * (docs/SUBSTRATE_INTEGRATION.md). A weekly scheduled job over a path that
 * answers `gateway_unreachable` for every org is a report nobody reads.
 *
 * READ-ONLY BY DESIGN. It writes no usage record, no ledger entry, and no
 * correction. An auto-inserted row would double-bill every record that landed
 * after a Pub/Sub retry — the sweep debits `costPaise` at write time, so a
 * second row is a second debit. The report is evidence to investigate, never an
 * invoice to apply.
 *
 * WHY the join exists: a run that completes without a usage record is invisible
 * to a balance. That is exactly the substrate-unmetered defect (harness
 * `meterRun` silently returning when attribution was absent) — it was discovered
 * by reading code, and a gateway-vs-platform delta is how the *next* one gets
 * found by an operator instead of felt by a customer.
 *
 * WHAT THE DELTA MEANS, because both sides count different things:
 *   - the gateway counts every request it served, including retries and calls
 *     whose response never reached an agent;
 *   - the platform counts every run it metered, including `customer` (BYOK) rows
 *     whose `costPaise` is deliberately 0 and whose real gateway spend is
 *     reported as `notionalCostPaise`.
 * So `we_recorded.comparablePaise` = managed cost + customer notional, and a
 * nonzero delta is expected noise unless it trends in one direction.
 *
 * Currency: the gateway reports USD, the ledger is integer paise, converted with
 * the single global `CONFIG.BILLING.usdToInr`. A rate applied to money the
 * platform never spent is a comparison, not a charge — which is why the notional
 * series is presented in USD in the product: a rupee symbol on money nobody paid
 * invites a dispute the number cannot settle.
 *
 * Keys come from the org's own vault entry (the per-org LiteLLM virtual key),
 * NEVER the gateway master key: a per-org report assembled from master-key
 * telemetry would carry other tenants' spend into this tenant's numbers.
 *
 * Local/dev reachability note: the gateway is `INGRESS_TRAFFIC_INTERNAL_ONLY`,
 * so outside VPC-connected compute this job needs `gcloud run services proxy`
 * (see docs/LLM_GATEWAY.md). Unreachable is a reported state, not a crash.
 */

const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const store = require('@ai-fleet/shared-core/store');
const pricing = require('@ai-fleet/shared-core/billing/pricing');
const { fetchS2sSecrets } = require('@ai-fleet/shared-core/secrets/s2s-resolver');
const { createFlexpriceClient, rowsOf } = require('@ai-fleet/shared-core/billing/flexprice-client');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_WINDOW_DAYS = 1;
// A |delta| under one paise is a rounding difference, not a discrepancy.
const MATCH_TOLERANCE_PAISE = 1;

function isoWindow(days, now = new Date()) {
  const until = now.toISOString();
  const since = new Date(now.getTime() - Math.max(1, Number(days) || DEFAULT_WINDOW_DAYS) * 86400000).toISOString();
  return { since, until };
}

/** Slice usage records by org + creation time against the ISO window bounds. */
function windowRecords(storeApi, { orgId, since, until }) {
  return storeApi
    .listUsageRecords(orgId ? { orgId } : {})
    .filter((record) => {
      const at = String(record && record.createdAt || '');
      return at >= since && at <= until;
    });
}

/**
 * What we recorded, split so the gateway's definition can be matched to it.
 * `gatewayModes` is the reason a delta needs a third dimension: a `litellm` run
 * has a gateway-side number, a `direct` run can never have one, and summing both
 * against one gateway total guarantees a false alarm.
 */
function recordedTotals(records) {
  const out = {
    records: records.length,
    managedPaise: 0,
    customerNotionalPaise: 0,
    costPaise: 0,
    notionalCostPaise: 0,
    gatewayModes: {},
  };
  for (const record of records) {
    const cost = Number(record.costPaise) || 0;
    const notional = Number(record.notionalCostPaise) || 0;
    out.costPaise += cost;
    out.notionalCostPaise += notional;
    if ((record.billingSource || 'managed') === 'customer') out.customerNotionalPaise += notional;
    else out.managedPaise += cost;
    const mode = String(record.gatewayMode || 'direct');
    out.gatewayModes[mode] = (out.gatewayModes[mode] || 0) + 1;
  }
  out.comparablePaise = out.managedPaise + out.customerNotionalPaise;
  return out;
}

/**
 * Sum one gateway spend-log response. LiteLLM returns a JSON array of
 * per-request rows with `spend` in USD; `{results: […]}` is accepted because a
 * paginated response wraps the same rows. Anything else is reported as
 * unshapeled — an empty list here would read as "the gateway served nothing",
 * which is the exact false negative this job exists to catch.
 */
function summarizeSpendLogs(payload) {
  let rows = null;
  if (Array.isArray(payload)) rows = payload;
  else if (payload && typeof payload === 'object' && Array.isArray(payload.results)) rows = payload.results;
  if (rows === null) return { available: false, reason: 'gateway_response_unshapeled' };
  let spendUsd = 0;
  let requests = 0;
  for (const row of rows) {
    const spend = Number(row && row.spend);
    if (!Number.isFinite(spend)) continue;
    spendUsd += spend;
    requests += 1;
  }
  return { available: true, requests, spendUsd, spendPaise: pricing.usdToPaise(spendUsd) };
}

function comparison(actualPaise, expectedPaise, unavailableVerdict) {
  if (!Number.isFinite(actualPaise)) return { paise: null, verdict: unavailableVerdict };
  const paise = Math.round(actualPaise - expectedPaise);
  if (Math.abs(paise) <= MATCH_TOLERANCE_PAISE) return { paise, verdict: 'match' };
  return { paise, verdict: paise > 0 ? 'platform_ahead' : 'we_are_ahead' };
}

async function resolveLlmCostMeter(client) {
  if (!client) return { available: false, reason: 'flexprice_unconfigured' };
  try {
    const matches = rowsOf(await client.listMeters())
      .filter((meter) => meter && meter.name === 'llm-cost');
    if (matches.length !== 1 || !matches[0].id) {
      return { available: false, reason: matches.length ? 'flexprice_meter_ambiguous' : 'flexprice_meter_unavailable' };
    }
    return { available: true, meterId: matches[0].id };
  } catch (err) {
    return { available: false, reason: `flexprice_meter_unreachable: ${err && err.message ? err.message : err}` };
  }
}

async function fetchFlexpriceSpend({ client, meter, orgId, since, until }) {
  if (!meter || !meter.available) return meter || { available: false, reason: 'flexprice_meter_unavailable' };
  try {
    const usage = await client.eventsUsageMeter({
      meter_id: meter.meterId,
      external_customer_id: orgId,
      start_time: since,
      end_time: until,
    });
    const value = Number(usage && usage.value);
    if (!Number.isFinite(value)) return { available: false, reason: 'flexprice_usage_unshapeled' };
    return { available: true, meterId: meter.meterId, spendPaise: Math.round(value) };
  } catch (err) {
    return { available: false, reason: `flexprice_usage_unreachable: ${err && err.message ? err.message : err}` };
  }
}

/**
 * `GET /global/spend/logs` for one org's virtual key. The key scopes the response
 * to that org — which is why the plan requires per-org, model-scoped virtual keys
 * rather than the master key: a shared key would return every tenant's spend.
 */
async function fetchGatewaySpend({ orgId, since, until, baseUrl, key, fetchImpl, timeoutMs }) {
  if (!baseUrl) return { available: false, reason: 'gateway_url_unconfigured' };
  if (!key) return { available: false, reason: 'gateway_key_unavailable' };
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `${String(baseUrl).replace(/\/+$/, '')}/global/spend/logs`
    + `?start_date=${encodeURIComponent(since.slice(0, 10))}`
    + `&end_date=${encodeURIComponent(until.slice(0, 10))}`;
  let response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs || 15_000),
    });
  } catch (err) {
    // Internal-only ingress, a cold gateway, an expired virtual key: all of them
    // mean "no platform number for this window", never "the window was free".
    return { available: false, reason: `gateway_unreachable: ${err && err.message ? err.message : err}` };
  }
  if (response.status === 401 || response.status === 403) {
    return { available: false, reason: `gateway_key_rejected: ${response.status}` };
  }
  if (!response.ok) return { available: false, reason: `gateway_error: ${response.status}` };
  // The spend figure is read, logged and compared; the rows themselves (which
  // carry request metadata) are never written anywhere.
  const body = await response.json().catch(() => null);
  if (body === null) return { available: false, reason: 'gateway_response_unparseable' };
  return summarizeSpendLogs(body);
}

/**
 * The one line an operator reads. Named for the two sides so a reviewer cannot
 * mistake `deltaPaise` for an amount owed.
 */
function buildReport({ orgId, window, platform, flexprice, recorded }) {
  const report = {
    orgId,
    window,
    platform_says: platform,
    we_recorded: recorded,
    delta: comparison(
      platform.available ? platform.spendPaise : NaN,
      recorded.comparablePaise,
      'platform_unavailable',
    ),
  };
  if (flexprice) {
    report.flexprice_says = flexprice;
    report.flexprice_delta = comparison(
      flexprice.available ? flexprice.spendPaise : NaN,
      recorded.costPaise,
      'flexprice_unavailable',
    );
  }
  return report;
}

/**
 * Orgs to check: the ones with usage in the window. Not the org list — an org
 * with no metered activity and a nonzero gateway number is precisely the finding
 * this job exists to make, so its records are pulled even when empty… but an org
 * with NO records at all cannot be discovered from the usage collection alone,
 * which is why `RECONCILE_ORG_IDS` exists for a targeted sweep.
 */
function selectOrgs(storeApi, env) {
  const pinned = String(env.RECONCILE_ORG_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => UUID_RE.test(value));
  if (pinned.length) return [...new Set(pinned)];
  return [...new Set(storeApi.listUsageRecords().map((record) => record.orgId).filter((id) => UUID_RE.test(id)))];
}

async function reconcileOrg(orgId, options) {
  const { deps, window } = options;
  const recorded = recordedTotals(windowRecords(deps.storeApi, { orgId, ...window }));
  const gatewayPromise = (async () => {
    if (!deps.baseUrl) return deps.fetchGatewaySpend({ orgId, ...window, baseUrl: '' });
    try {
      const secrets = await deps.fetchS2sSecrets({ organizationId: orgId });
      const secretKey = CONFIG.LLM_GATEWAY_MODES.litellm.secretKey;
      return deps.fetchGatewaySpend({
        orgId,
        ...window,
        baseUrl: deps.baseUrl,
        key: secrets[secretKey] || '',
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs,
      });
    } catch (err) {
      return { available: false, reason: `gateway_secrets_unavailable: ${err && err.message ? err.message : err}` };
    }
  })();
  const flexpricePromise = deps.fetchFlexpriceSpend({
    client: deps.flexpriceClient,
    meter: deps.flexpriceMeter,
    orgId,
    ...window,
  });
  const [platform, flexprice] = await Promise.all([gatewayPromise, flexpricePromise]);
  return buildReport({ orgId, window, platform, flexprice, recorded });
}

async function main({
  env = process.env,
  initStoreImpl = store.initStore,
  deps = {},
  now = new Date(),
  logImpl = log,
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const days = Number(env.RECONCILE_WINDOW_DAYS) || DEFAULT_WINDOW_DAYS;
  const window = isoWindow(days, now);
  const flexpriceClient = Object.hasOwn(deps, 'flexpriceClient')
    ? deps.flexpriceClient
    : (CONFIG.FLEXPRICE.enabled ? createFlexpriceClient({ config: CONFIG.FLEXPRICE }) : null);
  const resolved = {
    storeApi: deps.storeApi || store,
    fetchS2sSecrets: deps.fetchS2sSecrets || fetchS2sSecrets,
    fetchGatewaySpend: deps.fetchGatewaySpend || fetchGatewaySpend,
    fetchFlexpriceSpend: deps.fetchFlexpriceSpend || fetchFlexpriceSpend,
    flexpriceClient,
    fetchImpl: deps.fetchImpl,
    baseUrl: deps.baseUrl ?? (CONFIG.LITELLM.url || String(env.LITELLM_URL || '').trim()),
    timeoutMs: deps.timeoutMs,
  };

  await initStoreImpl();
  resolved.flexpriceMeter = deps.flexpriceMeter || await resolveLlmCostMeter(flexpriceClient);
  const orgs = selectOrgs(resolved.storeApi, env);
  logImpl.info(`gateway spend reconcile: ${orgs.length} org(s) over ${window.since.slice(0, 10)}..${window.until.slice(0, 10)}`, {
    gateway: resolved.baseUrl ? 'configured' : 'not configured',
  });

  let unavailable = 0;
  let flexpriceUnavailable = 0;
  for (const orgId of orgs) {
    try {
      const report = await reconcileOrg(orgId, { deps: resolved, window });
      if (!report.platform_says.available) unavailable += 1;
      if (!report.flexprice_says.available) flexpriceUnavailable += 1;
      write(JSON.stringify(report));
    } catch (err) {
      unavailable += 1;
      flexpriceUnavailable += 1;
      const reason = `reconcile_failed: ${err && err.message ? err.message : err}`;
      write(JSON.stringify({
        orgId,
        window,
        platform_says: { available: false, reason },
        flexprice_says: { available: false, reason },
        we_recorded: null,
        delta: { paise: null, verdict: 'reconcile_failed' },
        flexprice_delta: { paise: null, verdict: 'reconcile_failed' },
      }));
    }
  }

  return { orgs: orgs.length, unavailable, flexpriceUnavailable, window, days };
}

if (require.main === module) {
  main().then((summary) => {
    process.stdout.write(`${JSON.stringify({ summary })}\n`);
  }).catch((err) => {
    log.error(`gateway spend reconcile failed: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  reconcileOrg,
  selectOrgs,
  windowRecords,
  recordedTotals,
  summarizeSpendLogs,
  comparison,
  resolveLlmCostMeter,
  fetchFlexpriceSpend,
  fetchGatewaySpend,
  buildReport,
  isoWindow,
  MATCH_TOLERANCE_PAISE,
  DEFAULT_WINDOW_DAYS,
};
