'use strict';

const { CONFIG } = require('../config');

/**
 * Cloud Run Job launcher for long-running coder work.
 *
 * A coder ticket can run for tens of minutes — longer than a Pub/Sub push ack
 * deadline — so coder-control launches a one-shot Cloud Run Job execution per
 * ticket (scale-to-zero, billed only while running) instead of processing it
 * inside the request. `ISSUE_ID` is passed as a container env override; the
 * worker entrypoint (services/coder/src/job.js) reads it and runs `runCoder`.
 *
 * Only used in the cloud path; local dev runs the coder in-process instead
 * (see `isCloudJobEnabled`).
 */

let client = null;
function getClient() {
  if (client) return client;
  const { JobsClient } = require('@google-cloud/run').v2;
  client = new JobsClient();
  return client;
}

/** True when we should launch a real Cloud Run Job (vs. run in-process locally). */
function isCloudJobEnabled() {
  return CONFIG.MESSAGING_MODE === 'pubsub' && Boolean(CONFIG.GCP.projectId);
}

function jobResourceName() {
  const { projectId, region, coderJobName } = CONFIG.GCP;
  return `projects/${projectId}/locations/${region}/jobs/${coderJobName}`;
}

/**
 * Start a coder-worker Job execution for one issue. Returns { execution }.
 * @param {{ issueId: string, env?: Record<string,string> }} params
 */
async function runCoderJob({ issueId, env = {} }) {
  const overrides = {
    containerOverrides: [
      {
        env: [
          { name: 'CODER_ROLE', value: 'worker' },
          { name: 'ISSUE_ID', value: String(issueId) },
          ...Object.entries(env).map(([name, value]) => ({ name, value: String(value) })),
        ],
      },
    ],
  };
  const [operation] = await getClient().runJob({ name: jobResourceName(), overrides });
  return { execution: operation && operation.name ? operation.name : null };
}

module.exports = { runCoderJob, isCloudJobEnabled, jobResourceName };
