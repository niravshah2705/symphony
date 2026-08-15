'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');
const store = require('@ai-fleet/shared-core/store');
const { publishRequest } = require('@ai-fleet/shared-core/messaging/publisher');
const { asyncHandler } = require('@ai-fleet/shared-core/util');
const { PipelineAdmissionError, createPipelineAdmission } = require('./pipeline-admission');
const { requestContext } = require('./request-context');

/**
 * Compatibility adapters for the former self-contained planner/coder request
 * publishers. The rollout switch keeps their legacy publishers as the safe
 * default; once enabled they enter the same durable admission path as
 * POST /api/pipeline/runs. The planner compatibility action includes code and
 * test because the legacy coder label poller is intentionally disabled during
 * rollout; stopping at plan would strand the existing Run-now workflow.
 */

function requiredString(body, field, maxLength = 200) {
  const value = body && typeof body[field] === 'string' ? body[field].trim() : '';
  if (!value || value.length > maxLength) {
    throw new PipelineAdmissionError(`${field} is required.`, 400, 'invalid_pipeline_request');
  }
  return value;
}

function createCompatibilityHandlers({
  admission = createPipelineAdmission(),
  orchestratorEnabled = CONFIG.PIPELINE && CONFIG.PIPELINE.orchestratorEnabled === true,
  addConversation = store.addConversation,
  getAssumedRole = store.getAssumedRole,
  publish = publishRequest,
  plannerTopic = CONFIG.GCP.plannerTopic,
  coderTopic = CONFIG.GCP.coderTopic,
} = {}) {
  const enqueue = asyncHandler(async (req, res) => {
    if (!orchestratorEnabled) {
      const body = req.body || {};
      const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
      if (!projectId || projectId.length > 200) {
        return res.status(400).json({ error: 'projectId is required.' });
      }
      const projectName = typeof body.projectName === 'string' ? body.projectName.slice(0, 200) : projectId;
      const assumedRole = getAssumedRole();
      if (!assumedRole) {
        return res.status(400).json({ error: 'Assume a role before enqueuing planner work.' });
      }
      const context = requestContext(req);
      const conversation = addConversation({
        title: `Planner: ${projectName}`,
        orgId: context.organizationId || null,
        nativeProjectId: context.projectId || null,
      });
      await publish(plannerTopic, {
        type: 'enqueue',
        projectId,
        projectName,
        assumedRole,
        conversationId: conversation.id,
        orgId: context.organizationId || null,
        nativeProjectId: context.projectId || null,
        llmGateway: context.llmGateway || null,
      });
      return res.status(202).json({ accepted: true, conversationId: conversation.id });
    }
    const result = await admission.submit(req, {
      stages: ['plan', 'code', 'test'],
      title: (body) => `Planner: ${String(body.projectName || body.projectId || '').slice(0, 200)}`,
      adaptRequest: (body) => {
        const projectId = requiredString(body, 'projectId');
        const projectName = typeof body.projectName === 'string' && body.projectName.trim()
          ? body.projectName.trim().slice(0, 200)
          : projectId;
        const assumedRole = getAssumedRole();
        if (!assumedRole) {
          throw new PipelineAdmissionError(
            'Assume a role before enqueuing planner work.',
            400,
            'invalid_pipeline_request',
          );
        }
        return { projectId, projectName, assumedRole };
      },
    });
    return res.status(202).json(result);
  });

  const coderRun = asyncHandler(async (req, res) => {
    if (!orchestratorEnabled) {
      const body = req.body || {};
      const issueId = typeof body.issueId === 'string' ? body.issueId.trim() : '';
      if (!issueId) return res.status(400).json({ error: 'issueId is required.' });
      const context = requestContext(req);
      const conversation = addConversation({
        title: `Coder: ${issueId}`,
        orgId: context.organizationId || null,
        nativeProjectId: context.projectId || null,
      });
      await publish(coderTopic, {
        issueId,
        conversationId: conversation.id,
        orgId: context.organizationId || null,
        nativeProjectId: context.projectId || null,
        llmGateway: context.llmGateway || null,
      });
      return res.status(202).json({ accepted: true, conversationId: conversation.id });
    }
    const result = await admission.submit(req, {
      stages: ['code'],
      title: (body) => `Coder: ${String(body.issueId || '').slice(0, 200)}`,
      adaptRequest: (body) => ({ issueId: requiredString(body, 'issueId') }),
    });
    return res.status(202).json(result);
  });

  return { enqueue, coderRun };
}

module.exports = { createCompatibilityHandlers, requiredString };
