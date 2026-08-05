'use strict';

/**
 * Cloud Run Job worker entrypoint (CODER_ROLE=worker).
 *
 * Launched once per ticket by coder-control. It reads ISSUE_ID (and optional
 * CONVERSATION_ID) from the environment, runs the coder to completion — this is
 * the long-running work that would exceed a Pub/Sub push ack deadline — and
 * exits. Progress streams to the conversation SSE via publishEvent (Firestore).
 */

const { initStore } = require('@ai-fleet/shared/store');
const log = require('@ai-fleet/shared/logger');
const { runTicketInProcess } = require('./run-ticket');

async function main() {
  const issueId = String(process.env.ISSUE_ID || '').trim();
  const conversationId = process.env.CONVERSATION_ID ? String(process.env.CONVERSATION_ID) : null;
  if (!issueId) {
    log.error('coder-worker: ISSUE_ID env is required');
    process.exit(2);
    return;
  }
  await initStore();
  log.info(`coder-worker starting for issue ${issueId}`);
  try {
    await runTicketInProcess({ issueId, conversationId, blocking: true });
    log.info(`coder-worker finished issue ${issueId}`);
    process.exit(0);
  } catch (err) {
    log.error(`coder-worker failed for ${issueId}: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

main();
