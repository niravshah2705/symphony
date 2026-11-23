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
 * after a Pub/Sub retry — the sweep debits `costTokenCredits` at write time, so a
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
 *     whose `costTokenCredits` is deliberately 0 and whose real gateway spend is
 *     reported as `notionalCostTokenCredits`.
 * So `we_recorded.comparableTokenCredits` = managed cost + customer notional, and a
 * nonzero delta is expected noise unless it trends in one direction.
 *
 * Currency: the gateway reports USD and the ledger is integer token credits, and the two
 * are joined at the rate EACH EVENT CARRIED (`fxRateToInr`, Stage 4) — not at today's card
 * row. Converting a past window at a present rate invents a discrepancy the size of the
 * rate move, so the rate states our side in the gateway's unit and never sets a charge.
 * A rate applied to money the platform never spent is a comparison, not a charge — which
 * is why the notional series is presented in USD in the product: a rupee symbol on money
 * nobody paid invites a dispute the number cannot settle.
 *
 * THREE ALARMS, deliberately not one, each catching what the others cannot:
 *   - the outbox read-back catches DELIVERY LOSS — an event that never arrived;
 *   - this job's FlexPrice leg carries a ZERO band: meter SUM over `token_credits` against
 *     summed `costTokenCredits` is our number against our number, so any delta is a defect;
 *   - this job's platform leg catches PRICING ERROR — a missing model row priced from
 *     `defaults`, transposed input/output, a stale price. Remediation is to edit
 *     `deploy/billing/credit-rates.yaml` and redeploy, never to rotate FX;
 *   - and `fx_stale` catches OPERATOR DRIFT: the rate row is past `stale_after_days`, so
 *     "who is ahead" has no honest answer and the report says so instead of guessing.
 *
 * Keys come from the org's own vault entry (the per-org LiteLLM virtual key),
 * NEVER the gateway master key: a per-org report assembled from master-key
 * telemetry would carry other tenants' spend into this tenant's numbers.
 *
 * Local/dev reachability note: the gateway is `INGRESS_TRAFFIC_INTERNAL_ONLY`,
 * so outside VPC-connected compute this job needs `gcloud run services proxy`
 * (see docs/LLM_GATEWAY.md). Unreachable is a reported state, not a crash.
 */

const { CONFIG } = require('@software-factory/shared-core/config');
const log = require('@software-factory/shared-core/logger');
const store = require('@software-factory/shared-core/store');
const creditRates = require('@software-factory/shared-core/billing/credit-rates');
const { METERS } = require('@software-factory/shared-core/billing/billing-outbox');
const { decimalToScaled, formatScaled, roundDiv } = require('@software-factory/shared-core/billing/money-wire');
const { fetchS2sSecrets } = require('@software-factory/shared-core/secrets/s2s-resolver');
const { createFlexpriceClient, rowsOf } = require('@software-factory/shared-core/billing/flexprice-client');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_WINDOW_DAYS = 1;
// The floor under any band: a |delta| of one token credit is a rounding difference, not a
// discrepancy. It is a FLOOR and not a tolerance — the FlexPrice leg opts out of it.
const FLOOR_TOKEN_CREDITS = 1;
// The gateway answers USD as a float and the card states FX to 4 dp, so a window is held
// at 8 dp of USD and 4 dp of rate, in scaled BigInts, rounded once at each division.
// Float division here would put the report's own verdict within a few credits of a
// rounding accident on a large window (money-wire.js is the argument).
const USD_DP = 8;
const FX_DP = 4;

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
 * The rate an event was priced at, if it carries one. A row written before Stage 4
 * stamped nothing, and a row whose stamp is not a positive decimal is treated as though
 * it stamped nothing too — guessing at a corrupt rate would widen or narrow the band for
 * that row by accident, which is the opposite of what the band is for.
 */
function stampedRate(value) {
  const text = String(value ?? '').trim();
  return /^\d+(\.\d{1,8})?$/.test(text) && Number(text) > 0 ? text : null;
}

/** Token credits to USD at `rate`, as a scaled integer: `tc / (100 x rate)`. */
function usdScaled(tokenCredits, rate) {
  const fx = decimalToScaled(rate, FX_DP);
  if (fx <= 0n) throw new TypeError(`reconcile: not a positive USD->INR rate: ${JSON.stringify(rate)}`);
  return roundDiv(BigInt(tokenCredits) * 10n ** BigInt(USD_DP + FX_DP), 100n * fx);
}

/**
 * What we recorded, split so the gateway's definition can be matched to it.
 * `gatewayModes` is the reason a delta needs a third dimension: a `litellm` run
 * has a gateway-side number, a `direct` run can never have one, and summing both
 * against one gateway total guarantees a false alarm.
 *
 * `expectedUsd` is the same money in the gateway's unit, converted at the rate each row
 * carries (`fxUsdToInr` is used only for the rows that carry none, and
 * `coverage.tokenCreditsWithout` says how much of the window that was). So a rate change
 * between the run and this report moves both sides together and stops fabricating a
 * delta — which is the whole point of stamping the rate in the first place. Rows are pooled
 * per rate before the division: one rounding per rate rather than one per row, so a window
 * of ten thousand small runs cannot accumulate a rounding drift in the figure the verdict
 * rests on.
 */
function recordedTotals(records, fxUsdToInr) {
  const out = {
    records: records.length,
    managedTokenCredits: 0,
    customerNotionalTokenCredits: 0,
    costTokenCredits: 0,
    notionalCostTokenCredits: 0,
    gatewayModes: {},
    comparableTokenCredits: 0,
    expectedUsd: formatScaled(0n, USD_DP),
    coverage: { withRate: 0, without: 0, tokenCreditsWithout: 0 },
  };
  const byRate = new Map();
  for (const record of records) {
    const cost = Number(record.costTokenCredits) || 0;
    const notional = Number(record.notionalCostTokenCredits) || 0;
    const isCustomer = (record.billingSource || 'managed') === 'customer';
    out.costTokenCredits += cost;
    out.notionalCostTokenCredits += notional;
    if (isCustomer) out.customerNotionalTokenCredits += notional;
    else out.managedTokenCredits += cost;
    // Comparable = what the gateway could also have seen: the managed charge, or what a
    // BYOK run really cost the customer's key.
    const comparable = isCustomer ? notional : cost;
    out.comparableTokenCredits += comparable;
    const mode = String(record.gatewayMode || 'direct');
    out.gatewayModes[mode] = (out.gatewayModes[mode] || 0) + 1;

    const rate = stampedRate(record.fxRateToInr);
    if (rate) out.coverage.withRate += 1;
    else {
      out.coverage.without += 1;
      out.coverage.tokenCreditsWithout += comparable;
    }
    const key = rate || fxUsdToInr;
    byRate.set(key, (byRate.get(key) || 0) + comparable);
  }
  let expectedScaled = 0n;
  for (const [rate, tokenCredits] of byRate) expectedScaled += usdScaled(tokenCredits, rate);
  out.expectedUsd = formatScaled(expectedScaled, USD_DP);
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
  // Stated in USD and left there. Turning it into credits needs a rate, and the only
  // honest rate for a past window is the mix its own events carried — which is a property
  // of the records, not of this response, so `platformTokenCredits` does it once per org.
  return { available: true, requests, spendUsd };
}

/**
 * The gateway's USD total expressed in token credits, at the rate mix this window's own
 * events carried: `spendUsd / expectedUsd x comparableTokenCredits`. A rate move therefore
 * cancels out of the ratio instead of becoming a delta nobody caused.
 *
 * A window with no comparable money has no mix to divide by. It falls back to the card row
 * — which is the answer that makes the finding this job exists for legible: the gateway
 * served spend for an org this platform recorded as nothing.
 */
function platformTokenCredits({ spendUsd, recorded, fxUsdToInr }) {
  const usd = Number(spendUsd);
  if (!Number.isFinite(usd)) return NaN;
  const actual = decimalToScaled(usd.toFixed(USD_DP), USD_DP);
  const expected = decimalToScaled(recorded.expectedUsd, USD_DP);
  if (expected <= 0n) return creditRates.tokenCreditsFromUsd(usd, fxUsdToInr);
  return Number(roundDiv(actual * BigInt(recorded.comparableTokenCredits), expected));
}

/**
 * `base + age x drift`, capped: how far the UNSTAMPED share of the window may sit from the
 * platform total before the difference is worth an operator's time. Rows that carry their
 * own rate need no band at all, which is why the caller passes `bandBase` as that share and
 * not the window.
 */
function toleranceBpsFor(reconcile, fx) {
  const base = Number(reconcile && reconcile.baseToleranceBps);
  const max = Number(reconcile && reconcile.maxToleranceBps);
  const drift = Number(fx.driftBpsPerDay);
  if (![base, max, drift].every(Number.isFinite)) return 0;
  return Math.min(max, base + Math.max(0, Number(fx.ageDays) || 0) * drift);
}

/** The card's FX row, plus the band the card itself authorises for rows it never stamped. */
function fxRow() {
  const fx = creditRates.fxRate();
  return { ...fx, toleranceBps: toleranceBpsFor(creditRates.rateCard().reconcile, fx) };
}

/**
 * The verdict for one leg, in token credits.
 *
 * `toleranceBps` is applied to `bandBase` (default: the figure being checked) and
 * `floorTokenCredits` is the least any band may be, so a zero window still forgives a
 * rounding step. Pass `{ toleranceBps: 0, floorTokenCredits: 0 }` for a leg where any delta
 * is a defect. Past `stale_after_days` a non-match becomes `fx_stale` rather than naming a
 * side: with a rate nobody has confirmed, "the platform is ahead" would be an accusation
 * this job has no standing to make.
 */
function compare(actual, expected, {
  toleranceBps = 0,
  bandBase = expected,
  floorTokenCredits = FLOOR_TOKEN_CREDITS,
  stale = false,
  unavailable = 'unavailable',
} = {}) {
  if (!Number.isFinite(actual)) return { tokenCredits: null, verdict: unavailable };
  const tokenCredits = Math.round(actual - expected);
  const bandTokenCredits = Math.max(floorTokenCredits, Math.ceil((bandBase * toleranceBps) / 10000));
  if (Math.abs(tokenCredits) <= bandTokenCredits) return { tokenCredits, bandTokenCredits, verdict: 'match' };
  if (stale) return { tokenCredits, bandTokenCredits, verdict: 'fx_stale' };
  return {
    tokenCredits,
    bandTokenCredits,
    verdict: tokenCredits > 0 ? 'platform_ahead' : 'we_are_ahead',
  };
}

async function resolveLlmCostMeter(client) {
  if (!client) return { available: false, reason: 'flexprice_unconfigured' };
  try {
    // The outbox's own table, not a literal: a FlexPrice meter binds to one aggregation
    // property at creation, so the pre-rename `llm-cost` meter answers a real zero for
    // every post-cutover window — which this job would then report as `we_are_ahead`.
    const matches = rowsOf(await client.listMeters())
      .filter((meter) => meter && meter.name === METERS.llmTokenCredits.meter);
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
      meterId: meter.meterId,
      externalCustomerId: orgId,
      startTime: since,
      endTime: until,
    });
    // `listMeters` is a raw-seam read, so its rows keep the wire spelling (`name`);
    // `value` here is the model's number, not a decimal string.
    const value = Number(usage && usage.value);
    if (!Number.isFinite(value)) return { available: false, reason: 'flexprice_usage_unshapeled' };
    return { available: true, meterId: meter.meterId, spendTokenCredits: Math.round(value) };
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
 * mistake `delta.tokenCredits` for an amount owed.
 */
function buildReport({ orgId, window, platform, flexprice, recorded, fx }) {
  const report = {
    orgId,
    window,
    // The row the verdict was reached with and how old it is: without these, a `match` on
    // a rate nobody has confirmed in months reads like a clean window.
    fx: {
      usdToInr: fx.usdToInr,
      asOf: fx.asOf,
      ageDays: fx.ageDays,
      stale: fx.stale,
      toleranceBps: fx.toleranceBps,
    },
    // How much of the window the band was even allowed to excuse.
    coverage: recorded.coverage,
    platform_says: platform,
    we_recorded: recorded,
    delta: compare(
      platform.available
        ? platformTokenCredits({ spendUsd: platform.spendUsd, recorded, fxUsdToInr: fx.usdToInr })
        : NaN,
      recorded.comparableTokenCredits,
      {
        toleranceBps: fx.toleranceBps,
        // Only the rows that carry no rate of their own may be excused by age.
        bandBase: recorded.coverage.tokenCreditsWithout,
        stale: fx.stale,
        unavailable: 'platform_unavailable',
      },
    ),
  };
  if (flexprice) {
    report.flexprice_says = flexprice;
    // The meter sums the same integers this list holds, so any delta is a dropped or
    // duplicated event: no band, no floor, no age excuse.
    report.flexprice_delta = compare(
      flexprice.available ? flexprice.spendTokenCredits : NaN,
      recorded.costTokenCredits,
      { toleranceBps: 0, floorTokenCredits: 0, unavailable: 'flexprice_unavailable' },
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
  const recorded = recordedTotals(
    windowRecords(deps.storeApi, { orgId, ...window }),
    deps.fx.usdToInr,
  );
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
  return buildReport({ orgId, window, platform, flexprice, recorded, fx: deps.fx });
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
    // One rate row for the whole sweep. Re-reading the card per org would let a single run
    // answer two different questions, and every verdict has to be reachable from one figure.
    fx: deps.fx || fxRow(),
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
        delta: { tokenCredits: null, verdict: 'reconcile_failed' },
        flexprice_delta: { tokenCredits: null, verdict: 'reconcile_failed' },
      }));
    }
  }

  return {
    orgs: orgs.length,
    unavailable,
    flexpriceUnavailable,
    window,
    days,
    // The row the whole sweep answered with, on the summary line too: a scheduled job that
    // prints only counts is unreadable once `fx_stale` is one of them.
    fx: {
      usdToInr: resolved.fx.usdToInr,
      asOf: resolved.fx.asOf,
      ageDays: resolved.fx.ageDays,
      stale: resolved.fx.stale,
      toleranceBps: resolved.fx.toleranceBps,
    },
  };
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
  stampedRate,
  usdScaled,
  platformTokenCredits,
  toleranceBpsFor,
  fxRow,
  compare,
  resolveLlmCostMeter,
  fetchFlexpriceSpend,
  fetchGatewaySpend,
  buildReport,
  isoWindow,
  FLOOR_TOKEN_CREDITS,
  DEFAULT_WINDOW_DAYS,
};
