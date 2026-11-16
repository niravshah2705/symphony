'use strict';

/**
 * The auto-recharge job: selection, the wallet read that every decision starts
 * from, the org-service read and the alert duty. Everything runs against a temp
 * file store and stubbed transports — no network, and no FlexPrice.
 *
 * What this suite is mostly about is what the job no longer does. It used to run
 * O(candidates) Cashfree mandate charges and post an `auto_recharge` credit into
 * the local ledger; the ledger stopped being spendable money, so a charge that
 * "succeeded" left the tenant billed and still blocked. The job now refuses the
 * charge with a named reason and alerts instead, and these tests hold both halves
 * of that: nothing is ever charged, and the org is still told.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-auto-recharge-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
// 1000 INR of opening credit so the dataset's initialCreditPaise is reproducible.
process.env.INITIAL_CREDIT_INR = '1000';

const store = require('@ai-fleet/shared-core/store');
const ledger = require('@ai-fleet/shared-core/billing/ledger');
const notify = require('@ai-fleet/shared-core/billing/notify');
const job = require('./auto-recharge-job');

const DATASET = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'test-data', 'sandbox-recharge.json'), 'utf8'),
);
const UUID_B = '6a1d5b22-3d4c-4f60-8b2c-1e2f3a4b5c6d';

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

/**
 * A dataset org under a fresh id, so tests share the store without sharing an org.
 */
function freshSpec(index) {
  return { ...DATASET.orgs[index], orgId: crypto.randomUUID() };
}

/**
 * The balance the wallet would report for a dataset org: the fixture spends
 * `debitPaise` off the opening credit. It used to be seeded through the ledger,
 * which is exactly the number this job is no longer allowed to read.
 */
function walletPaiseOf(spec) {
  return spec.account.initialCreditPaise - spec.account.debitPaise;
}

/** Seed one dataset org's CONFIG into the store. No balance: there is nowhere to put one. */
function seedOrg(spec) {
  ledger.ensureAccount(spec.orgId);
  return store.upsertBillingAccount(spec.orgId, {
    initialCreditPaise: spec.account.initialCreditPaise,
    autoRecharge: { ...ledger.DEFAULT_AUTO_RECHARGE, ...spec.account.autoRecharge },
    alertThresholdsPaise: spec.account.alertThresholdsPaise,
    notifyChannels: { browser: true, email: false, slack: false },
    notifyEmails: ['stale-list-should-be-ignored@example.com'],
  });
}

/** `deps.fundStatus` standing in for the FlexPrice wallet read. */
function walletStub(balances = {}) {
  const reads = [];
  const fundStatus = async (orgId) => {
    reads.push(orgId);
    const raw = balances[orgId];
    if (raw instanceof Error) throw raw;
    return { balancePaise: raw === undefined ? null : raw };
  };
  return { fundStatus, reads };
}

/** A fetch stub standing in for the org service: context per org, or 404/503. */
function orgContextStub(specs, overrides = {}) {
  const byOrg = new Map(specs.map((spec) => [spec.orgId, spec]));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const orgId = decodeURIComponent(String(url).split('/orgs/')[1].split('/')[0]);
    const forced = overrides[orgId];
    if (forced && forced.status) {
      return { ok: false, status: forced.status, json: async () => ({ detail: 'forced' }) };
    }
    const spec = byOrg.get(orgId);
    if (!spec) return { ok: false, status: 404, json: async () => ({ detail: 'org not found' }) };
    const admins = forced && forced.admins !== undefined ? forced.admins : spec.admins;
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: spec.orgId, name: spec.name, slug: spec.slug, admins }),
    };
  };
  return { fetchImpl, calls };
}

/**
 * Run the job with its candidate list scoped to `specs`. Every test creates its
 * own orgs, but the store is shared and a previous fixture stays a legitimate
 * candidate; scoping selection here is what makes the assertions per-test
 * instead of suite-order-dependent.
 */
function runJob({ specs = [], env = {}, wallet, deps = {}, initStoreImpl } = {}) {
  const exitCodes = [];
  const alerts = [];
  const balances = {};
  for (const spec of specs) balances[spec.orgId] = walletPaiseOf(spec);
  const stub = wallet || walletStub(balances);
  const storeApi = specs.length ? {
    listBillingAccounts: () => specs.map((spec) => store.getBillingAccount(spec.orgId)).filter(Boolean),
    getBillingAccount: (orgId) => store.getBillingAccount(orgId),
    upsertBillingAccount: (orgId, patch) => store.upsertBillingAccount(orgId, patch),
  } : store;
  return job.main({
    env,
    argv: [],
    initStoreImpl: initStoreImpl || (async () => {}),
    logImpl: { info() {}, warn() {}, error() {} },
    exit: (code) => exitCodes.push(code),
    deps: {
      storeApi,
      fundStatus: stub.fundStatus,
      notifyApi: {
        checkThresholdsAndNotify: async (account, options) => {
          alerts.push({ account, balancePaise: options.balancePaise });
          return null;
        },
      },
      ...deps,
    },
  }).then((summary) => ({ summary, exitCodes, alerts, walletReads: stub.reads }));
}

/** The usual deps for a run that reaches the org service. */
function transportDeps(org) {
  return { fetchImpl: org.fetchImpl, baseUrl: 'https://org.test', token: 's2s-token' };
}

// --- selection -----------------------------------------------------------------

test('candidates come from config, because the balance is not in the store', () => {
  const accounts = [
    // Opted in: a charge candidate whatever its wallet says.
    { id: UUID_B, autoRecharge: { enabled: true, mode: 'percentage', thresholdPercent: 20, amountPaise: 25000 } },
    // Solvent-looking on paper, but it has thresholds, so it is an alert candidate.
    { id: '8c3f7d44-5f6e-4b82-ad4e-3a4b5c6d7e8f', alertThresholdsPaise: [10000, 0], autoRecharge: { enabled: false } },
    // Asked for nothing: no opt-in, no thresholds.
    { id: '7b2e6c33-4e5d-4a71-9c3d-2f3a4b5c6d7e', autoRecharge: { enabled: false }, alertThresholdsPaise: [] },
    // The shared stack's pseudo-org has no tenant to validate and no admin to notify.
    { id: '__shared__', autoRecharge: { enabled: true, thresholdPaise: 40000 } },
  ];
  const selected = job.selectCandidates({ listBillingAccounts: () => accounts }).map((a) => a.id);
  assert.deepEqual(selected, [UUID_B, '8c3f7d44-5f6e-4b82-ad4e-3a4b5c6d7e8f']);
});

test('a balance this job cannot read triggers neither a charge nor an alert', () => {
  const optedIn = { autoRecharge: { enabled: true, mode: 'amount', thresholdPaise: 40000 } };
  for (const balance of [null, undefined]) {
    assert.equal(job.chargeBelowThreshold(optedIn, balance), false, `unknown balance ${String(balance)} is not a trigger`);
    assert.equal(job.alertSuspect({ alertThresholdsPaise: [10000, 0] }, balance), false);
  }
  assert.equal(job.chargeBelowThreshold(optedIn, 39999), true);
  assert.equal(job.chargeBelowThreshold(optedIn, 40000), false, 'the trigger is strictly below');
  assert.equal(job.chargeBelowThreshold({ autoRecharge: { enabled: false, thresholdPaise: 40000 } }, 1), false,
    'an org that declined is never a charge candidate, however dry its wallet');
  assert.equal(job.alertSuspect({ alertThresholdsPaise: [10000, 0] }, 10001), false);
  assert.equal(job.alertSuspect({ alertThresholdsPaise: [] }, 1), false, 'no thresholds configured, nothing to cross');
});

// --- the charge duty: reported, never executed -----------------------------------

test('a below-trigger org is reported due and charged nothing', async () => {
  const spec = freshSpec(0); // amount mode, trigger 40000, wallet 12000
  seedOrg(spec);
  const org = orgContextStub([spec]);

  const { summary, exitCodes, alerts } = await runJob({ specs: [spec], deps: transportDeps(org) });

  assert.equal(summary.due, 1);
  assert.equal(summary.checked, 1);
  assert.equal(exitCodes[exitCodes.length - 1], 0);
  // The reason is the point of the line an operator reads: which half is missing.
  assert.equal(job.rechargeIsNotChargeable(spec.account.autoRecharge),
    'the mandate is not settled into the FlexPrice wallet; add credits from the billing UI');
  // The alert duty still runs, so the tenant is told rather than merely logged.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].balancePaise, 12000, 'the alert compares against the wallet number');
  assert.deepEqual(alerts[0].account.notifyEmails, ['ops@amount.sandbox.test'],
    'recipients come from the org service, not the account’s stale list');
  assert.equal(alerts[0].account.notifyChannels.email, true);
  // The S2S call is the org service's internal route, token-gated.
  assert.match(org.calls[0].url, new RegExp(`/api/v1/internal/orgs/${spec.orgId}/billing-context$`));
  assert.equal(org.calls[0].headers['x-internal-token'], 's2s-token');
});

test('percentage mode compares the wallet against a share of the opening credit', async () => {
  const spec = freshSpec(1); // 20% of 100000 = 20000; wallet 15000 → due
  seedOrg(spec);
  const org = orgContextStub([spec]);

  const { summary } = await runJob({ specs: [spec], deps: transportDeps(org) });

  assert.equal(summary.due, 1);
  // Raise the wallet above the trigger and the same org is no longer due.
  const { summary: funded } = await runJob({
    specs: [spec],
    wallet: walletStub({ [spec.orgId]: 25000 }),
    deps: transportDeps(org),
  });
  assert.equal(funded.due, 0);
});

test('an org that declined auto-recharge is still alerted when its wallet drops', async () => {
  const spec = freshSpec(2); // enabled: false, wallet 100, thresholds [40000, 0]
  seedOrg(spec);
  const org = orgContextStub([spec]);

  const { summary, alerts } = await runJob({ specs: [spec], deps: transportDeps(org) });

  assert.equal(summary.due, 0);
  assert.equal(summary.checked, 1);
  assert.equal(alerts.length, 1, 'declining to be auto-charged is not declining to be told');
});

test('an unreadable wallet is neither a trigger nor a crossing', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  const { summary, alerts } = await runJob({
    specs: [spec],
    wallet: walletStub({}), // no balance for this org → the gate's `unknown`
    deps: transportDeps(org),
  });

  assert.equal(summary.unread, 1);
  assert.equal(summary.checked, 0);
  assert.equal(summary.due, 0);
  assert.equal(alerts.length, 0, 'a balance that could not be read must not be drawn as zero');
  assert.equal(org.calls.length, 0, 'nothing to validate against, so no org read either');
});

test('dry run reads, validates and reports due — then alerts nobody', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  const { summary, alerts } = await runJob({
    specs: [spec],
    env: { BILLING_JOB_DRY_RUN: 'true' },
    deps: {
      ...transportDeps(org),
      notifyApi: { checkThresholdsAndNotify: async () => { throw new Error('must not notify in a dry run'); } },
    },
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.due, 1);
  assert.equal(org.calls.length, 1, 'the org read still ran, so a dry run proves the wiring');
  assert.equal(alerts.length, 0);
});

// --- the org-service gates -------------------------------------------------------

test('an orphan billing account is skipped when the org service says 404', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec], { [spec.orgId]: { status: 404 } });

  const { summary, alerts } = await runJob({ specs: [spec], deps: transportDeps(org) });

  assert.equal(summary.checked, 0);
  assert.equal(summary.due, 0);
  assert.equal(alerts.length, 0);
});

test('a failing org-service call skips the org without failing the run', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec], { [spec.orgId]: { status: 503 } });

  const { summary, exitCodes } = await runJob({ specs: [spec], deps: transportDeps(org) });

  assert.equal(summary.due, 0);
  assert.equal(exitCodes[exitCodes.length - 1], 0, 'one bad tenant must not burn job retries');
});

test('an org with no active administrator is neither charged nor alerted', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec], { [spec.orgId]: { admins: [] } });

  const { summary, alerts } = await runJob({
    specs: [spec],
    deps: {
      ...transportDeps(org),
      notifyApi: { checkThresholdsAndNotify: async () => { throw new Error('nobody to notify'); } },
    },
  });

  assert.equal(summary.checked, 0);
  assert.equal(alerts.length, 0);
});

test('an org that is neither due nor a crossing costs no org-service read', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  const { walletReads } = await runJob({
    specs: [spec],
    wallet: walletStub({ [spec.orgId]: 90000 }), // above the 40000 trigger and the 40000/0 thresholds
    deps: transportDeps(org),
  });

  assert.equal(walletReads.length, 1, 'the balance is one read per candidate');
  assert.equal(org.calls.length, 0, 'the S2S read is only for an org that needs something');
});

// --- the alert duty, end to end through the real notifier ------------------------

test('a real threshold crossing persists lastAlertedThresholdPaise', async () => {
  const spec = freshSpec(2);
  seedOrg(spec);
  store.upsertBillingAccount(spec.orgId, { lastAlertedThresholdPaise: null });
  const org = orgContextStub([spec]);

  const { summary } = await runJob({
    specs: [spec],
    deps: { ...transportDeps(org), notifyApi: notify },
  });

  assert.equal(summary.alerted, 1);
  assert.equal(summary.due, 0);
  // ₹1.00 of a 40000/0 policy has crossed the low level, not exhaustion.
  assert.equal(store.getBillingAccount(spec.orgId).lastAlertedThresholdPaise, 40000);
});

// --- the mandate reasons ---------------------------------------------------------

test('every reason a due recharge cannot be charged is named', () => {
  const base = { enabled: true, mode: 'amount', thresholdPaise: 40000, amountPaise: 50000 };
  assert.match(job.rechargeIsNotChargeable({ ...base }), /no ON_DEMAND subscription/);
  assert.match(job.rechargeIsNotChargeable({ ...base, cashfreeSubscriptionId: 'sub_x', amountPaise: 0 }),
    /not positive/);
  // A recorded, positive mandate is the case that still cannot be settled: the
  // charge would move money out and credit nothing.
  assert.match(job.rechargeIsNotChargeable({ ...base, cashfreeSubscriptionId: 'sub_x' }),
    /not settled into the FlexPrice wallet/);
});

// --- run-level behaviour ---------------------------------------------------------

test('a run where every org errored exits non-zero', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  const { summary, exitCodes } = await runJob({
    specs: [spec],
    wallet: walletStub({ [spec.orgId]: new Error('flexprice timeout') }),
    deps: transportDeps(org),
  });

  assert.equal(summary.due, 0);
  assert.equal(exitCodes[exitCodes.length - 1], 1, 'an all-failed run must be visible to the scheduler');
});

test('a store that cannot hydrate is fatal and touches nothing', async () => {
  const { summary, exitCodes } = await runJob({
    initStoreImpl: async () => { throw new Error('firestore unreachable'); },
  });

  assert.equal(summary.fatal, 'store init failed');
  assert.deepEqual(exitCodes, [1]);
});

// --- the shape of the job --------------------------------------------------------

test('the job holds no charge path and no 5-minute sweep reaches it', () => {
  // Two source gates, because both halves are "the thing that must not come back":
  // a charge call here would bill a tenant for credits nothing grants, and a
  // recharge on the billing tick re-charges far below the intended cadence.
  const jobSource = fs.readFileSync(path.join(__dirname, 'auto-recharge-job.js'), 'utf8');
  for (const banned of ['chargeSubscription', 'addLedgerEntry', 'maybeAutoRecharge', 'postEntry']) {
    assert.doesNotMatch(jobSource, new RegExp(banned), `the job must not touch ${banned}`);
  }
  const sweepSource = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'packages', 'shared-core', 'src', 'billing', 'sweep.js'),
    'utf8',
  );
  assert.doesNotMatch(sweepSource, /autoRecharge|require\('\.\/recharge'\)/,
    'the 5-minute sweep must not reach the auto-recharge logic');
});
