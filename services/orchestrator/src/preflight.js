'use strict';

const { createPreflightSnapshot } = require('@ai-fleet/shared-core/pipeline/contracts');

/**
 * Default secret-free snapshot builder. Deployments can inject a resolver that
 * verifies repository/work-item access and returns the same contract. Secret
 * material stays behind the settings/egress proxy and is never returned here.
 */
class SnapshotPreflight {
  constructor({
    clock = () => new Date().toISOString(),
    deploymentEnabled = false,
  } = {}) {
    this.clock = clock;
    this.deploymentEnabled = deploymentEnabled;
  }

  async capture(start) {
    if (start.requestedStages.includes('deploy')) {
      if (!this.deploymentEnabled) {
        const error = new Error('Deployment is disabled for this orchestrator.');
        error.code = 'pipeline_deployment_disabled';
        error.status = 403;
        throw error;
      }
    }
    const request = start.request || {};
    const requestedStageConfiguration = request.stageConfiguration || {};
    const stageConfiguration = { ...requestedStageConfiguration };
    if (start.requestedStages.includes('deploy')) {
      // A caller-provided approval is untrusted input. Approval is checked only
      // after the tester succeeds, then attached to the deploy StageCommand by
      // the orchestrator. It is never accepted into this immutable snapshot.
      stageConfiguration.deploy = {
        ...(requestedStageConfiguration.deploy || {}),
        approval: null,
      };
    }
    return createPreflightSnapshot({
      runId: start.runId,
      organizationId: start.organizationId,
      projectId: start.projectId,
      requestedStages: start.requestedStages,
      repository: request.repository || {},
      workItem: request.workItem || {},
      stageConfiguration,
      policy: request.policy || {},
      // The start receipt is immutable, so it also gives concurrent retries a
      // deterministic snapshot timestamp before the snapshot is persisted.
      capturedAt: start.createdAt,
      metadata: {
        correlationId: start.correlationId,
        source: 'pipeline-start',
      },
    }, { clock: this.clock });
  }
}

module.exports = { SnapshotPreflight };
