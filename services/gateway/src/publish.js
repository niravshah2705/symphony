'use strict';

const { addConversation, getAssumedRole } = require('@ai-fleet/shared/store');
const { publishRequest } = require('@ai-fleet/shared/messaging/publisher');
const { CONFIG } = require('@ai-fleet/shared/config');
const { asyncHandler } = require('@ai-fleet/shared/util');
const { requestContext } = require('./request-context');

/**
 * Gateway request publishers. Instead of proxying the two long-running request
 * submissions to the agent services, the gateway creates a conversation thread
 * (the SSE stream target), publishes the request to Pub/Sub, and returns the
 * conversationId the browser opens an EventSource against. Read-only agent
 * endpoints keep flowing through the reverse proxy.
 */

// POST /api/agent/enqueue — publish an enrichment planning request.
const enqueue = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  if (!projectId || projectId.length > 200) return res.status(400).json({ error: 'projectId is required.' });
  const projectName = typeof body.projectName === 'string' ? body.projectName.slice(0, 200) : projectId;
  const assumedRole = getAssumedRole();
  if (!assumedRole) return res.status(400).json({ error: 'Assume a role before enqueuing planner work.' });

  const context = requestContext(req);
  const conversation = addConversation({
    title: `Planner: ${projectName}`,
    orgId: context.organizationId || null,
    nativeProjectId: context.projectId || null,
  });
  await publishRequest(CONFIG.GCP.plannerTopic, {
    type: 'enqueue',
    projectId,
    projectName,
    assumedRole,
    conversationId: conversation.id,
    orgId: context.organizationId || null,
    nativeProjectId: context.projectId || null,
  });
  return res.status(202).json({ accepted: true, conversationId: conversation.id });
});

// POST /api/coder/run — publish a coder run request.
const coderRun = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const issueId = typeof body.issueId === 'string' ? body.issueId.trim() : '';
  if (!issueId) return res.status(400).json({ error: 'issueId is required.' });

  const context = requestContext(req);
  const conversation = addConversation({
    title: `Coder: ${issueId}`,
    orgId: context.organizationId || null,
    nativeProjectId: context.projectId || null,
  });
  await publishRequest(CONFIG.GCP.coderTopic, {
    issueId,
    conversationId: conversation.id,
    orgId: context.organizationId || null,
    nativeProjectId: context.projectId || null,
  });
  return res.status(202).json({ accepted: true, conversationId: conversation.id });
});

module.exports = { enqueue, coderRun };
