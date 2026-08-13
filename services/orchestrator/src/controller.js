'use strict';

const {
  createPipelineStart,
  createStageCommandV1,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const { createPipelineGraph } = require('./graph');
const { SnapshotPreflight } = require('./preflight');

const TERMINAL_STATUSES = new Set(['succeeded', 'cancelled', 'cancellation_requested']);

function approvalFromClaim(claim) {
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

class PipelineOrchestrator {
  constructor({
    repository,
    bus,
    preflight,
    graph,
    checkpointer,
    langgraph,
    deploymentApproval = null,
    requireDeploymentApproval = false,
    clock = () => new Date().toISOString(),
    idFactory,
    log,
  } = {}) {
    if (!repository) throw new TypeError('repository is required.');
    if (!bus || typeof bus.dispatch !== 'function') throw new TypeError('stage command bus is required.');
    this.repository = repository;
    this.bus = bus;
    this.clock = clock;
    this.idFactory = idFactory;
    this.log = log || { info() {}, error() {} };
    this.deploymentApproval = deploymentApproval;
    this.requireDeploymentApproval = requireDeploymentApproval;
    this.preflight = preflight || new SnapshotPreflight({ clock });
    this.graph = graph || createPipelineGraph({
      checkpointer,
      langgraph,
      dispatchStage: this._dispatchNewStage.bind(this),
    });
  }

  async start(rawInput, { deferDispatch = false } = {}) {
    const start = createPipelineStart(rawInput, { clock: this.clock, idFactory: this.idFactory });
    const creation = await this.repository.createRun(start);
    let run = creation.run;
    if (!run.preflight) {
      const snapshot = await this.preflight.capture(run.start);
      run = (await this.repository.savePreflight(snapshot)).run;
    }
    if (
      !deferDispatch
      && !run.checkpoint.activeCommandId
      && !TERMINAL_STATUSES.has(run.status)
      && run.status !== 'failed'
    ) {
      return this.advance(run.runId);
    }
    return this.status(run.runId);
  }

  async advance(runId) {
    let run = await this.repository.getRun(runId);
    if (TERMINAL_STATUSES.has(run.status) || run.status === 'failed') return this.status(runId);
    if (!run.preflight) return this.status(runId);
    if (run.checkpoint.activeCommandId) return this.status(runId);
    const nextStage = run.requestedStages[run.checkpoint.nextStageIndex];
    if (nextStage === 'deploy') {
      const approval = await this._deploymentApprovalFor(run);
      if (approval === false) {
        await this.repository.markAwaitingApproval(run.runId);
        return this.status(run.runId);
      }
      if (approval && !run.deploymentApprovalClaim) {
        run = (await this.repository.saveDeploymentApprovalClaim(run.runId, approval)).run;
      }
    }
    await this.graph.invoke({
      runId: run.runId,
      requestedStages: run.requestedStages,
      completedStages: run.checkpoint.completedStages,
      runStatus: run.status,
      checkpointRevision: run.checkpoint.revision,
    }, {
      configurable: { thread_id: run.runId },
      metadata: {
        pipeline_run_id: run.runId,
        pipeline_checkpoint_revision: run.checkpoint.revision,
      },
    });
    return this.status(runId);
  }

  async _deploymentApprovalFor(run) {
    if (run.deploymentApprovalClaim) return approvalFromClaim(run.deploymentApprovalClaim);
    const configuration = run.preflight
      && run.preflight.stageConfiguration
      && run.preflight.stageConfiguration.deploy || {};
    const environment = String(configuration.environment || '').trim().toLowerCase();
    const requiresApproval = this.requireDeploymentApproval
      || environment === 'production'
      || environment === 'prod';
    if (!requiresApproval) return null;
    if (!this.deploymentApproval || typeof this.deploymentApproval.assertApproved !== 'function') {
      return false;
    }
    const stages = await this.repository.listStageRuns(run.runId);
    const testStage = stages.find((stageRun) => (
      stageRun.stage === 'test'
      && stageRun.status === 'succeeded'
      && stageRun.result
    ));
    if (!testStage) return false;
    const artifact = testStage.result.artifact;
    if (!artifact || !artifact.commitSha || !artifact.treeSha) return false;
    let approval;
    try {
      approval = await this.deploymentApproval.assertApproved({
        run,
        testResult: testStage.result,
      });
    } catch (error) {
      if (
        error
        && ['pipeline_deployment_not_approved', 'pipeline_deployment_approval_required'].includes(error.code)
      ) return false;
      throw error;
    }
    if (
      !approval
      || approval.approved !== true
      || typeof approval.by !== 'string'
      || !approval.by.trim()
      || typeof approval.at !== 'string'
      || Number.isNaN(Date.parse(approval.at))
      || Date.parse(approval.at) < Date.parse(testStage.result.completedAt)
      || approval.testCommandId !== testStage.result.commandId
      || approval.commitSha !== artifact.commitSha
      || approval.treeSha !== artifact.treeSha
      || approval.preflightDecisionDigest !== run.preflight.preflightDecisionDigest
    ) {
      return false;
    }
    return {
      approved: true,
      approvalId: approval.approvalId || run.runId,
      by: approval.by,
      at: approval.at,
      source: 'server',
      testCommandId: approval.testCommandId,
      commitSha: approval.commitSha,
      treeSha: approval.treeSha,
      preflightDecisionDigest: approval.preflightDecisionDigest,
    };
  }

  async _dispatchNewStage(runId, stage) {
    const run = await this.repository.getRun(runId);
    const attempt = await this.repository.nextAttempt(runId, stage);
    const stages = await this.repository.listStageRuns(runId);
    const priorResults = stages
      .filter((stageRun) => stageRun.status === 'succeeded' && stageRun.result)
      .map((stageRun) => ({
        stage: stageRun.stage,
        attempt: stageRun.attempt,
        status: stageRun.result.status,
        commandId: stageRun.result.commandId,
        artifact: stageRun.result.artifact,
        output: stageRun.result.output,
      }));
    const command = createStageCommandV1({
      runId: run.runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      requestedStages: run.requestedStages,
      preflight: run.preflight,
      stage,
      attempt,
      input: {
        request: run.start.request,
        priorResults,
        ...(stage === 'deploy' && run.deploymentApprovalClaim
          ? { deploymentApproval: approvalFromClaim(run.deploymentApprovalClaim) }
          : {}),
      },
      trace: {
        correlationId: run.start.correlationId,
        checkpointRevision: run.checkpoint.revision,
      },
    }, { clock: this.clock });
    const claim = await this.repository.claimStage(command);
    if (!claim.acquired) {
      return { commandId: claim.stageRun.commandId, acquired: false, duplicate: true };
    }
    const receipt = await this._dispatchStageRun(claim.stageRun);
    return { commandId: command.commandId, acquired: true, receipt };
  }

  async _dispatchStageRun(stageRun) {
    try {
      const receipt = await this.bus.dispatch(stageRun.command);
      await this.repository.markDispatched(stageRun.idempotencyKey, receipt || {});
      return receipt || {};
    } catch (error) {
      await this.repository.markDispatchFailed(stageRun.idempotencyKey, error);
      throw error;
    }
  }

  async handleStageResult(result) {
    const completion = await this.repository.completeStage(result);
    // A worker result may be redelivered after the process committed completion
    // but crashed before advancing the graph. Advancing every queued receipt is
    // safe because claimStage transactionally owns runId:stage:attempt.
    if (completion.run.status === 'queued') {
      return this.advance(completion.run.runId);
    }
    // Likewise, recover a next-stage publish that failed after its claim was
    // committed. Limit replay to dispatching (not waiting) commands so ordinary
    // at-least-once result delivery does not generate extra bus traffic.
    if (!completion.applied && completion.duplicate && completion.run.checkpoint.activeCommandId) {
      const active = await this.repository.getStageRun(
        completion.run.runId,
        completion.run.checkpoint.activeCommandId,
      );
      if (active.status === 'dispatching') await this._dispatchStageRun(active);
    }
    return this.status(completion.run.runId);
  }

  async resume(runId, { retryFailed = false, redispatchActive = true } = {}) {
    let run = await this.repository.getRun(runId);
    if (run.status === 'failed') {
      if (!retryFailed) return this.status(runId);
      run = (await this.repository.reopenFailedRun(runId)).run;
    }
    if (TERMINAL_STATUSES.has(run.status)) return this.status(runId);
    if (!run.preflight) {
      const snapshot = await this.preflight.capture(run.start);
      run = (await this.repository.savePreflight(snapshot)).run;
    }
    if (run.checkpoint.activeCommandId) {
      if (redispatchActive) {
        const stageRun = await this.repository.getStageRun(runId, run.checkpoint.activeCommandId);
        await this._dispatchStageRun(stageRun);
      }
      return this.status(runId);
    }
    return this.advance(runId);
  }

  async cancel(runId, options = {}) {
    let cancellation = await this.repository.cancelRun(runId, options);
    if (cancellation.changed && cancellation.activeStage && typeof this.bus.cancel === 'function') {
      try {
        const confirmation = await this.bus.cancel(cancellation.activeStage.command);
        if (
          confirmation === true
          || (confirmation && (confirmation.cancelled === true || confirmation.status === 'cancelled'))
        ) {
          cancellation = await this.repository.confirmCancellation(
            runId,
            cancellation.activeStage.commandId,
            confirmation === true ? { cancelled: true } : confirmation,
          );
        }
      } catch (error) {
        this.log.error(`pipeline cancel notification failed (${error && error.code ? error.code : 'unknown'})`);
      }
    }
    return this.status(runId);
  }

  async status(runId) {
    return this.repository.getStatus(runId);
  }
}

module.exports = { PipelineOrchestrator };
