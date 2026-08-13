'use strict';

const path = require('node:path');
const { CONFIG, namespaceCollection } = require('../config');
const {
  copySecretFreeJson,
  stageIdempotencyKey,
  validatePipelineStart,
  validatePreflightSnapshot,
  validateStageCommandV1,
  validateStageResultV1,
} = require('./contracts');
const {
  MemoryPipelineStore,
  JsonFilePipelineStore,
  FirestorePipelineStore,
} = require('./storage');

const PIPELINE_RUN_SCHEMA_VERSION = 1;
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_STAGE_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_STAGE_ATTEMPTS = 100;

class PipelineRepositoryError extends Error {
  constructor(message, code, status = 409) {
    super(message);
    this.name = 'PipelineRepositoryError';
    this.code = code;
    this.status = status;
  }
}

function repositoryError(message, code, status) {
  throw new PipelineRepositoryError(message, code, status);
}

function assertContract(validation, kind) {
  if (!validation.valid) repositoryError(validation.errors.join(' '), `invalid_${kind}`, 400);
  return validation.value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function samePipelineStart(left, right) {
  if (!left || !right) return false;
  const { createdAt: _leftCreatedAt, ...leftIdentity } = left;
  const { createdAt: _rightCreatedAt, ...rightIdentity } = right;
  return same(leftIdentity, rightIdentity);
}

function nextRevision(run, now) {
  return {
    ...run,
    updatedAt: now,
    checkpoint: {
      ...run.checkpoint,
      revision: run.checkpoint.revision + 1,
      updatedAt: now,
    },
  };
}

function safeDispatchError(error) {
  const rawCode = error && typeof error.code === 'string' ? error.code : '';
  return {
    code: /^[a-z][a-z0-9._-]{0,79}$/.test(rawCode) ? rawCode : 'pipeline_dispatch_failed',
    // SDK/network exceptions sometimes echo request URLs or headers. Durable
    // control-plane state records only a non-sensitive diagnostic category.
    message: 'Stage command dispatch failed.',
  };
}

function approvalForCommand(claim) {
  if (!claim) return null;
  return {
    approved: true,
    approvalId: claim.approvalId,
    by: claim.by,
    at: claim.at,
    source: 'server',
    testCommandId: claim.testCommandId,
    commitSha: claim.commitSha,
    treeSha: claim.treeSha,
    preflightDecisionDigest: claim.preflightDecisionDigest,
    deployCommandId: claim.deployCommandId,
  };
}

function nextAttemptFor(run, stage) {
  const attempt = Number(run.checkpoint.attempts[stage] || 0) + 1;
  if (!Number.isSafeInteger(attempt) || attempt > MAX_STAGE_ATTEMPTS) {
    repositoryError(
      `Stage "${stage}" has reached the ${MAX_STAGE_ATTEMPTS}-attempt limit.`,
      'pipeline_attempt_limit_reached',
      409,
    );
  }
  return attempt;
}

function pendingApprovalFor(run, testStage) {
  const artifact = testStage && testStage.result && testStage.result.artifact;
  if (
    !testStage
    || testStage.stage !== 'test'
    || testStage.status !== 'succeeded'
    || !artifact
  ) {
    repositoryError('A successful tested artifact is required before approval.', 'pipeline_test_artifact_required');
  }
  const repository = run.preflight.repository || {};
  const configuration = run.preflight.stageConfiguration && run.preflight.stageConfiguration.deploy || {};
  const repositoryName = repository.fullName
    || (repository.owner && repository.name ? `${repository.owner}/${repository.name}` : '');
  const environment = String(configuration.environment || '').trim().toLowerCase();
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName)
    || !/^[a-z][a-z0-9_-]{0,39}$/.test(environment)
  ) {
    repositoryError('Deployment approval context is incomplete.', 'pipeline_deployment_approval_invalid');
  }
  return {
    runId: run.runId,
    projectId: run.projectId,
    repository: repositoryName,
    environment,
    testCommandId: testStage.result.commandId,
    commitSha: artifact.commitSha,
    treeSha: artifact.treeSha,
    preflightDecisionDigest: run.preflight.preflightDecisionDigest,
  };
}

class PipelineRunRepository {
  constructor({ store, clock = () => new Date().toISOString() } = {}) {
    if (!store || typeof store.transaction !== 'function') throw new TypeError('A transactional pipeline store is required.');
    this.store = store;
    this.clock = clock;
  }

  async createRun(rawStart) {
    const start = assertContract(validatePipelineStart(rawStart), 'pipeline_start');
    return this.store.transaction(async (transaction) => {
      const existing = await transaction.getRun(start.runId);
      if (existing) {
        // createdAt is server-generated when omitted by the caller. Treat it as
        // receipt metadata rather than part of the runId idempotency identity,
        // while still requiring every caller-controlled field to match.
        if (!samePipelineStart(existing.start, start)) {
          repositoryError('A different pipeline run already uses this runId.', 'pipeline_run_conflict');
        }
        return { created: false, run: existing };
      }
      const now = this.clock();
      const run = {
        schemaVersion: PIPELINE_RUN_SCHEMA_VERSION,
        runId: start.runId,
        organizationId: start.organizationId,
        projectId: start.projectId,
        requestedStages: [...start.requestedStages],
        status: 'preflighting',
        start,
        preflight: null,
        cancellation: null,
        pendingDeploymentApproval: null,
        deploymentApprovalClaim: null,
        failure: null,
        checkpoint: {
          revision: 0,
          nextStageIndex: 0,
          completedStages: [],
          attempts: {},
          activeCommandId: null,
          lastResultId: null,
          updatedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      };
      await transaction.setRun(start.runId, run);
      return { created: true, run };
    });
  }

  async savePreflight(rawSnapshot) {
    const snapshot = assertContract(validatePreflightSnapshot(rawSnapshot), 'preflight_snapshot');
    return this.store.transaction(async (transaction) => {
      let run = await transaction.getRun(snapshot.runId);
      if (!run) repositoryError('Pipeline run was not found.', 'pipeline_run_not_found', 404);
      if (run.organizationId !== snapshot.organizationId || run.projectId !== snapshot.projectId) {
        repositoryError('Preflight scope does not match the pipeline run.', 'pipeline_scope_mismatch');
      }
      if (!same(run.requestedStages, snapshot.requestedStages)) {
        repositoryError('Preflight stages do not match the immutable requested stages.', 'pipeline_stages_mismatch');
      }
      if (run.preflight) {
        if (!same(run.preflight, snapshot)) repositoryError('The immutable preflight snapshot already exists.', 'preflight_conflict');
        return { saved: false, run };
      }
      const now = this.clock();
      run = nextRevision({ ...run, preflight: snapshot, status: run.status === 'cancelled' ? 'cancelled' : 'queued' }, now);
      await transaction.setRun(run.runId, run);
      return { saved: true, run };
    });
  }

  async claimStage(rawCommand) {
    const command = assertContract(validateStageCommandV1(rawCommand), 'stage_command');
    return this.store.transaction(async (transaction) => {
      let run = await transaction.getRun(command.runId);
      if (!run) repositoryError('Pipeline run was not found.', 'pipeline_run_not_found', 404);
      const existing = await transaction.getStage(command.runId, command.idempotencyKey);
      if (existing) {
        if (!same(existing.command, command)) repositoryError('The idempotency key is already bound to another command.', 'stage_command_conflict');
        return { acquired: false, stageRun: existing, run };
      }
      if (!run.preflight) repositoryError('Pipeline preflight has not completed.', 'pipeline_preflight_pending');
      if (TERMINAL_RUN_STATUSES.has(run.status)) repositoryError(`Pipeline run is ${run.status}.`, 'pipeline_run_terminal');
      if (run.status === 'cancellation_requested') {
        repositoryError('Pipeline cancellation has already been requested.', 'pipeline_cancellation_requested');
      }
      const expectedStage = run.requestedStages[run.checkpoint.nextStageIndex];
      if (command.stage !== expectedStage) {
        repositoryError(`Stage "${command.stage}" is not the expected stage "${expectedStage || 'none'}".`, 'pipeline_stage_out_of_order');
      }
      if (run.checkpoint.activeCommandId) repositoryError('Another stage command is already active.', 'pipeline_stage_active');
      if (!same(run.preflight, command.preflight)) repositoryError('Command preflight does not match the immutable snapshot.', 'preflight_conflict');
      const expectedAttempt = nextAttemptFor(run, command.stage);
      if (command.attempt !== expectedAttempt) {
        repositoryError(`Stage attempt must be ${expectedAttempt}.`, 'pipeline_attempt_out_of_order');
      }
      let deploymentApprovalClaim = run.deploymentApprovalClaim || null;
      if (command.stage === 'deploy') {
        const configuration = run.preflight.stageConfiguration && run.preflight.stageConfiguration.deploy || {};
        const environment = String(configuration.environment || '').trim().toLowerCase();
        const production = environment === 'production' || environment === 'prod';
        const suppliedApproval = command.input && command.input.deploymentApproval;
        if (production || suppliedApproval || deploymentApprovalClaim) {
          if (!deploymentApprovalClaim) {
            repositoryError('A durable deployment approval claim is required.', 'pipeline_deployment_approval_required');
          }
          if (deploymentApprovalClaim.deployCommandId !== command.commandId) {
            repositoryError('Deployment approval is bound to another command.', 'pipeline_deployment_approval_conflict');
          }
          if (!same(suppliedApproval, approvalForCommand(deploymentApprovalClaim))) {
            repositoryError('Deployment command approval does not match the durable claim.', 'pipeline_deployment_approval_conflict');
          }
          deploymentApprovalClaim = {
            ...deploymentApprovalClaim,
            state: 'claimed',
            claimedAt: this.clock(),
          };
        }
      }
      const now = this.clock();
      const stageRun = {
        schemaVersion: PIPELINE_RUN_SCHEMA_VERSION,
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        runId: command.runId,
        stage: command.stage,
        attempt: command.attempt,
        status: 'dispatching',
        command,
        result: null,
        dispatch: { count: 0, receipt: null, lastError: null, lastAttemptAt: null },
        createdAt: now,
        updatedAt: now,
      };
      run = nextRevision({
        ...run,
        status: 'running',
        failure: null,
        deploymentApprovalClaim,
        checkpoint: {
          ...run.checkpoint,
          attempts: { ...run.checkpoint.attempts, [command.stage]: command.attempt },
          activeCommandId: command.commandId,
        },
      }, now);
      await transaction.setStage(command.runId, command.idempotencyKey, stageRun);
      await transaction.setRun(command.runId, run);
      return { acquired: true, stageRun, run };
    });
  }

  async markDispatched(idempotencyKey, rawReceipt = {}) {
    const receipt = copySecretFreeJson(rawReceipt, 'dispatchReceipt');
    return this._updateDispatch(idempotencyKey, ({ stageRun, run, now }) => {
      if (
        TERMINAL_STAGE_STATUSES.has(stageRun.status)
        || stageRun.status === 'cancellation_requested'
        || run.checkpoint.activeCommandId !== stageRun.commandId
        || TERMINAL_RUN_STATUSES.has(run.status)
        || run.status === 'cancellation_requested'
      ) {
        return { applied: false, ignored: 'stage_not_active', stageRun, run };
      }
      return {
        stageRun: {
          ...stageRun,
          status: 'waiting',
          dispatch: {
            count: stageRun.dispatch.count + 1,
            receipt,
            lastError: null,
            lastAttemptAt: now,
          },
          updatedAt: now,
        },
        run: { ...run, status: 'waiting' },
      };
    });
  }

  async markDispatchFailed(idempotencyKey, error) {
    const safeError = copySecretFreeJson(safeDispatchError(error), 'dispatchError');
    return this._updateDispatch(idempotencyKey, ({ stageRun, run, now }) => {
      if (
        TERMINAL_STAGE_STATUSES.has(stageRun.status)
        || stageRun.status === 'cancellation_requested'
        || run.checkpoint.activeCommandId !== stageRun.commandId
        || TERMINAL_RUN_STATUSES.has(run.status)
        || run.status === 'cancellation_requested'
      ) {
        return { applied: false, ignored: 'stage_not_active', stageRun, run };
      }
      return {
        stageRun: {
          ...stageRun,
          status: 'dispatching',
          dispatch: {
            ...stageRun.dispatch,
            count: stageRun.dispatch.count + 1,
            lastError: safeError,
            lastAttemptAt: now,
          },
          updatedAt: now,
        },
        run,
      };
    });
  }

  async _updateDispatch(idempotencyKey, update) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) repositoryError('idempotencyKey is required.', 'invalid_idempotency_key', 400);
    const separator = idempotencyKey.lastIndexOf(':');
    const stageSeparator = idempotencyKey.lastIndexOf(':', separator - 1);
    const runId = stageSeparator > 0 ? idempotencyKey.slice(0, stageSeparator) : '';
    if (!runId) repositoryError('idempotencyKey is invalid.', 'invalid_idempotency_key', 400);
    return this.store.transaction(async (transaction) => {
      const stageRun = await transaction.getStage(runId, idempotencyKey);
      let run = await transaction.getRun(runId);
      if (!stageRun || !run) repositoryError('Stage run was not found.', 'stage_run_not_found', 404);
      const now = this.clock();
      const next = update({ stageRun, run, now });
      if (next.applied === false) {
        return {
          applied: false,
          ignored: next.ignored || 'stage_not_active',
          stageRun: next.stageRun || stageRun,
          run: next.run || run,
        };
      }
      run = nextRevision(next.run, now);
      await transaction.setStage(runId, idempotencyKey, next.stageRun);
      await transaction.setRun(runId, run);
      return { applied: true, stageRun: next.stageRun, run };
    });
  }

  async completeStage(rawResult) {
    const result = assertContract(validateStageResultV1(rawResult), 'stage_result');
    return this.store.transaction(async (transaction) => {
      let run = await transaction.getRun(result.runId);
      let stageRun = await transaction.getStage(result.runId, result.idempotencyKey);
      if (!run || !stageRun) repositoryError('Stage run was not found.', 'stage_run_not_found', 404);
      if (stageRun.result) {
        if (!same(stageRun.result, result)) repositoryError('A conflicting result already completed this stage attempt.', 'stage_result_conflict');
        return { applied: false, duplicate: true, stageRun, run };
      }
      if (run.status === 'cancelled') {
        return { applied: false, ignored: 'run_cancelled', stageRun, run };
      }
      if (run.checkpoint.activeCommandId !== result.commandId) {
        repositoryError('Stage result does not match the active command.', 'stage_result_not_active');
      }
      const now = this.clock();
      stageRun = {
        ...stageRun,
        status: result.status,
        result,
        updatedAt: now,
      };
      const checkpoint = {
        ...run.checkpoint,
        activeCommandId: null,
        lastResultId: result.commandId,
      };
      if (run.status === 'cancellation_requested') {
        run = nextRevision({
          ...run,
          status: 'cancelled',
          checkpoint,
          cancellation: {
            ...(run.cancellation || {}),
            state: 'completed',
            completedAt: now,
            outcome: result.status,
          },
        }, now);
        await transaction.setStage(result.runId, result.idempotencyKey, stageRun);
        await transaction.setRun(result.runId, run);
        return { applied: true, stageRun, run };
      }
      if (result.status === 'succeeded') {
        checkpoint.completedStages = [...run.checkpoint.completedStages, result.stage];
        checkpoint.nextStageIndex = run.checkpoint.nextStageIndex + 1;
        run = {
          ...run,
          status: checkpoint.nextStageIndex >= run.requestedStages.length ? 'succeeded' : 'queued',
          checkpoint,
          failure: null,
        };
      } else if (result.status === 'failed') {
        run = { ...run, status: 'failed', checkpoint, failure: result.error };
      } else {
        run = {
          ...run,
          status: 'cancelled',
          checkpoint,
          cancellation: run.cancellation || {
            state: 'completed',
            requestedAt: now,
            requestedBy: null,
            reason: 'Stage cancelled.',
            completedAt: now,
          },
        };
      }
      run = nextRevision(run, now);
      await transaction.setStage(result.runId, result.idempotencyKey, stageRun);
      await transaction.setRun(result.runId, run);
      return { applied: true, stageRun, run };
    });
  }

  async cancelRun(runId, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      repositoryError('cancellation options must be an object.', 'invalid_cancellation', 400);
    }
    const cancellation = copySecretFreeJson(options, 'cancellation');
    return this.store.transaction(async (transaction) => {
      let run = await transaction.getRun(runId);
      if (!run) repositoryError('Pipeline run was not found.', 'pipeline_run_not_found', 404);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { changed: false, run };
      const activeId = run.checkpoint.activeCommandId;
      let activeStage = activeId ? await transaction.getStage(runId, activeId) : null;
      if (run.status === 'cancellation_requested') {
        return { changed: false, run, activeStage };
      }
      const now = this.clock();
      if (activeStage && !TERMINAL_STAGE_STATUSES.has(activeStage.status)) {
        activeStage = { ...activeStage, status: 'cancellation_requested', updatedAt: now };
        await transaction.setStage(runId, activeId, activeStage);
      }
      const hasActiveWork = Boolean(activeStage && !TERMINAL_STAGE_STATUSES.has(activeStage.status));
      run = nextRevision({
        ...run,
        status: hasActiveWork ? 'cancellation_requested' : 'cancelled',
        cancellation: {
          state: hasActiveWork ? 'requested' : 'completed',
          requestedAt: now,
          requestedBy: cancellation.requestedBy || null,
          reason: typeof cancellation.reason === 'string' ? cancellation.reason.slice(0, 1000) : null,
          ...(hasActiveWork ? {} : { completedAt: now }),
        },
      }, now);
      await transaction.setRun(runId, run);
      return { changed: true, run, activeStage };
    });
  }

  async confirmCancellation(runId, commandId, rawConfirmation = {}) {
    const confirmation = copySecretFreeJson(rawConfirmation, 'cancellationConfirmation');
    return this.store.transaction(async (transaction) => {
      let run = await transaction.getRun(runId);
      if (!run) repositoryError('Pipeline run was not found.', 'pipeline_run_not_found', 404);
      if (run.status === 'cancelled') return { changed: false, run };
      if (run.status !== 'cancellation_requested' || run.checkpoint.activeCommandId !== commandId) {
        repositoryError('Cancellation confirmation does not match active work.', 'pipeline_cancellation_conflict');
      }
      let activeStage = await transaction.getStage(runId, commandId);
      if (!activeStage) repositoryError('Stage run was not found.', 'stage_run_not_found', 404);
      const now = this.clock();
      activeStage = { ...activeStage, status: 'cancelled', updatedAt: now };
      run = nextRevision({
        ...run,
        status: 'cancelled',
        checkpoint: { ...run.checkpoint, activeCommandId: null },
        cancellation: {
          ...(run.cancellation || {}),
          state: 'confirmed',
          confirmedAt: now,
          confirmation,
        },
      }, now);
      await transaction.setStage(runId, commandId, activeStage);
      await transaction.setRun(runId, run);
      return { changed: true, run, activeStage };
    });
  }

  async reopenFailedRun(runId) {
    return this.store.transaction(async (transaction) => {
      let run = await transaction.getRun(runId);
      if (!run) repositoryError('Pipeline run was not found.', 'pipeline_run_not_found', 404);
      if (run.status !== 'failed') return { changed: false, run };
      const expectedStage = run.requestedStages[run.checkpoint.nextStageIndex];
      nextAttemptFor(run, expectedStage);
      const now = this.clock();
      run = nextRevision({ ...run, status: 'queued', failure: null }, now);
      await transaction.setRun(runId, run);
      return { changed: true, run };
    });
  }

  /** Pause immediately before deploy until a trusted external approval exists.
   * No command is claimed, so resume can safely re-check approval and dispatch
   * the same next stage without incrementing its attempt. */
  async markAwaitingApproval(runId) {
    return this.store.transaction(async (transaction) => {
      let run = await transaction.getRun(runId);
      if (!run) repositoryError('Pipeline run was not found.', 'pipeline_run_not_found', 404);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { changed: false, run };
      if (run.checkpoint.activeCommandId) {
        repositoryError('A stage command is already active.', 'pipeline_stage_active');
      }
      const expectedStage = run.requestedStages[run.checkpoint.nextStageIndex];
      if (expectedStage !== 'deploy') {
        repositoryError('Deployment approval is not the next pipeline transition.', 'pipeline_approval_out_of_order');
      }
      if (run.status === 'awaiting_approval' && run.pendingDeploymentApproval) {
        return { changed: false, run };
      }
      const testCommandId = run.checkpoint.lastResultId;
      const testStage = testCommandId ? await transaction.getStage(runId, testCommandId) : null;
      const pendingDeploymentApproval = pendingApprovalFor(run, testStage);
      const now = this.clock();
      const wasAwaiting = run.status === 'awaiting_approval';
      run = nextRevision({ ...run, status: 'awaiting_approval', pendingDeploymentApproval }, now);
      await transaction.setRun(runId, run);
      return { changed: !wasAwaiting, run };
    });
  }

  async saveDeploymentApprovalClaim(runId, rawApproval) {
    const approval = copySecretFreeJson(rawApproval, 'deploymentApproval');
    return this.store.transaction(async (transaction) => {
      let run = await transaction.getRun(runId);
      if (!run) repositoryError('Pipeline run was not found.', 'pipeline_run_not_found', 404);
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        repositoryError(`Pipeline run is ${run.status}.`, 'pipeline_run_terminal');
      }
      if (run.checkpoint.activeCommandId) repositoryError('A stage command is already active.', 'pipeline_stage_active');
      const stage = run.requestedStages[run.checkpoint.nextStageIndex];
      if (stage !== 'deploy') {
        repositoryError('Deployment approval is not the next pipeline transition.', 'pipeline_approval_out_of_order');
      }
      const deployAttempt = nextAttemptFor(run, 'deploy');
      const deployCommandId = stageIdempotencyKey(run.runId, 'deploy', deployAttempt);
      const testCommandId = run.checkpoint.lastResultId;
      const testStage = testCommandId ? await transaction.getStage(runId, testCommandId) : null;
      const expectedApproval = pendingApprovalFor(run, testStage);
      const requiredStrings = [
        'approvalId', 'by', 'at', 'testCommandId', 'commitSha', 'treeSha', 'preflightDecisionDigest',
      ];
      if (requiredStrings.some((field) => typeof approval[field] !== 'string' || !approval[field])) {
        repositoryError('Deployment approval is incomplete.', 'pipeline_deployment_approval_invalid');
      }
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(approval.approvalId)
        || !approval.by.trim()
        || approval.by.length > 320
        || approval.at.length > 64
        || Number.isNaN(Date.parse(approval.at))
        || Date.parse(approval.at) < Date.parse(testStage.result.completedAt)
      ) {
        repositoryError('Deployment approval is invalid.', 'pipeline_deployment_approval_invalid');
      }
      const claim = {
        approvalId: approval.approvalId,
        by: approval.by.trim(),
        at: approval.at,
        source: 'server',
        testCommandId: approval.testCommandId,
        commitSha: approval.commitSha,
        treeSha: approval.treeSha,
        preflightDecisionDigest: approval.preflightDecisionDigest,
        deployCommandId,
        state: 'reserved',
        reservedAt: this.clock(),
        claimedAt: null,
      };
      if (run.preflight.preflightDecisionDigest !== claim.preflightDecisionDigest) {
        repositoryError('Approval preflight digest does not match the run.', 'pipeline_deployment_approval_conflict');
      }
      for (const field of ['testCommandId', 'commitSha', 'treeSha', 'preflightDecisionDigest']) {
        if (claim[field] !== expectedApproval[field]) {
          repositoryError('Approval lineage does not match the tested artifact.', 'pipeline_deployment_approval_conflict');
        }
      }
      if (run.deploymentApprovalClaim) {
        const comparable = { ...run.deploymentApprovalClaim, reservedAt: claim.reservedAt };
        if (!same(comparable, claim)) {
          repositoryError('Another deployment approval is already bound to this run.', 'pipeline_deployment_approval_conflict');
        }
        return { saved: false, run, claim: run.deploymentApprovalClaim };
      }
      const now = this.clock();
      claim.reservedAt = now;
      run = nextRevision({
        ...run,
        pendingDeploymentApproval: null,
        deploymentApprovalClaim: claim,
      }, now);
      await transaction.setRun(runId, run);
      return { saved: true, run, claim };
    });
  }

  async nextAttempt(runId, stage) {
    const run = await this.getRun(runId);
    return nextAttemptFor(run, stage);
  }

  async getRun(runId) {
    const run = await this.store.getRun(runId);
    if (!run) repositoryError('Pipeline run was not found.', 'pipeline_run_not_found', 404);
    return clone(run);
  }

  async getStageRun(runId, idempotencyKey) {
    const stageRun = await this.store.getStage(runId, idempotencyKey);
    if (!stageRun) repositoryError('Stage run was not found.', 'stage_run_not_found', 404);
    return clone(stageRun);
  }

  async listStageRuns(runId) {
    const run = await this.getRun(runId);
    const stages = await this.store.listStages(runId);
    const stageOrder = new Map(run.requestedStages.map((stage, index) => [stage, index]));
    return stages.sort((left, right) => (
      (stageOrder.get(left.stage) ?? Number.MAX_SAFE_INTEGER)
      - (stageOrder.get(right.stage) ?? Number.MAX_SAFE_INTEGER)
      || left.attempt - right.attempt
      || left.commandId.localeCompare(right.commandId)
    ));
  }

  async getStatus(runId) {
    const [run, stages] = await Promise.all([this.getRun(runId), this.listStageRuns(runId)]);
    return { run, stages };
  }
}

function createPipelineRepository({
  backend = CONFIG.STORE_BACKEND,
  file = path.join(CONFIG.DATA_DIR, 'pipeline-runs.json'),
  rootCollection = namespaceCollection('aifleet_pipeline_runs'),
  firestoreFactory,
  clock,
} = {}) {
  let store;
  if (backend === 'firestore') {
    store = new FirestorePipelineStore({
      rootCollection,
      projectId: CONFIG.GCP.projectId,
      databaseId: process.env.FIRESTORE_DATABASE || undefined,
      firestoreFactory,
    });
  } else if (backend === 'memory') {
    store = new MemoryPipelineStore();
  } else if (backend === 'file') {
    store = new JsonFilePipelineStore({ file });
  } else {
    throw new TypeError(`Unsupported pipeline store backend "${backend}".`);
  }
  return new PipelineRunRepository({ store, clock });
}

module.exports = {
  PIPELINE_RUN_SCHEMA_VERSION,
  PipelineRepositoryError,
  PipelineRunRepository,
  createPipelineRepository,
};
