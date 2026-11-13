'use strict';

/**
 * Cloud Run Job entrypoint: evaluate auto-recharge + balance alerts, hourly.
 *
 * This is the money path that deliberately does NOT run on the 5-minute billing
 * tick (see shared-core/billing/sweep.js). It is a one-shot process: select the
 * orgs that actually need attention, READ each one's balance from FlexPrice's
 * wallet, VALIDATE that a charge can legally and correctly happen, pull each
 * org's identity and administrator emails from the org service, and only then
 * charge and alert. Every guard is fail-closed — a skipped charge is a loud log
 * line, never a silent success — because the alternative is charging a tenant
 * that did not ask to be charged, or crediting a wallet for money that never
 * moved.
 *
 * Two independent duties per org: the CHARGE is guarded and only for orgs that
 * opted in, the ALERT is for anyone whose balance crossed a threshold. An org
 * that declined auto-recharge still has to be told it is running dry, and an org
 * whose charge was just refused needs to hear about it immediately.
 *
 * Both duties now start from a network read instead of a stored number, because
 * the number that decides them is `real_time_credit_balance` and not a local
 * balance. That makes the run O(candidates) wallet reads per hour — bounded by
 * the org count, and cheap measured (p50 5 ms), but it is why the selection step
 * filters on the org's own CONFIG (opted in, or has thresholds) before it spends
 * a read on the balance.
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
const gate = require('@ai-fleet/shared-core/billing/gate');

// Org ids are UUIDs (services/org scopes every document by one). Anything else —
// notably the shared stack's '__shared__' pseudo-org — has no org-service record
// to validate against and no administrator to notify, so it is never a candidate
// here. The shared stack's own usage is still visible on the billing dashboard.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * The balance both duties are decided on, in paise, or null when it is not known.
 * `unknown` is a state of this process's knowledge, not of the tenant's money: the
 * gate returns null when there is no wallet, the read failed, or enforcement is
 * off. Charging or alerting on any of those would act on a number we never read.
 */
async function walletBalancePaise(orgId, deps) {
  const fundStatus = deps.fundStatus || gate.ensureFundStatus;
  const status = await fundStatus(orgId);
  const raw = status && status.balancePaise;
  if (raw === null || raw === undefined) return null;
  const paise = Number(raw);
  return Number.isFinite(paise) ? paise : null;
}

/** Opted in and, at `balancePaise`, below its own (amount- or percentage-mode) trigger. */
function chargeBelowThreshold(account, balancePaise) {
  const cfg = (account && account.autoRecharge) || {};
  if (!cfg.enabled) return false;
  if (balancePaise === null || balancePaise === undefined) return false;
  return Number(balancePaise) < recharge.getEffectiveThresholdPaise(account, cfg);
}

/**
 * Has the balance reached the *highest* configured threshold at all. Whether this
 * specific crossing was already alerted is decided once, authoritatively, inside
 * notify.checkThresholdsAndNotify.
 */
function alertSuspect(account, balancePaise) {
  const thresholds = ((account && account.alertThresholdsPaise) || []).map(Number).filter(Number.isFinite);
  if (!thresholds.length) return false;
  if (balancePaise === null || balancePaise === undefined) return false;
  return Number(balancePaise) <= Math.max(...thresholds);
}

/**
 * Why a due recharge cannot be charged, in the customer's terms.
 *
 * This is the reason auto-recharge charges nothing today: the credit half of the
 * old path wrote an `auto_recharge` entry into the local ledger, and the local
 * ledger is no longer spendable money (`billing/recharge.js` — only
 * `recharge-settle.js` may credit, and it credits FlexPrice's wallet against a
 * quoted intent). Charging a mandate that then credits nothing is the worst
 * available outcome — the tenant pays and is still blocked — so the mandate is
 * not touched, and the org is alerted instead so it can recharge from the UI.
 *
 * The remaining gates are what a migrated path will have to answer, and they are
 * kept here as the shape of the check rather than as live code: the mandate must
 * be recorded on the account, positive, and outside its cooldown window.
 */
function rechargeIsNotChargeable(cfg) {
  if (!cfg.cashfreeSubscriptionId) return 'no ON_DEMAND subscription (mandate) on file';
  if (!(Number(cfg.amountPaise) > 0)) return 'recharge amount is not positive';
  return 'the mandate is not settled into the FlexPrice wallet; add credits from the billing UI';
}

function adminEmailsOf(context) {
  return (context.admins || [])
    .map((admin) => String(admin && admin.email || '').trim())
    .filter(Boolean);
}

async function runCandidate(orgId, account, opts) {
  const { deps, counters } = opts;
  const cfg = account.autoRecharge || {};

  // Both duties start from the same read. A balance this process could not read
  // is neither a trigger nor a crossing, and saying so is the only useful output.
  const balancePaise = await walletBalancePaise(orgId, deps);
  if (balancePaise === null) {
    counters.unread += 1;
    deps.log.warn(`auto-recharge ${orgId}: no wallet balance to decide on (no wallet, unreadable, or the gate is off) — nothing charged, nothing alerted`);
    return;
  }
  const due = chargeBelowThreshold(account, balancePaise);
  if (!due && !alertSuspect(account, balancePaise)) return;

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

  if (due) {
    counters.due += 1;
    const trigger = recharge.getEffectiveThresholdPaise(account, cfg);
    deps.log.warn(`auto-recharge ${orgId} (${context.name}): wallet is at ${balancePaise} paise, below the ${trigger} paise trigger, `
      + `but ${rechargeIsNotChargeable(cfg)}.`);
  }

  // A dry run stops here: it has read the balance, asked the org service and
  // reported the due verdict, which is the whole question `--validate` exists to
  // answer. Alerting from a rehearsal would email real admins.
  if (opts.dryRun) return;
  // Alerts go to the ORG_ADMINs the org service just reported, overriding the
  // account's own channel config for THIS run only: the persisted notifyEmails
  // list is a stale copy of that same data.
  const refreshed = deps.storeApi.getBillingAccount(orgId) || account;
  const alertAccount = {
    ...refreshed,
    notifyChannels: { ...(refreshed.notifyChannels || {}), email: true },
    notifyEmails: emails,
  };
  const alerted = await deps.notifyApi.checkThresholdsAndNotify(alertAccount, {
    store: deps.storeApi,
    balancePaise,
  });
  if (alerted !== null && alerted !== undefined) {
    counters.alerted += 1;
    deps.log.info(`billing alert ${orgId} (${context.name}): threshold ${alerted} paise, `
      + `${emails.length} admin(s) addressed`);
  }
}

/**
 * Candidates come from the billing store rather than the org list, filtered on the
 * org's own CONFIG — the balance is not in the store any more, so deciding it here
 * would mean a wallet read per account whether or not the org asked for anything.
 * An org reaches this job once it has opted into auto-recharge (charge duty) or
 * has any alert threshold configured (alert duty), and the balance read inside
 * `runCandidate` then decides whether either actually applies.
 */
function selectCandidates(storeApi) {
  return storeApi
    .listBillingAccounts()
    .filter((account) => account && account.id && UUID_RE.test(account.id))
    .filter((account) => (account.autoRecharge && account.autoRecharge.enabled)
      || ((account.alertThresholdsPaise || []).length > 0))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  initStoreImpl = store.initStore,
  deps = {},
  logImpl = log,
  exit = (code) => process.exit(code),
} = {}) {
  const dryRun = truthy(env.BILLING_JOB_DRY_RUN) || argv.includes('--validate');
  const counters = { checked: 0, due: 0, alerted: 0, unread: 0 };
  const resolved = {
    storeApi: deps.storeApi || store,
    notifyApi: deps.notifyApi || notify,
    fundStatus: deps.fundStatus || gate.ensureFundStatus,
    fetchBillingContext: deps.fetchBillingContext || fetchBillingContext,
    fetchImpl: deps.fetchImpl,
    idTokenHeader: deps.idTokenHeader,
    baseUrl: deps.baseUrl,
    token: deps.token,
    timeoutMs: deps.timeoutMs,
    log: logImpl,
  };
  const options = { deps: resolved, counters, dryRun };

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
  rechargeIsNotChargeable,
  walletBalancePaise,
  fetchBillingContext,
  UUID_RE,
};
