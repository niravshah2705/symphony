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
const { runWithWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');

async function main({
  env = process.env,
  initStoreImpl = initStore,
  runTicketImpl = runTicketInProcess,
  logImpl = log,
  exit = (code) => process.exit(code),
} = {}) {
  const issueId = String(env.ISSUE_ID || '').trim();
  const conversationId = env.CONVERSATION_ID ? String(env.CONVERSATION_ID) : null;
  const orgId = env.FLEET_ORG_ID ? String(env.FLEET_ORG_ID) : null;
  const nativeProjectId = env.AI_FLEET_PROJECT_CONTEXT
    ? String(env.AI_FLEET_PROJECT_CONTEXT)
    : null;
  if (!issueId) {
    logImpl.error('coder-worker: ISSUE_ID env is required');
    exit(2);
    return 2;
  }
  const contextInput = { organizationId: orgId, projectId: nativeProjectId };
  try {
    return await runWithWorkspaceContext(contextInput, async () => {
      // Dynamic Firestore workspaces must hydrate inside the selected ALS scope
      // before any synchronous store accessor runs.
      await initStoreImpl();
      logImpl.info(`coder-worker starting for issue ${issueId}`);
      await runTicketImpl({ issueId, conversationId, blocking: true, orgId, nativeProjectId });
      logImpl.info(`coder-worker finished issue ${issueId}`);
      exit(0);
      return 0;
    });
  } catch (err) {
    logImpl.error(`coder-worker failed for ${issueId}: ${err && err.message ? err.message : err}`);
    exit(1);
    return 1;
  }
}

if (require.main === module) void main();

module.exports = { main };
