'use strict';

/**
 * The auto-recharge job: selection, the validate-before-charge gates, the
 * org-service read and the ledger shape. Everything runs against a temp file
 * store and stubbed Cashfree / org-service transports — no network. The Cashfree
 * client is stubbed on the real module, because the job's validation gates and
 * shared-core/recharge both reach it there: stubbing only the job's injected copy
 * would let the two disagree and prove nothing.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-auto-recharge-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
// 1000 INR of seed credit so the dataset's initialCreditPaise is reproducible.
process.env.INITIAL_CREDIT_INR = '1000';

const store = require('@ai-fleet/shared-core/store');
const ledger = require('@ai-fleet/shared-core/billing/ledger');
const notify = require('@ai-fleet/shared-core/billing/notify');
const cashfreeClient = require('@ai-fleet/shared-core/billing/cashfree-client');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const job = require('./auto-recharge-job');

const DATASET = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'test-data', 'sandbox-recharge.json'), 'utf8'),
);
const UUID_B = '6a1d5b22-3d4c-4f60-8b2c-1e2f3a4b5c6d';

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

/**
 * A dataset org under a fresh id. Balances are ledger-derived, so two tests
 * cannot share one org: the second seed would debit on top of the first.
 */
function freshSpec(index) {
  return { ...DATASET.orgs[index], orgId: crypto.randomUUID() };
}

/** Seed one dataset org into the store: credit, debit, then its auto-recharge config. */
function seedOrg(spec) {
  ledger.ensureAccount(spec.orgId);
  assert.equal(
    spec.account.initialCreditPaise,
    CONFIG.BILLING.initialCreditPaise,
    `fixture seed credit for "${spec.label}" must match INITIAL_CREDIT_INR`,
  );
  ledger.postEntry(spec.orgId, {
    type: 'usage',
    amountPaise: -spec.account.debitPaise,
    description: 'synthetic sandbox usage',
  });
  return store.upsertBillingAccount(spec.orgId, {
    autoRecharge: { lastRechargedAt: null, lastAttemptedAt: null, ...spec.account.autoRecharge },
    alertThresholdsPaise: spec.account.alertThresholdsPaise,
    notifyChannels: { browser: true, email: false, slack: false },
    notifyEmails: ['stale-list-should-be-ignored@example.com'],
  });
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

/** Patch the REAL Cashfree client, so the job's gates and the charge agree. */
async function withCashfree(options, run) {
  const cfg = { subscriptionStatus: 'ACTIVE', paymentStatus: 'SUCCESS', configured: true, ...options };
  const charges = [];
  const originals = {
    getSubscription: cashfreeClient.getSubscription,
    chargeSubscription: cashfreeClient.chargeSubscription,
  };
  const envKeys = ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY'];
  const envBackup = envKeys.map((key) => process.env[key]);
  if (cfg.configured) {
    process.env.CASHFREE_APP_ID = 'TEST_SANDBOX_APP_ID';
    process.env.CASHFREE_SECRET_KEY = 'cfsk_test_placeholder_never_a_real_key';
  } else {
    delete process.env.CASHFREE_APP_ID;
    delete process.env.CASHFREE_SECRET_KEY;
  }
  cashfreeClient.getSubscription = async (subscriptionId) => {
    if (cfg.subscriptionStatus instanceof Error) throw cfg.subscriptionStatus;
    return { subscription_id: subscriptionId, subscription_status: cfg.subscriptionStatus };
  };
  cashfreeClient.chargeSubscription = async ({ subscriptionId, paymentId, amountInr }) => {
    charges.push({ subscriptionId, paymentId, amountInr });
    if (cfg.paymentStatus instanceof Error) throw cfg.paymentStatus;
    return cfg.paymentStatus === null
      ? {}
      : { payment_status: cfg.paymentStatus, cf_payment_id: 'cf_test_1' };
  };
  try {
    return await run({ charges });
  } finally {
    cashfreeClient.getSubscription = originals.getSubscription;
    cashfreeClient.chargeSubscription = originals.chargeSubscription;
    envKeys.forEach((key, i) => {
      if (envBackup[i] === undefined) delete process.env[key];
      else process.env[key] = envBackup[i];
    });
  }
}

/**
 * Run the job with its candidate list scoped to `specs`. Every test creates its
 * own orgs, but the store is shared and a previous fixture stays a legitimate
 * candidate; scoping selection here is what makes the assertions per-test
 * instead of suite-order-dependent. The account objects come from the real
 * store, so nothing about the charge/ledger path is mocked.
 */
function runJob({ specs = [], env = {}, deps = {}, initStoreImpl, logs = null } = {}) {
  const exitCodes = [];
  const noAlert = { checkThresholdsAndNotify: async () => null };
  const storeApi = specs.length ? {
    listBillingAccounts: () => specs.map((spec) => store.getBillingAccount(spec.orgId)).filter(Boolean),
    getBillingAccount: (orgId) => store.getBillingAccount(orgId),
    upsertBillingAccount: (orgId, patch) => store.upsertBillingAccount(orgId, patch),
  } : store;
  return job.main({
    env,
    argv: [],
    initStoreImpl: initStoreImpl || (async () => {}),
    now: Date.now(),
    logImpl: logs || { info() {}, warn() {}, error() {} },
    exit: (code) => exitCodes.push(code),
    deps: { storeApi, notifyApi: noAlert, ...deps },
  }).then((summary) => ({ summary, exitCodes }));
}

/** A log sink that records what the job said, for gate-reason assertions. */
function captureLogs() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    text: (level) => lines[level].join('\n'),
    logImpl: {
      info: (msg) => lines.info.push(String(msg)),
      warn: (msg) => lines.warn.push(String(msg)),
      error: (msg) => lines.error.push(String(msg)),
    },
  };
}

/** The usual deps for a charged run: real recharge/notify, stubbed org service. */
function transportDeps(org) {
  return { fetchImpl: org.fetchImpl, baseUrl: 'https://org.test', token: 's2s-token' };
}

// --- selection -----------------------------------------------------------------

test('only opted-in, below-threshold orgs are selected', () => {
  const accounts = [
    {
      id: UUID_B,
      balancePaise: 15000,
      initialCreditPaise: 100000,
      autoRecharge: { enabled: true, mode: 'percentage', thresholdPercent: 20, amountPaise: 25000 },
    },
    {
      id: '8c3f7d44-5f6e-4b82-ad4e-3a4b5c6d7e8f',
      balancePaise: 90000,
      initialCreditPaise: 100000,
      autoRecharge: { enabled: true, mode: 'amount', thresholdPaise: 40000, amountPaise: 50000 },
    },
    { id: '7b2e6c33-4e5d-4a71-9c3d-2f3a4b5c6d7e', balancePaise: 100, autoRecharge: { enabled: false } },
    {
      id: '__shared__',
      balancePaise: 0,
      initialCreditPaise: 100000,
      autoRecharge: { enabled: true, mode: 'amount', thresholdPaise: 40000, amountPaise: 50000 },
    },
  ];
  const selected = job.selectCandidates({ listBillingAccounts: () => accounts }).map((a) => a.id);
  // The percentage org sits below 20% of its initial credit; the well-funded and
  // opted-out orgs are not; the shared pseudo-org has no tenant to validate.
  assert.deepEqual(selected, [UUID_B]);
  assert.equal(job.chargeBelowThreshold(accounts[1]), false);
  assert.equal(job.alertSuspect(accounts[1]), false);
});

test('an org with a configured alert threshold and a low balance is a candidate', () => {
  const account = { id: UUID_B, balancePaise: 5000, alertThresholdsPaise: [10000, 0] };
  assert.equal(job.chargeBelowThreshold(account), false);
  assert.equal(job.alertSuspect(account), true);
  assert.deepEqual(job.selectCandidates({ listBillingAccounts: () => [account] }).map((a) => a.id), [UUID_B]);
});

// --- the happy path, per mode ---------------------------------------------------

test('a below-threshold org in amount mode is charged once, with an auto_recharge ledger entry', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  await withCashfree({}, async ({ charges }) => {
    const { summary, exitCodes } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.charged, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(exitCodes[exitCodes.length - 1], 0);
    assert.equal(charges.length, 1, 'exactly one charge request');
    assert.equal(charges[0].subscriptionId, spec.account.autoRecharge.cashfreeSubscriptionId);
    assert.equal(charges[0].amountInr, spec.account.autoRecharge.amountPaise / 100);

    const rechargeEntry = store.listLedgerEntries({ orgId: spec.orgId }).find((e) => e.type === 'auto_recharge');
    assert.ok(rechargeEntry, 'the recharge is on the ledger with the canonical type');
    assert.equal(rechargeEntry.amountPaise, 50000);
    assert.equal(rechargeEntry.meta.simulated, false, 'a real charge is never reported as simulated');
    assert.equal(rechargeEntry.meta.cfPaymentId, 'cf_test_1');
    assert.equal(store.getBillingAccount(spec.orgId).balancePaise, 62000);
    assert.ok(store.getBillingAccount(spec.orgId).autoRecharge.lastRechargedAt, 'cooldown stamped');

    // The S2S call is the org service's internal route, token-gated.
    assert.match(org.calls[0].url, new RegExp(`/api/v1/internal/orgs/${spec.orgId}/billing-context$`));
    assert.equal(org.calls[0].headers['x-internal-token'], 's2s-token');
  });
});

test('percentage mode charges the configured top-up, not an absolute threshold', async () => {
  const spec = freshSpec(1);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.charged, 1);
    assert.equal(charges[0].amountInr, 250, spec.account.autoRecharge.amountPaise / 100);
    assert.equal(store.getBillingAccount(spec.orgId).balancePaise, 40000);
  });
});

test('an org that declined auto-recharge is never charged', async () => {
  const spec = freshSpec(2);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.charged, 0);
    assert.equal(charges.length, 0);
    assert.equal(store.listLedgerEntries({ orgId: spec.orgId }).some((e) => e.type === 'auto_recharge'), false);
  });
});

// --- the monthly limit -----------------------------------------------------------
// The hourly Job can top an org up ~720x a month. A monthly ceiling bounds that;
// these tests pin that the ceiling clamps rather than wastes a charge, and that
// a spent ceiling says so out loud.

test('a monthly limit clamps the charge to the room left instead of skipping it', async () => {
  const spec = freshSpec(3);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.charged, 1, 'the remaining room is still used');
    assert.equal(charges[0].amountInr, 200, '₹200 of the configured ₹500 top-up');
    const entry = store.listLedgerEntries({ orgId: spec.orgId }).find((e) => e.type === 'auto_recharge');
    assert.equal(entry.amountPaise, 20000, 'the ledger records what was charged');
    assert.equal(entry.meta.requestedPaise, 50000);
    assert.equal(entry.meta.monthlyLimitPaise, 20000);
    assert.equal(entry.meta.capApplied, true);
    assert.equal(store.getBillingAccount(spec.orgId).balancePaise, 32000);
  });
});

test('an exhausted monthly limit is reported as the skip reason', async () => {
  const spec = freshSpec(3);
  seedOrg(spec);
  // A manual top-up this month spends the whole ceiling: it counts toward the
  // limit, but is never itself blocked.
  ledger.postEntry(spec.orgId, { type: 'recharge', amountPaise: 20000, description: 'manual top-up' });
  const org = orgContextStub([spec]);
  const logs = captureLogs();

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({ specs: [spec], deps: transportDeps(org), logs: logs.logImpl });

    assert.equal(charges.length, 0, 'nothing is charged past the ceiling');
    assert.equal(summary.charged, 0);
    assert.equal(summary.skipped, 1);
    assert.match(logs.text('warn'), /monthly recharge limit reached \(20000 of 20000 paise used\)/);
  });
});

test('a dry run reports the amount it would actually charge', async () => {
  const spec = freshSpec(3);
  seedOrg(spec);
  const org = orgContextStub([spec]);
  const logs = captureLogs();

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({
      specs: [spec],
      env: { BILLING_JOB_DRY_RUN: 'true' },
      deps: transportDeps(org),
      logs: logs.logImpl,
    });

    assert.equal(charges.length, 0);
    assert.equal(summary.charged, 0);
    assert.match(logs.text('info'), /would charge 200 INR \(clamped to the monthly limit\)/);
  });
});

// --- the validate-before-charge gates -------------------------------------------

test('dry run validates end to end and charges nothing', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({
      specs: [spec],
      env: { BILLING_JOB_DRY_RUN: 'true' },
      deps: {
        ...transportDeps(org),
        notifyApi: { checkThresholdsAndNotify: async () => { throw new Error('must not notify in a dry run'); } },
      },
    });

    assert.equal(summary.dryRun, true);
    assert.equal(summary.charged, 0);
    assert.equal(charges.length, 0);
    assert.equal(org.calls.length, 1, 'the org read still ran, so a dry run proves the wiring');
    assert.equal(store.getBillingAccount(spec.orgId).balancePaise, 12000);
  });
});

test('a cancelled mandate is skipped instead of charged', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  await withCashfree({ subscriptionStatus: 'CANCELLED' }, async ({ charges }) => {
    const { summary } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.charged, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(charges.length, 0);
    assert.equal(store.getBillingAccount(spec.orgId).balancePaise, 12000, 'no phantom credit');
  });
});

test('an unsettled payment_status credits nothing and blocks a retry', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  await withCashfree({ paymentStatus: 'FAILED' }, async () => {
    const { summary } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.charged, 0);
    assert.equal(store.getBillingAccount(spec.orgId).balancePaise, 12000, 'a failed charge must not fund the wallet');
    assert.ok(store.getBillingAccount(spec.orgId).autoRecharge.lastAttemptedAt, 'attempt stamped');
  });

  // Second run, inside the cooldown: not even a charge request is issued.
  await withCashfree({ paymentStatus: 'SUCCESS' }, async ({ charges }) => {
    const { summary } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.skipped, 1);
    assert.equal(charges.length, 0);
  });
});

test('missing Cashfree credentials skip the charge but still alert the admins', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);
  const addressed = [];

  await withCashfree({ configured: false }, async ({ charges }) => {
    const { summary } = await runJob({
      specs: [spec],
      deps: {
        ...transportDeps(org),
        notifyApi: {
          checkThresholdsAndNotify: async (account) => {
            addressed.push(account);
            return 0;
          },
        },
      },
    });

    assert.equal(summary.charged, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.alerted, 1);
    assert.equal(charges.length, 0);
    // Recipients come from the org service, not the account's stale list.
    assert.deepEqual(addressed[0].notifyEmails, ['ops@amount.sandbox.test']);
    assert.equal(addressed[0].notifyChannels.email, true);
  });
});

test('an orphan billing account is skipped when the org service says 404', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec], { [spec.orgId]: { status: 404 } });

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.charged, 0);
    assert.equal(summary.checked, 0);
    assert.equal(charges.length, 0);
  });
});

test('a failing org-service call skips the org without failing the run', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec], { [spec.orgId]: { status: 503 } });

  await withCashfree({}, async ({ charges }) => {
    const { summary, exitCodes } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.charged, 0);
    assert.equal(charges.length, 0);
    assert.equal(exitCodes[exitCodes.length - 1], 0, 'one bad tenant must not burn job retries');
  });
});

test('an org with no active administrator is neither charged nor alerted', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec], { [spec.orgId]: { admins: [] } });

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({
      specs: [spec],
      deps: {
        ...transportDeps(org),
        notifyApi: { checkThresholdsAndNotify: async () => { throw new Error('nobody to notify'); } },
      },
    });

    assert.equal(summary.charged, 0);
    assert.equal(summary.alerted, 0);
    assert.equal(charges.length, 0);
  });
});

test('the cooldown gate is evaluated before any network call', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  store.upsertBillingAccount(spec.orgId, {
    autoRecharge: { ...spec.account.autoRecharge, lastRechargedAt: new Date().toISOString() },
    alertThresholdsPaise: [],
  });
  const org = orgContextStub([spec]);

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({ specs: [spec], deps: transportDeps(org) });

    assert.equal(summary.skipped, 1);
    assert.equal(charges.length, 0);
    assert.equal(org.calls.length, 0, 'no org read for an org that can neither be charged nor alerted');
  });
});

// --- the alert duty -------------------------------------------------------------

test('a real threshold crossing persists lastAlertedThresholdPaise', async () => {
  const spec = freshSpec(0);
  // Exhausted balance with auto-recharge OFF: an alert-only candidate.
  store.upsertBillingAccount(spec.orgId, {
    balancePaise: 0,
    initialCreditPaise: spec.account.initialCreditPaise,
    alertThresholdsPaise: spec.account.alertThresholdsPaise,
    lastAlertedThresholdPaise: null,
    notifyChannels: { browser: false, email: true, slack: false },
    autoRecharge: { ...spec.account.autoRecharge, enabled: false },
  });
  const org = orgContextStub([spec]);

  await withCashfree({}, async ({ charges }) => {
    const { summary } = await runJob({
      specs: [spec],
      deps: { ...transportDeps(org), notifyApi: notify },
    });

    assert.equal(summary.alerted, 1);
    assert.equal(summary.charged, 0);
    assert.equal(charges.length, 0);
    assert.equal(store.getBillingAccount(spec.orgId).lastAlertedThresholdPaise, 0);
  });
});

// --- run-level behaviour --------------------------------------------------------

test('a run where every org errored exits non-zero', async () => {
  const spec = freshSpec(0);
  seedOrg(spec);
  const org = orgContextStub([spec]);

  await withCashfree({}, async () => {
    const { summary, exitCodes } = await runJob({
      specs: [spec],
      deps: {
        ...transportDeps(org),
        rechargeApi: { maybeAutoRecharge: async () => { throw new Error('ledger write failed'); } },
      },
    });

    assert.equal(summary.charged, 0);
    assert.equal(exitCodes[exitCodes.length - 1], 1);
  });
});

test('a store that cannot hydrate is fatal and touches nothing', async () => {
  await withCashfree({}, async ({ charges }) => {
    const { summary, exitCodes } = await runJob({
      initStoreImpl: async () => { throw new Error('firestore unreachable'); },
    });

    assert.equal(summary.fatal, 'store init failed');
    assert.deepEqual(exitCodes, [1]);
    assert.equal(charges.length, 0);
  });
});

test('recharge is not reachable from the 5-minute sweep any more', () => {
  // The job owns the money path. If the sweep grew a recharge call back, this
  // suite's whole premise (hourly, validated, once per org) is undone.
  const sweepSource = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'packages', 'shared-core', 'src', 'billing', 'sweep.js'),
    'utf8',
  );
  assert.doesNotMatch(sweepSource, /maybeAutoRecharge/, 'sweep.js must not auto-recharge');
});
