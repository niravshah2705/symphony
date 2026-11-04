'use strict';

/**
 * Cloud Run Job entrypoint: evaluate auto-recharge + balance alerts, hourly.
 *
 * This is the money path that deliberately does NOT run on the 5-minute billing
 * tick (see shared-core/billing/sweep.js). It is a one-shot process: select the
 * orgs that actually need attention, VALIDATE that a charge can legally and
 * correctly happen, pull each org's identity and administrator emails from the
 * org service, and only then charge and alert. Every guard is fail-closed — a
 * skipped charge is a loud log line, never a silent success — because the
 * alternative is charging a tenant that did not ask to be charged, or crediting
 * a wallet for money that never moved.
 *
 * Two independent duties per org: the CHARGE is guarded and only for orgs that
 * opted in, the ALERT is for anyone whose balance crossed a threshold. An org
 * that declined auto-recharge still has to be told it is running dry, and an org
 * whose charge was just refused needs to hear about it immediately.
 *
 * Dry run (`BILLING_JOB_DRY_RUN=true` or `--validate`) executes selection,
 * validation and the org-service read, and charges nothing. Use it before
 * flipping a real deployment on.
 */

const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const store = require('@ai-fleet/shared-core/store');
const recharge = require('@ai-fleet/shared-core/billing/recharge');
const notify = require('@ai-fleet/shared-core/billing/notify');
const cashfreeClient = require('@ai-fleet/shared-core/billing/cashfree-client');

// Org ids are UUIDs (services/org scopes every document by one). Anything else —
// notably the shared stack's '__shared__' pseudo-org — has no org-service record
// to validate against and no administrator to notify, so it is never a candidate
// here. The shared stack's own usage is still visible on the billing dashboard.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHARGEABLE_SUBSCRIPTION_STATUSES = new Set(['ACTIVE']);

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

// Cloud Run internal services are IAM-gated, so a bearer OIDC token is required
// on top of the shared internal token. Minted only in pubsub (cloud) mode and
// lazily required, so local dev never loads google-auth-library.
let googleAuth = null;
const idTokenClients = new Map();

async function idTokenHeader(audience) {
  if (CONFIG.MESSAGING_MODE !== 'pubsub') return '';
  if (!googleAuth) {
    const { GoogleAuth } = require('google-auth-library');
    googleAuth = new GoogleAuth();
  }
  if (!idTokenClients.has(audience)) idTokenClients.set(audience, await googleAuth.getIdTokenClient(audience));
  const headers = await idTokenClients.get(audience).getRequestHeaders();
  // google-auth-library v10+ returns a WHATWG Headers object; v9 returned a plain
  // object. Read via .get() when available so the OIDC token survives.
  if (typeof headers.get === 'function') return headers.get('authorization') || '';
  return headers.Authorization || headers.authorization || '';
}

/**
 * The org service's internal billing-context read. Returns the parsed body, or
 * null for 404 (an orphan billing account with no tenant behind it). Throws on
 * any other failure so the caller skips that org instead of charging blind.
 */
async function fetchBillingContext(orgId, deps) {
  const baseUrl = String(deps.baseUrl ?? CONFIG.SERVICES.orgUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(deps.token ?? process.env.ORG_INTERNAL_API_TOKEN
    ?? process.env.INTERNAL_API_TOKEN ?? '').trim();
  if (!baseUrl) throw new Error('org service URL is not configured (ORG_URL)');
  if (!token) throw new Error('org service internal token is not configured');
  const doFetch = deps.fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('no fetch transport available');

  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch (_) {
    origin = baseUrl;
  }
  const headers = { 'x-internal-token': token, accept: 'application/json' };
  const bearer = deps.idTokenHeader
    ? await deps.idTokenHeader(origin)
    : await idTokenHeader(origin);
  if (bearer) headers.authorization = bearer;

  const url = `${baseUrl}/api/v1/internal/orgs/${encodeURIComponent(orgId)}/billing-context`;
  const res = await doFetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(deps.timeoutMs || 10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`org billing-context → ${res.status}`);
  return res.json();
}

/** Opted in and below its own (amount- or percentage-mode) recharge threshold. */
function chargeBelowThreshold(account) {
  const cfg = (account && account.autoRecharge) || {};
  if (!cfg.enabled) return false;
  const threshold = recharge.getEffectiveThresholdPaise(account, cfg);
  return (Number(account.balancePaise) || 0) < threshold;
}

/**
 * Cheap pre-filter for the alert duty: has the balance reached the *highest*
 * configured threshold at all. Whether this specific crossing was already
 * alerted is decided once, authoritatively, inside notify.checkThresholdsAndNotify.
 */
function alertSuspect(account) {
  const thresholds = ((account && account.alertThresholdsPaise) || []).map(Number).filter(Number.isFinite);
  if (!thresholds.length) return false;
  return (Number(account.balancePaise) || 0) <= Math.max(...thresholds);
}

/** The charge gates that stored state alone can answer — no network involved. */
function rechargeBlockers(orgId, cfg, deps, now = Date.now()) {
  if (!deps.cashfreeApi.isConfigured()) return 'Cashfree credentials are not configured';
  if (!cfg.cashfreeSubscriptionId) return 'no ON_DEMAND subscription (mandate) on file';
  if (!(Number(cfg.amountPaise) > 0)) return 'recharge amount is not positive';
  const gateMs = recharge.lastChargeGateMs(cfg);
  if (gateMs !== null && now - gateMs < recharge.RECHARGE_COOLDOWN_MS) {
    return 'inside the recharge cooldown window';
  }
  // Only a fully spent monthly limit blocks here; a partially chargeable month
  // is clamped downstream, in one place — recharge.chargeableAmountPaise.
  if (!(recharge.chargeableAmountPaise(orgId, cfg, now) > 0)) {
    const limit = Math.round(Number(cfg.monthlyLimitPaise) || 0);
    return `monthly recharge limit reached (${recharge.rechargedThisMonthPaise(orgId, now)} of ${limit} paise used)`;
  }
  return null;
}

function adminEmailsOf(context) {
  return (context.admins || [])
    .map((admin) => String(admin && admin.email || '').trim())
    .filter(Boolean);
}

/** Charge gate #2: the mandate must be live on Cashfree's side, not merely stored. */
async function subscriptionBlockers(deps, subscriptionId) {
  let subscription;
  try {
    subscription = await deps.cashfreeApi.getSubscription(subscriptionId);
  } catch (err) {
    return `subscription lookup failed: ${err && err.message ? err.message : err}`;
  }
  const status = String((subscription && (subscription.subscription_status ?? subscription.status)) || '')
    .toUpperCase();
  if (!CHARGEABLE_SUBSCRIPTION_STATUSES.has(status)) {
    return `subscription ${subscriptionId} is ${status || 'UNKNOWN'}, not ACTIVE`;
  }
  return null;
}

async function runCandidate(orgId, account, opts) {
  const { deps, counters, dryRun, now } = opts;
  const cfg = account.autoRecharge || {};
  const wantCharge = chargeBelowThreshold(account);

  // A blocked charge is still an alert-worthy event, so the org-service read
  // happens unless BOTH duties are moot.
  const blockers = wantCharge ? rechargeBlockers(orgId, cfg, deps, now) : null;
  if (blockers) {
    counters.skipped += 1;
    deps.log.warn(`auto-recharge ${orgId}: charge skipped — ${blockers}`);
    if (!alertSuspect(account)) return;
  }

  // Org info from the org service: proves the tenant still exists and gives the
  // alert audience. Never fall back to a cached email list — an admin who was
  // removed must stop receiving (and being billed for) this org's alerts.
  let context;
  try {
    context = await deps.fetchBillingContext(orgId, deps);
  } catch (err) {
    deps.log.warn(`auto-recharge ${orgId}: org context unavailable — `
      + `${err && err.message ? err.message : err}`);
    return;
  }
  if (context === null) {
    deps.log.warn(`auto-recharge ${orgId}: orphan billing account (no such organization)`);
    return;
  }
  const emails = adminEmailsOf(context);
  if (!emails.length) {
    deps.log.warn(`auto-recharge ${orgId}: no active ORG_ADMIN to notify`);
    return;
  }
  counters.checked += 1;

  if (wantCharge && !blockers) {
    const mandateIssue = await subscriptionBlockers(deps, cfg.cashfreeSubscriptionId);
    if (mandateIssue) {
      counters.skipped += 1;
      deps.log.warn(`auto-recharge ${orgId}: charge skipped — ${mandateIssue}`);
    } else if (dryRun) {
      // Report what WOULD be charged — the monthly limit can shrink it — so a
      // dry run actually predicts the real run instead of the configured amount.
      const chargeable = recharge.chargeableAmountPaise(orgId, cfg, now);
      const clamped = chargeable < Math.round(Number(cfg.amountPaise) || 0);
      deps.log.info(`auto-recharge DRY RUN ${orgId} (${context.name}): would charge `
        + `${chargeable / 100} INR${clamped ? ' (clamped to the monthly limit)' : ''} `
        + `(balance ${account.balancePaise} paise), notify ${emails.length} admin(s)`);
    } else {
      const posted = await deps.rechargeApi.maybeAutoRecharge(orgId, now);
      if (posted && posted.entry) {
        counters.charged += 1;
        deps.log.info(`auto-recharge ${orgId} (${context.name}): charged `
          + `${Number(posted.entry.amountPaise) / 100} INR (ledger entry ${posted.entry.id})`);
      }
    }
  }

  if (dryRun || !alertSuspect(account)) return;
  // Alerts go to the ORG_ADMINs the org service just reported, overriding the
  // account's own channel config for THIS run only: the persisted notifyEmails
  // list is a stale copy of that same data.
  const refreshed = deps.storeApi.getBillingAccount(orgId) || account;
  const alertAccount = {
    ...refreshed,
    notifyChannels: { ...(refreshed.notifyChannels || {}), email: true },
    notifyEmails: emails,
  };
  const alerted = await deps.notifyApi.checkThresholdsAndNotify(alertAccount, { store: deps.storeApi });
  if (alerted !== null && alerted !== undefined) {
    counters.alerted += 1;
    deps.log.info(`billing alert ${orgId} (${context.name}): threshold ${alerted} paise, `
      + `${emails.length} admin(s) addressed`);
  }
}

/**
 * Candidates come from the billing store rather than the org list: an org only
 * reaches the charge path once it has enabled auto-recharge AND fallen below its
 * own threshold, and reaches the alert path once its balance touches any
 * configured threshold. The store is also the only place the mandate id and
 * amount live.
 */
function selectCandidates(storeApi) {
  return storeApi
    .listBillingAccounts()
    .filter((account) => account && account.id && UUID_RE.test(account.id))
    .filter((account) => chargeBelowThreshold(account) || alertSuspect(account))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  initStoreImpl = store.initStore,
  deps = {},
  now = Date.now(),
  logImpl = log,
  exit = (code) => process.exit(code),
} = {}) {
  const dryRun = truthy(env.BILLING_JOB_DRY_RUN) || argv.includes('--validate');
  const counters = { checked: 0, charged: 0, alerted: 0, skipped: 0 };
  const resolved = {
    storeApi: deps.storeApi || store,
    rechargeApi: deps.rechargeApi || recharge,
    notifyApi: deps.notifyApi || notify,
    cashfreeApi: deps.cashfreeApi || cashfreeClient,
    fetchBillingContext: deps.fetchBillingContext || fetchBillingContext,
    fetchImpl: deps.fetchImpl,
    idTokenHeader: deps.idTokenHeader,
    baseUrl: deps.baseUrl,
    token: deps.token,
    timeoutMs: deps.timeoutMs,
    log: logImpl,
  };
  const options = { deps: resolved, counters, dryRun, now };

  try {
    // Firestore-backed reads are synchronous against the hydrated mirror, so
    // nothing below may run before initStore() resolves.
    await initStoreImpl();
  } catch (err) {
    logImpl.error(`auto-recharge job: store init failed: ${err && err.message ? err.message : err}`);
    exit(1);
    return { ...counters, dryRun, fatal: 'store init failed' };
  }

  const candidates = selectCandidates(resolved.storeApi);
  logImpl.info(`auto-recharge job: ${candidates.length} candidate(s), dryRun=${dryRun}`);

  let errored = 0;
  for (const account of candidates) {
    try {
      await runCandidate(account.id, account, options);
    } catch (err) {
      // One org's failure must not abort the run: the rest are still owed an
      // hourly balance check. Only an ALL-failed run exits non-zero, so a single
      // bad tenant cannot burn the job's retries forever.
      errored += 1;
      logImpl.error(`auto-recharge ${account.id}: error — ${err && err.message ? err.message : err}`);
    }
  }

  const summary = { ...counters, dryRun };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  const code = candidates.length > 0 && errored === candidates.length ? 1 : 0;
  exit(code);
  return summary;
}

if (require.main === module) void main();

module.exports = {
  main,
  selectCandidates,
  chargeBelowThreshold,
  alertSuspect,
  rechargeBlockers,
  fetchBillingContext,
  UUID_RE,
};
