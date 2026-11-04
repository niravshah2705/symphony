'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG } = require('@ai-fleet/shared-core/config');
const trigger = require('@ai-fleet/shared-core/billing/recharge-trigger');

/**
 * The launcher is the only thing standing between one scheduler tick and a real
 * Cashfree charge, so its two decisions are pinned here: whether to launch at all
 * (cloud vs in-process) and what the Admin API call looks like. The HTTP surface is
 * covered by services/billing/src/app.test.js.
 */

function fakeClient(capture) {
  return {
    async runJob(request) {
      capture.request = request;
      return [{ name: 'projects/p/locations/r/jobs/j/executions/e' }];
    },
  };
}

test('isCloudJobEnabled: false under the local test profile (no Job, no Admin API)', () => {
  // CONFIG is frozen, so this asserts the ambient local-dev answer only: direct mode
  // or a missing GCP_PROJECT_ID must send the sweep in-process rather than trying to
  // launch a Job that does not exist.
  assert.equal(
    trigger.isCloudJobEnabled(),
    CONFIG.MESSAGING_MODE === 'pubsub' && Boolean(CONFIG.GCP.projectId),
  );
  assert.equal(trigger.isCloudJobEnabled(), false);
});

test('jobResourceName: v2 fully-qualified name from the configured knobs', () => {
  assert.match(trigger.jobResourceName('billing-auto-recharge'), /\/jobs\/billing-auto-recharge$/);
  assert.equal(
    trigger.jobResourceName('billing-auto-recharge'),
    `projects/${CONFIG.GCP.projectId}/locations/${CONFIG.GCP.region}/jobs/billing-auto-recharge`,
  );
});

test('buildOverrides: no env means no overrides block', () => {
  assert.equal(trigger.buildOverrides({}), undefined);
  assert.equal(trigger.buildOverrides(null), undefined);
  assert.deepEqual(trigger.buildOverrides({ BILLING_JOB_DRY_RUN: true }), {
    containerOverrides: [{ env: [{ name: 'BILLING_JOB_DRY_RUN', value: 'true' }] }],
  });
});

test('runRechargeJob: launches the configured job and returns the operation name', async () => {
  const capture = {};
  const result = await trigger.runRechargeJob({ client: fakeClient(capture) });
  assert.equal(result.execution, 'projects/p/locations/r/jobs/j/executions/e');
  assert.equal(result.job, trigger.jobResourceName(CONFIG.GCP.billingJobName));
  assert.equal(capture.request.name, result.job);
  assert.equal(capture.request.overrides, undefined);
});

test('runRechargeJob: a dry-run override reaches the container env', async () => {
  const capture = {};
  await trigger.runRechargeJob({
    client: fakeClient(capture),
    env: { BILLING_JOB_DRY_RUN: 'true' },
  });
  assert.deepEqual(capture.request.overrides.containerOverrides[0].env, [
    { name: 'BILLING_JOB_DRY_RUN', value: 'true' },
  ]);
});
