'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const { SENTINEL_TOKEN } = require('@ai-fleet/shared/egress');
const log = require('@ai-fleet/shared/logger');
const store = require('@ai-fleet/shared/store');
const linear = require('@ai-fleet/shared/linear');
const {
  generatePlan,
  generateIssuesForMilestones,
} = require('@ai-fleet/shared/agent/plan');
const {
  applyPlan,
  applyIssuesForMilestones,
  applyAiplanned,
  applyAifail,
} = require('@ai-fleet/shared/agent/apply');
const {
  StageExecutionError,
  assertLinearProjectScope,
  resolveStageAgent,
} = require('@ai-fleet/shared/agent/pipeline-stage-runtime');
const {
  createStageCommandHandler,
  createStageResultPublisher,
  pipelineStageAuth,
} = require('@ai-fleet/shared/agent/pipeline-stage-service');
const { redactSecrets } = require('@ai-fleet/shared/agent/tools/exec');
const { runWithWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 200 ? id : '';
}

function linearProjectId(command) {
  const request = (command && command.input && command.input.request) || {};
  const workItem = (command && command.preflight && command.preflight.workItem) || request.workItem || {};
  return cleanId(
    workItem.linearProjectId
      || workItem.projectId
      || request.linearProjectId
      || request.projectId,
  );
}

function linearAccessKey(settings) {
  const configured = String((settings && settings.linearApiKey) || '');
  return configured || (CONFIG.EGRESS_PROXY_URL ? SENTINEL_TOKEN : '');
}

function planningKeys(agent) {
  const settings = agent.settings || {};
  return {
    langsmithApiKey: settings.langsmithApiKey,
    langsmithTracing: settings.langsmithTracing,
    langsmithProject: settings.langsmithProject,
    langsmithEndpoint: settings.langsmithEndpoint,
    agentRuntime: agent.harness,
    workflowPattern: agent.workflowPattern,
    requestHarnesses: { plan: agent.harness },
  };
}

function safeText(value, max = 2_000) {
  return redactSecrets(String(value || '')).trim().slice(0, max);
}

function publicSummary(value) {
  const summary = plainObject(value) ? value : {};
  return {
    milestonesCreated: Number.isSafeInteger(summary.milestonesCreated) ? summary.milestonesCreated : 0,
    issuesCreated: Number.isSafeInteger(summary.issuesCreated) ? summary.issuesCreated : 0,
    dependenciesCreated: Number.isSafeInteger(summary.dependenciesCreated) ? summary.dependenciesCreated : 0,
    warnings: (Array.isArray(summary.warnings) ? summary.warnings : [])
      .slice(0, 100)
      .map((warning) => safeText(warning, 1_000)),
    ...(summary.resumed === true ? { resumed: true } : {}),
  };
}

function publicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 1_000);
  } catch (_) {
    return null;
  }
}

function publicWorkItems(project, exactIssueIds = []) {
  const issues = project && project.issues && Array.isArray(project.issues.nodes)
    ? project.issues.nodes
    : [];
  const open = issues.filter((issue) => {
    const type = issue && issue.state && issue.state.type;
    return issue && issue.id && type !== 'completed' && type !== 'canceled';
  });
  const allowed = new Set(
    (Array.isArray(exactIssueIds) ? exactIssueIds : [])
      .map((id) => cleanId(id))
      .filter(Boolean),
  );
  return open
    .filter((issue) => allowed.has(issue.id))
    .sort((left, right) => (
      String(left.identifier || left.id).localeCompare(String(right.identifier || right.id))
    ))
    .slice(0, 250)
    .map((issue) => ({
      id: safeText(issue.id, 200),
      identifier: safeText(issue.identifier || issue.id, 200),
      title: safeText(issue.title, 500),
      linearProjectId: safeText(project.id, 200),
      projectName: safeText(project.name, 500),
    }));
}

function stageFailure(code, message, output = {}) {
  return {
    status: 'failed',
    output,
    error: { code, message, retryable: false },
  };
}

/** Execute one admitted planning command to a terminal result. The initiating
 * user's effective policy and exact harness/provider/model are consumed only
 * from the immutable preflight snapshot; no live policy lookup is performed. */
async function executePlanningStage(command, dependencies = {}) {
  if (!command || command.stage !== 'plan') {
    throw new StageExecutionError('A plan StageCommand is required.', 'invalid_plan_command');
  }
  const projectId = linearProjectId(command);
  if (!projectId) {
    throw new StageExecutionError(
      'Planning requires a snapshotted Linear project id.',
      'linear_project_required',
    );
  }

  const storeImpl = dependencies.store || store;
  assertLinearProjectScope(command, projectId, storeImpl);
  const linearImpl = dependencies.linear || linear;
  const resolveAgent = dependencies.resolveStageAgent || resolveStageAgent;
  const generatePlanImpl = dependencies.generatePlan || generatePlan;
  const generateIssuesImpl = dependencies.generateIssuesForMilestones || generateIssuesForMilestones;
  const applyPlanImpl = dependencies.applyPlan || applyPlan;
  const applyIssuesImpl = dependencies.applyIssuesForMilestones || applyIssuesForMilestones;
  const applyAiplannedImpl = dependencies.applyAiplanned || applyAiplanned;
  const applyAifailImpl = dependencies.applyAifail || applyAifail;
  const step = typeof dependencies.step === 'function' ? dependencies.step : () => {};
  const agent = await resolveAgent(
    command,
    { role: 'thinking', workflowStage: 'planning' },
    { ...dependencies, store: storeImpl, step },
  );
  const apiKey = linearAccessKey(agent.settings);
  if (!apiKey) {
    throw new StageExecutionError('Linear access is unavailable to the planner.', 'linear_not_configured');
  }
  const config = plainObject(dependencies.config)
    ? dependencies.config
    : storeImpl.getAgentConfig();
  const request = (command.input && command.input.request) || {};
  const assumedRole = plainObject(request.assumedRole) ? request.assumedRole : null;
  const { project, milestones } = await linearImpl.getMilestonesWithIssueCounts(apiKey, projectId);
  const runKeys = planningKeys(agent);
  const policySettings = {
    effectivePolicy: agent.effectivePolicy,
    orgId: command.organizationId,
    nativeProjectId: command.projectId,
  };
  let summary;
  let traceUrl = null;

  if (milestones.length > 0) {
    const missing = milestones.filter((milestone) => milestone.issueCount === 0);
    summary = {
      milestonesCreated: 0,
      issuesCreated: 0,
      dependenciesCreated: 0,
      warnings: [],
      resumed: true,
    };
    if (missing.length && config.createIssues) {
      const generated = await generateIssuesImpl({
        project,
        milestones: missing,
        config,
        llm: agent.llm,
        keys: runKeys,
        onStep: step,
      });
      summary = await applyIssuesImpl(apiKey, {
        project,
        milestones: missing,
        generated: generated.milestones,
        config,
        onStep: step,
      });
      traceUrl = generated.traceUrl || null;
    }
    await applyAiplannedImpl(apiKey, { project, onStep: step });
  } else {
    const generated = await generatePlanImpl({
      project,
      assumedRole,
      config,
      llm: agent.llm,
      keys: runKeys,
      onStep: step,
      settings: policySettings,
    });
    traceUrl = generated.traceUrl || null;
    if (!generated.viable) {
      await applyAifailImpl(apiKey, { project, reason: generated.reason, onStep: step });
      const reason = safeText(generated.reason) || 'The project is not viable.';
      return stageFailure('planning_not_viable', reason, {
        summary: { viable: false, reason },
        selectedHarness: agent.harness,
        harness: agent.harness,
        provider: agent.llm.provider,
        model: agent.llm.model,
      });
    }
    summary = await applyPlanImpl(apiKey, {
      project,
      plan: generated.plan,
      assumedRole,
      config,
      onStep: step,
    });
    await applyAiplannedImpl(apiKey, { project, onStep: step });
  }

  const after = await linearImpl.getProjectIssues(apiKey, projectId);
  const workItems = publicWorkItems(after, summary && summary.createdIssueIds);
  const explicitWorkItem = command.preflight && command.preflight.workItem;
  const hasExplicitWorkItem = Boolean(explicitWorkItem && cleanId(
    explicitWorkItem.issueId || explicitWorkItem.id || explicitWorkItem.identifier,
  ));
  if (command.requestedStages.includes('code') && !hasExplicitWorkItem && workItems.length === 0) {
    return stageFailure(
      'planning_produced_no_work_items',
      'Planning completed without a deterministic coding work item.',
      { summary: publicSummary(summary), workItems: [] },
    );
  }
  return {
    status: 'succeeded',
    output: {
      summary: publicSummary(summary),
      workItems,
      linearProjectId: projectId,
      traceUrl: publicHttpsUrl(traceUrl),
      selectedHarness: agent.harness,
      harness: agent.harness,
      provider: agent.llm.provider,
      model: agent.llm.model,
    },
  };
}

function inCommandWorkspace(operation, initStore = store.initStore) {
  return (command, ...args) => runWithWorkspaceContext({
    organizationId: command.organizationId,
    projectId: command.projectId,
  }, async () => {
    await initStore();
    return operation(command, ...args);
  });
}

function createPlannerPipelineRouter(options = {}) {
  const initStore = options.initStore || store.initStore;
  const execute = inCommandWorkspace(options.execute || executePlanningStage, initStore);
  const publish = options.publish || createStageResultPublisher(options.publisherOptions);
  const handler = createStageCommandHandler({
    stage: 'plan',
    execute,
    publish,
    log: options.logger || log,
    executionStore: options.executionStore,
    env: options.env,
    now: options.now,
    firestoreFactory: options.firestoreFactory,
  });
  const internalAuth = options.internalAuth || pipelineStageAuth({ mode: 'direct' });
  const pushMiddleware = options.pushAuth || pipelineStageAuth({ mode: CONFIG.MESSAGING_MODE });
  const router = express.Router();
  router.post('/internal/pipeline/stage', internalAuth, handler);
  router.post('/pubsub/pipeline-stage', pushMiddleware, handler);
  return router;
}

module.exports = {
  createPlannerPipelineRouter,
  executePlanningStage,
  inCommandWorkspace,
  linearProjectId,
  planningKeys,
  publicWorkItems,
};
