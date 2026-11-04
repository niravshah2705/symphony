'use strict';

const { CONFIG } = require('../config');
const log = require('../logger');

/**
 * Launcher for the billing auto-recharge Cloud Run Job.
 *
 * The hourly money sweep must not run inside the billing service's request: one pass
 * reads the org service once per candidate org and may post several Cashfree charges,
 * which outlives a Pub/Sub/Scheduler ack deadline and would leave the recharge
 * cooldown stamped half-written if the container were killed mid-pass. So the tick
 * handler launches a one-shot Job execution
 * (services/billing/src/auto-recharge-job.js) and returns — the same shape as
 * coder-control launching the coder-worker Job (packages/shared/src/messaging/jobs.js).
 *
 * Locally (MESSAGING_MODE=direct) there is no Job and no Admin API access, so callers
 * run the entrypoint in-process instead; `isCloudJobEnabled` is that switch.
 *
 * Overlapping executions are not locked out. A tick while one is running simply
 * starts a second pass; recharge.js derives a deterministic Cashfree `payment_id`
 * from the cooldown window, so the duplicate charge is rejected by Cashfree as a
 * replay rather than double-billing the org.
 */

let jobsClient = null;
function getJobsClient() {
  if (!jobsClient) {
    const { JobsClient } = require('@google-cloud/run').v2;
    jobsClient = new JobsClient();
  }
  return jobsClient;
}

/** True when a real Cloud Run Job execution should be launched (vs. in-process). */
function isCloudJobEnabled() {
  return CONFIG.MESSAGING_MODE === 'pubsub' && Boolean(CONFIG.GCP.projectId);
}

/** Fully-qualified v2 job name the Admin API expects. */
function jobResourceName(name = CONFIG.GCP.billingJobName) {
  const { projectId, region } = CONFIG.GCP;
  return `projects/${projectId}/locations/${region}/jobs/${name}`;
}

function buildOverrides(env) {
  const entries = Object.entries(env || {}).map(([name, value]) => ({ name, value: String(value) }));
  if (!entries.length) return undefined;
  return { containerOverrides: [{ env: entries }] };
}

/**
 * Start one auto-recharge execution.
 * @param {{ client?: object, name?: string, env?: Record<string, string> }} [params]
 * @returns {Promise<{ execution: string|null, job: string }>}
 */
async function runRechargeJob({ client = null, name = null, env = {} } = {}) {
  const job = name || jobResourceName();
  const request = { name: job };
  const overrides = buildOverrides(env);
  if (overrides) request.overrides = overrides;

  const [operation] = await (client || getJobsClient()).runJob(request);
  const execution = operation && operation.name ? operation.name : null;
  log.info(`auto-recharge Job execution started: ${execution || job}`);
  return { execution, job };
}

module.exports = { runRechargeJob, isCloudJobEnabled, jobResourceName, buildOverrides };
