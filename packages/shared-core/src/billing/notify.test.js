'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'core-billing-notify-'));
process.env.SOFTWARE_FACTORY_DATA_DIR = TMP_DIR;
process.env.INITIAL_CREDIT_INR = '0';

const store = require('../store');
const ledger = require('./ledger');
const { checkThresholdsAndNotify, sendEmail } = require('./notify');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

function accountWith(orgId, thresholds = [10000, 0]) {
  ledger.ensureAccount(orgId);
  return store.upsertBillingAccount(orgId, {
    alertThresholdsTokenCredits: thresholds,
    lastAlertedThresholdTokenCredits: null,
    notifyChannels: { browser: true, email: false, slack: false },
  });
}

// Regression: this function used to read account.alertThresholdsInr (an API
// projection field that is never persisted) and fall back to a CONFIG key that
// does not exist, so every billing tick threw a TypeError that the sweep
// swallowed into a warning.
test('a freshly seeded account alerts without throwing', async () => {
  const seeded = ledger.ensureAccount('org-n-seeded');
  assert.deepEqual(seeded.alertThresholdsTokenCredits, [10000, 0]);
  assert.equal(await checkThresholdsAndNotify(seeded, { balanceTokenCredits: 5000 }), 10000);
});

test('alerts on the first downward crossing and dedupes repeats at the same level', async () => {
  const account = accountWith('org-n'); // below 10000, above 0
  assert.equal(await checkThresholdsAndNotify(account, { balanceTokenCredits: 5000 }), 10000);
  assert.equal(store.getBillingAccount('org-n').lastAlertedThresholdTokenCredits, 10000);
  // Still below 10000 but not below 0 → no re-alert.
  assert.equal(await checkThresholdsAndNotify(store.getBillingAccount('org-n'), { balanceTokenCredits: 4000 }), null);
});

test('escalates to the more severe threshold as the balance drops further', async () => {
  const crossed = await checkThresholdsAndNotify(store.getBillingAccount('org-n'), { balanceTokenCredits: -100 });
  assert.equal(crossed, 0); // exhausted
  assert.equal(store.getBillingAccount('org-n').lastAlertedThresholdTokenCredits, 0);
});

test('re-arms after a recharge above the highest threshold', async () => {
  const account = store.getBillingAccount('org-n');
  assert.equal(await checkThresholdsAndNotify(account, { balanceTokenCredits: 20000 }), null);
  assert.equal(store.getBillingAccount('org-n').lastAlertedThresholdTokenCredits, null);
  // Dropping low again should alert afresh.
  assert.equal(await checkThresholdsAndNotify(store.getBillingAccount('org-n'), { balanceTokenCredits: 3000 }), 10000);
});

test('no thresholds configured → never alerts', async () => {
  const account = accountWith('org-n-bare', []);
  assert.equal(await checkThresholdsAndNotify(account, { balanceTokenCredits: -9999 }), null);
});

// The balance is an argument, never a stored field: this module has no balance to
// read, and the gate's `unknown` must not degrade into "₹0.00, add credits".
test('no balance to compare means no alert, whatever the account says', async () => {
  const account = accountWith('org-n-unknown');
  for (const balance of [null, undefined, NaN, 'not a number']) {
    assert.equal(await checkThresholdsAndNotify(account, { balanceTokenCredits: balance }), null,
      `balance ${String(balance)} must alert on nothing`);
  }
  assert.equal(store.getBillingAccount('org-n-unknown').lastAlertedThresholdTokenCredits, null,
    'a skipped comparison must not consume the dedupe marker');
  // The same account does alert once a number arrives.
  assert.equal(await checkThresholdsAndNotify(store.getBillingAccount('org-n-unknown'), { balanceTokenCredits: 100 }), 10000);
});

test('billing email publishes only the allow-listed central email contract', async () => {
  const jobs = [];
  const sent = await sendEmail(
    { orgId: 'org-n', title: 'Billing balance low', message: 'Balance is low.' },
    ['owner@example.com'],
    { topic: 'email-delivery', publishRequest: async (topic, job) => jobs.push({ topic, job }) },
  );
  assert.equal(sent, true);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].topic, 'email-delivery');
  assert.equal(jobs[0].job.template, 'billing_alert');
  assert.equal(jobs[0].job.to, 'owner@example.com');
  assert.match(jobs[0].job.idempotencyKey, /^billing:[0-9a-f-]+$/);
  assert.deepEqual(jobs[0].job.variables, {
    subject: 'Billing balance low',
    message: 'Balance is low.',
    orgId: 'org-n',
  });
});

test('the crossing emits the one alertable line Cloud Logging turns into a metric', async () => {
  // observability.tf counts `jsonPayload.meta.event="balance_threshold_crossed"`
  // per threshold value, so the shape of this line is an interface: a renamed
  // field or a numeric threshold silently deletes an alert nobody notices is gone.
  const logger = require('../logger');
  const lines = [];
  const origWarn = logger.warn;
  const origError = logger.error;
  logger.warn = (message, meta) => lines.push({ severity: 'warn', message, meta });
  logger.error = (message, meta) => lines.push({ severity: 'error', message, meta });
  try {
    const account = accountWith('org-line');
    assert.equal(await checkThresholdsAndNotify(account, { balanceTokenCredits: 9000 }), 10000);
    assert.equal(await checkThresholdsAndNotify(store.getBillingAccount('org-line'), { balanceTokenCredits: -1 }), 0);
    // A repeat at the same level dedupes, so the metric must not count it twice.
    assert.equal(await checkThresholdsAndNotify(store.getBillingAccount('org-line'), { balanceTokenCredits: -2 }), null);
  } finally {
    logger.warn = origWarn;
    logger.error = origError;
  }

  const crossed = lines.filter((entry) => entry.meta && entry.meta.event === 'balance_threshold_crossed');
  assert.equal(crossed.length, 2, 'exactly one line per fresh crossing');
  const [low, exhausted] = crossed;
  assert.deepEqual(
    [low.severity, exhausted.severity],
    ['warn', 'error'],
    'exhaustion must be louder than lowness',
  );
  assert.deepEqual([low.meta.thresholdTokenCredits, exhausted.meta.thresholdTokenCredits], ['10000', '0']);
  for (const entry of crossed) {
    assert.equal(typeof entry.meta.thresholdTokenCredits, 'string');
    assert.equal(typeof entry.meta.balanceTokenCredits, 'string');
    assert.equal(entry.meta.orgId, 'org-line');
    // One contract with the scrubber that decides what reaches the sink: the
    // guard here is logger.isSecretKey, not a second regex that can drift from it
    // (and `balanceTokenCredits` is a unit word the loose substring match would
    // otherwise mask).
    assert.ok(Object.keys(entry.meta).every((key) => !logger.isSecretKey(key)),
      'a money event must not carry a credential-shaped field');
  }
});
