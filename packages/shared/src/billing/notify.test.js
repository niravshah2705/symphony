'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-notify-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.INITIAL_CREDIT_INR = '0';

const store = require('../store');
const ledger = require('./ledger');
const { checkThresholdsAndNotify, sendEmail } = require('./notify');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

function accountWith(balancePaise, thresholds = [10000, 0]) {
  ledger.ensureAccount('org-n');
  return store.upsertBillingAccount('org-n', {
    balancePaise,
    alertThresholdsPaise: thresholds,
    lastAlertedThresholdPaise: null,
    notifyChannels: { browser: true, email: false, slack: false },
  });
}

test('alerts on the first downward crossing and dedupes repeats at the same level', async () => {
  const account = accountWith(5000); // below 10000, above 0
  const crossed = await checkThresholdsAndNotify(account);
  assert.equal(crossed, 10000);
  assert.equal(store.getBillingAccount('org-n').lastAlertedThresholdPaise, 10000);
  // Still below 10000 but not below 0 → no re-alert.
  const again = await checkThresholdsAndNotify(store.getBillingAccount('org-n'));
  assert.equal(again, null);
});

test('escalates to the more severe threshold as the balance drops further', async () => {
  const account = store.upsertBillingAccount('org-n', { balancePaise: -100 });
  const crossed = await checkThresholdsAndNotify(account);
  assert.equal(crossed, 0); // exhausted
  assert.equal(store.getBillingAccount('org-n').lastAlertedThresholdPaise, 0);
});

test('re-arms after a recharge above the highest threshold', async () => {
  const account = store.upsertBillingAccount('org-n', { balancePaise: 20000 }); // above 10000
  const cleared = await checkThresholdsAndNotify(account);
  assert.equal(cleared, null);
  assert.equal(store.getBillingAccount('org-n').lastAlertedThresholdPaise, null);
  // Dropping low again should alert afresh.
  const acct2 = store.upsertBillingAccount('org-n', { balancePaise: 3000 });
  assert.equal(await checkThresholdsAndNotify(acct2), 10000);
});

test('no thresholds configured → never alerts', async () => {
  const account = accountWith(-9999, []);
  assert.equal(await checkThresholdsAndNotify(account), null);
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
