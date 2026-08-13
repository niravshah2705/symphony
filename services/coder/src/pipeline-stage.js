'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const { SENTINEL_TOKEN } = require('@ai-fleet/shared/egress');
const log = require('@ai-fleet/shared/logger');
const store = require('@ai-fleet/shared/store');
const linear = require('@ai-fleet/shared/linear');
const { repoParts } = require('@ai-fleet/shared/agent/workspace');
const { runPlannedCoderLocal } = require('@ai-fleet/shared/agent/coder');
const { startIssue, finishIssue } = require('@ai-fleet/shared/agent/apply');
const { parseVerdict } = require('@ai-fleet/shared/agent/coder-orchestrator');
const {
  StageExecutionError,
  assertLinearProjectScope,
  repositoryReference,
  resolveStageAgent,
} = require('@ai-fleet/shared/agent/pipeline-stage-runtime');
const {
  createStageCommandHandler,
  createStageResultPublisher,
  pipelineStageAuth,
} = require('@ai-fleet/shared/agent/pipeline-stage-service');
const { redactSecrets } = require('@ai-fleet/shared/agent/tools/exec');
const { validateMergeReceipt } = require('@ai-fleet/shared/agent/repository-broker');
const { runWithWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');

// Each completed work item can carry about 6 KiB of bounded public fields plus
// its full broker receipt. Four items reserve roughly 8 KiB beneath the 32 KiB
// StageResult output ceiling for stage metadata and JSON overhead, before any
// Linear/repository side effect occurs.
const MAX_PIPELINE_CODING_WORK_ITEMS = 4;

const PIPELINE_ISSUE_QUERY = `
  query PipelineCoderIssue($id: String!) {
    issue(id: $id) {
      id identifier title description url createdAt
      state { id name type }
      labels(first: 20) { nodes { id name } }
      project { id name }
      inverseRelations(first: 50) {
        nodes { type issue { id identifier createdAt state { type } } }
      }
    }
  }`;

function cleanId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 200 ? id : '';
}

function issueIdsFromCommand(command) {
  const request = (command && command.input && command.input.request) || {};
  const workItem = (command && command.preflight && command.preflight.workItem) || request.workItem || {};
  const explicit = cleanId(workItem.issueId || workItem.id || workItem.identifier || request.issueId);
  if (explicit) return [explicit];
  const prior = (Array.isArray(command && command.input && command.input.priorResults)
    ? command.input.priorResults
    : []).find((candidate) => (
      candidate && candidate.stage === 'plan' && candidate.status === 'succeeded'
    ));
  const workItems = prior && prior.output && Array.isArray(prior.output.workItems)
    ? prior.output.workItems
    : [];
  const result = [];
  const seen = new Set();
  for (const item of workItems) {
    const id = cleanId(item && (item.issueId || item.id || item.identifier));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function assertRepositorySnapshot(command, storeImpl = store, issue = null) {
  const snapshot = repositoryReference(command);
  const business = issue && issue.project
    ? assertLinearProjectScope(command, issue.project.id, storeImpl)
    : null;
  const globalRepository = storeImpl.getRepositoryConfig();
  const liveProvider = String(
    (business && business.repo ? (business.repoProvider || 'github') : null)
      || (globalRepository && globalRepository.provider)
      || '',
  ).trim().toLowerCase();
  const liveUrl = String(
    (business && business.repo)
      || (globalRepository && globalRepository.url)
      || '',
  ).trim();
  const admitted = repoParts(snapshot.repoUrl, snapshot.provider);
  const configured = repoParts(liveUrl, liveProvider);
  if (
    !admitted
    || !configured
    || admitted.provider !== 'github'
    || admitted.provider !== configured.provider
    || admitted.fullName.toLowerCase() !== configured.fullName.toLowerCase()
  ) {
    throw new StageExecutionError(
      'The live repository selection no longer matches the admitted snapshot.',
      'repository_snapshot_mismatch',
    );
  }
  const token = typeof storeImpl.getRepositoryToken === 'function'
    ? storeImpl.getRepositoryToken(admitted.provider)
    : String((globalRepository && globalRepository.token) || '');
  return { snapshot: admitted, live: configured, token };
}

function linearAccessKey(settings) {
  const configured = String((settings && settings.linearApiKey) || '');
  return configured || (CONFIG.EGRESS_PROXY_URL ? SENTINEL_TOKEN : '');
}

function codingKeys(agent) {
  const settings = agent.settings || {};
  return {
    linearApiKey: settings.linearApiKey,
    langsmithApiKey: settings.langsmithApiKey,
    langsmithTracing: settings.langsmithTracing,
    langsmithProject: settings.langsmithProject,
    langsmithEndpoint: settings.langsmithEndpoint,
    agentRuntime: agent.harness,
    workflowPattern: agent.workflowPattern,
    requestHarnesses: { code: agent.harness },
  };
}

async function loadPipelineIssue(apiKey, issueId, linearImpl = linear) {
  const data = await linearImpl.linearRequest(apiKey, PIPELINE_ISSUE_QUERY, { id: issueId });
  const node = data && data.issue;
  if (!node || !node.id) {
    throw new StageExecutionError(`Coding work item ${issueId} was not found.`, 'coding_work_item_not_found');
  }
  const dependencies = ((node.inverseRelations && node.inverseRelations.nodes) || [])
    .filter((relation) => relation && relation.type === 'blocks' && relation.issue)
    .map((relation) => ({
      id: String(relation.issue.id || ''),
      identifier: String(relation.issue.identifier || relation.issue.id || ''),
      createdAt: relation.issue.createdAt || null,
      stateType: relation.issue.state && relation.issue.state.type,
    }));
  return {
    id: String(node.id),
    identifier: String(node.identifier || node.id),
    title: String(node.title || ''),
    description: String(node.description || ''),
    url: String(node.url || ''),
    createdAt: node.createdAt || null,
    state: node.state && node.state.name,
    stateType: node.state && node.state.type,
    labels: ((node.labels && node.labels.nodes) || []).map((label) => String(label.name || '')),
    project: node.project ? { id: String(node.project.id), name: String(node.project.name || '') } : null,
    dependencies,
  };
}

function orderCodingIssues(issues) {
  const pending = new Map((Array.isArray(issues) ? issues : []).map((issue) => [issue.id, issue]));
  const pendingIdentifiers = new Map(
    [...pending.values()].map((issue) => [String(issue.identifier || issue.id), issue.id]),
  );
  const ordered = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((issue) => (
      (issue.dependencies || []).every((dependency) => {
        if (dependency.stateType === 'completed' || dependency.stateType === 'canceled') return true;
        const pendingId = pending.has(dependency.id)
          ? dependency.id
          : pendingIdentifiers.get(String(dependency.identifier || ''));
        return pendingId ? !pending.has(pendingId) : false;
      })
    )).sort((left, right) => (
      String(left.identifier || left.id).localeCompare(String(right.identifier || right.id))
    ));
    if (!ready.length) {
      const blocked = [...pending.values()]
        .map((issue) => String(issue.identifier || issue.id))
        .sort()
        .slice(0, 20)
        .join(', ');
      throw new StageExecutionError(
        `Coding work items are blocked by unresolved or cyclic dependencies: ${blocked}.`,
        'coding_dependency_blocked',
      );
    }
    const next = ready[0];
    pending.delete(next.id);
    ordered.push(next);
  }
  return ordered;
}

function priorTerminalOutcome(issue) {
  if (!issue || !['completed', 'canceled'].includes(issue.stateType)) return null;
  throw new StageExecutionError(
    `Coding work item ${issue.identifier} is terminal without a command-bound broker artifact receipt.`,
    'coding_work_item_terminal_ambiguous',
  );
}

function authoritativeCodingReceipt(execution, command, issue, repository) {
  try {
    return validateMergeReceipt(execution && execution.artifactReceipt, {
      repository: repository.snapshot.fullName,
      commandId: command.idempotencyKey,
      workItemId: issue.id,
      branch: execution && execution.branch,
    });
  } catch (error) {
    throw new StageExecutionError(
      `Coding work item ${issue.identifier} completed without an authoritative command-bound merge receipt.`,
      error && error.code === 'merge_receipt_scope_mismatch'
        ? 'coding_merge_receipt_mismatch'
        : 'coding_merge_receipt_required',
    );
  }
}

function safeReason(value) {
  return redactSecrets(String(value || '')).trim().slice(0, 2_000);
}

function publicReview(value) {
  try {
    const review = new URL(String(value || ''));
    if (review.protocol !== 'https:' || review.username || review.password) return null;
    review.search = '';
    review.hash = '';
    return review.toString().slice(0, 1_000);
  } catch (_) {
    return null;
  }
}

/** Execute every deterministic work item produced by the planning stage (or the
 * single snapshotted work item) synchronously. The command's policy/model/
 * harness/repository snapshot is authoritative; live drift fails before work. */
async function executeCodingStage(command, dependencies = {}) {
  if (!command || command.stage !== 'code') {
    throw new StageExecutionError('A code StageCommand is required.', 'invalid_code_command');
  }
  const storeImpl = dependencies.store || store;
  const linearImpl = dependencies.linear || linear;
  const issueIds = issueIdsFromCommand(command);
  if (issueIds.length === 0) {
    throw new StageExecutionError(
      'Coding requires a snapshotted work item or deterministic planner work items.',
      'coding_work_item_required',
    );
  }
  if (issueIds.length > MAX_PIPELINE_CODING_WORK_ITEMS) {
    throw new StageExecutionError(
      `Coding accepts at most ${MAX_PIPELINE_CODING_WORK_ITEMS} work items per pipeline run.`,
      'coding_work_item_limit_exceeded',
    );
  }
  const resolveAgent = dependencies.resolveStageAgent || resolveStageAgent;
  const agent = await resolveAgent(
    command,
    { role: 'execution', workflowStage: 'coding' },
    { ...dependencies, store: storeImpl },
  );
  const apiKey = linearAccessKey(agent.settings);
  if (!apiKey) {
    throw new StageExecutionError('Linear access is unavailable to the coder.', 'linear_not_configured');
  }
  const runCoder = dependencies.runCoder || runPlannedCoderLocal;
  const startIssueImpl = dependencies.startIssue || startIssue;
  const finishIssueImpl = dependencies.finishIssue || finishIssue;
  const loadIssue = dependencies.loadIssue || ((id) => loadPipelineIssue(apiKey, id, linearImpl));
  const step = typeof dependencies.step === 'function' ? dependencies.step : () => {};
  const keys = codingKeys(agent);
  const outcomes = [];
  const loadedIssues = [];
  const repositories = new Map();

  for (const issueId of issueIds) {
    const loaded = await loadIssue(issueId);
    if (!loaded.project || !loaded.project.id) {
      throw new StageExecutionError(
        `Coding work item ${loaded.identifier} is not attached to a Linear project.`,
        'coding_project_required',
      );
    }
    // Resolve every repository before mutating any issue, so a mixed/mis-scoped
    // batch fails atomically at the stage boundary.
    repositories.set(loaded.id, assertRepositorySnapshot(command, storeImpl, loaded));
    loadedIssues.push(loaded);
  }

  for (const loaded of orderCodingIssues(loadedIssues)) {
    const repository = repositories.get(loaded.id);
    priorTerminalOutcome(loaded);

    const startedState = await startIssueImpl(apiKey, { issueId: loaded.id, onStep: step });
    const issue = {
      ...loaded,
      state: (startedState && startedState.name) || loaded.state,
      orgId: command.organizationId,
      nativeProjectId: command.projectId,
      projectName: loaded.project.name,
    };
    const execution = await runCoder({
      issue,
      project: loaded.project,
      llm: agent.llm,
      apiKey,
      keys,
      onStep: step,
      settings: {
        effectivePolicy: agent.effectivePolicy,
        orgId: command.organizationId,
        nativeProjectId: command.projectId,
      },
      repositoryProvider: repository.snapshot.provider,
      repositoryToken: repository.token,
      repositoryUrl: repository.snapshot.https,
      pipelineCommandId: command.idempotencyKey,
      dependencies: loaded.dependencies || [],
    });
    const verdict = parseVerdict(execution && execution.finalText);
    let reason = safeReason(verdict.reason) || (
      verdict.status === 'completed' ? 'Coding completed.' : 'Coding did not meet its completion bar.'
    );
    let receipt = null;
    let outcomeStatus = verdict.status;
    if (verdict.status === 'completed') {
      try {
        receipt = authoritativeCodingReceipt(execution, command, loaded, repository);
      } catch (error) {
        outcomeStatus = 'insufficient';
        reason = safeReason(error.message);
      }
    }
    await finishIssueImpl(apiKey, {
      issueId: loaded.id,
      outcome: outcomeStatus,
      reason,
      onStep: step,
    });
    const outcome = {
      id: safeReason(loaded.id).slice(0, 200),
      identifier: safeReason(loaded.identifier).slice(0, 200),
      status: outcomeStatus,
      reason,
      review: publicReview(verdict.pr),
      branch: execution && execution.branch ? safeReason(execution.branch).slice(0, 160) : null,
      artifactReceipt: receipt,
    };
    outcomes.push(outcome);
    if (outcomeStatus !== 'completed') {
      return {
        status: 'failed',
        output: {
          workItems: outcomes,
          selectedHarness: agent.harness,
          harness: execution && execution.runtime || agent.harness,
          provider: agent.llm.provider,
          model: agent.llm.model,
        },
        error: {
          code: verdict.status === 'completed' ? 'coding_merge_receipt_required' : 'coding_incomplete',
          message: reason,
          retryable: false,
        },
      };
    }
  }

  const last = outcomes[outcomes.length - 1] || {};
  const artifact = last.artifactReceipt ? {
    commitSha: last.artifactReceipt.commitSha,
    treeSha: last.artifactReceipt.treeSha,
  } : null;
  if (!artifact) {
    throw new StageExecutionError('Coding produced no final immutable base artifact.', 'coding_merge_receipt_required');
  }
  return {
    status: 'succeeded',
    artifact,
    output: {
      summary: `Completed ${outcomes.length} coding work item${outcomes.length === 1 ? '' : 's'}.`,
      workItems: outcomes,
      branch: last.branch || null,
      review: last.review || null,
      finalBaseSha: artifact.commitSha,
      artifact,
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

function createCoderPipelineRouter(options = {}) {
  const initStore = options.initStore || store.initStore;
  const execute = inCommandWorkspace(options.execute || executeCodingStage, initStore);
  const publish = options.publish || createStageResultPublisher(options.publisherOptions);
  const handler = createStageCommandHandler({
    stage: 'code',
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
  PIPELINE_ISSUE_QUERY,
  MAX_PIPELINE_CODING_WORK_ITEMS,
  assertRepositorySnapshot,
  codingKeys,
  createCoderPipelineRouter,
  executeCodingStage,
  inCommandWorkspace,
  issueIdsFromCommand,
  loadPipelineIssue,
  orderCodingIssues,
  priorTerminalOutcome,
  authoritativeCodingReceipt,
};
