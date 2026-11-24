'use strict';

const { createPreflightSnapshot } = require('@software-factory/shared-core/pipeline/contracts');

/**
 * Default secret-free snapshot builder. Deployments can inject a resolver that
 * verifies repository/work-item access and returns the same contract. Secret
 * material stays behind the settings/egress proxy and is never returned here.
 */
class SnapshotPreflight {
  constructor({
    clock = () => new Date().toISOString(),
  } = {}) {
    this.clock = clock;
  }

  async capture(start) {
    if (start.requestedStages.includes('deploy')) {
      const error = new Error(
        'The pipeline deploy stage is retired; runs end after test.',
      );
      error.code = 'pipeline_deploy_retired';
      error.status = 410;
      throw error;
    }
    const request = start.request || {};
    const requestedStageConfiguration = request.stageConfiguration || {};
    const stageConfiguration = { ...requestedStageConfiguration };
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
