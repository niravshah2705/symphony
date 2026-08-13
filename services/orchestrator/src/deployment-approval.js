'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');

let googleAuth = null;
const idTokenClients = new Map();
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function originOf(value) {
  try { return new URL(value).origin; } catch (_) { return value; }
}

async function idTokenHeader(audience) {
  if (!googleAuth) {
    const { GoogleAuth } = require('google-auth-library');
    googleAuth = new GoogleAuth();
  }
  if (!idTokenClients.has(audience)) {
    idTokenClients.set(audience, await googleAuth.getIdTokenClient(audience));
  }
  const headers = await idTokenClients.get(audience).getRequestHeaders();
  if (typeof headers.get === 'function') return headers.get('authorization') || '';
  return headers.Authorization || headers.authorization || '';
}

class SettingsDeploymentApproval {
  constructor({
    settingsUrl = CONFIG.SERVICES.settingsUrl,
    internalToken = process.env.INTERNAL_API_TOKEN,
    cloud = CONFIG.MESSAGING_MODE === 'pubsub',
    fetchImpl = globalThis.fetch,
    identityHeader = idTokenHeader,
  } = {}) {
    this.settingsUrl = String(settingsUrl || '').replace(/\/+$/, '');
    this.internalToken = String(internalToken || '').trim();
    this.cloud = cloud;
    this.fetch = fetchImpl;
    this.identityHeader = identityHeader;
  }

  async assertApproved({ run, testResult }) {
    if (!this.settingsUrl || !this.internalToken || typeof this.fetch !== 'function') {
      return null;
    }
    const repository = run.preflight && run.preflight.repository || {};
    const configuration = run.preflight
      && run.preflight.stageConfiguration
      && run.preflight.stageConfiguration.deploy || {};
    const repositoryName = String(
      repository.fullName
      || (repository.owner && repository.name ? `${repository.owner}/${repository.name}` : ''),
    ).trim();
    const artifact = testResult && (testResult.artifact || (testResult.output && testResult.output.artifact)) || {};
    const testCommandId = String(testResult && testResult.commandId || '').trim();
    const commitSha = String(artifact.commitSha || '').trim().toLowerCase();
    const treeSha = String(artifact.treeSha || '').trim().toLowerCase();
    const preflightDecisionDigest = String(
      run.preflight && run.preflight.preflightDecisionDigest || '',
    ).trim().toLowerCase();
    if (
      !testCommandId
      || !REPOSITORY_RE.test(repositoryName)
      || !SHA_RE.test(commitSha)
      || !SHA_RE.test(treeSha)
      || !DIGEST_RE.test(preflightDecisionDigest)
    ) {
      const error = new Error('The tested immutable deployment lineage is unavailable.');
      error.code = 'pipeline_deployment_lineage_required';
      error.status = 409;
      throw error;
    }
    const headers = {
      'content-type': 'application/json',
      'x-internal-token': this.internalToken,
    };
    if (this.cloud) {
      const authorization = await this.identityHeader(originOf(this.settingsUrl));
      if (authorization) headers.authorization = authorization;
    }
    const response = await this.fetch(
      `${this.settingsUrl}/api/v1/internal/s2s/orgs/${encodeURIComponent(run.organizationId)}`
        + `/deployment-approvals/${encodeURIComponent(run.runId)}/consume`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectId: run.projectId,
          repository: repositoryName,
          environment: configuration.environment,
          testCompletedAt: testResult.completedAt,
          testCommandId,
          commitSha,
          treeSha,
          preflightDecisionDigest,
        }),
      },
    );
    if (response && [404, 409].includes(response.status)) return null;
    if (!response || !response.ok) {
      const error = new Error('Deployment approval service is unavailable.');
      error.code = 'pipeline_deployment_approval_unavailable';
      error.status = 503;
      throw error;
    }
    const value = await response.json();
    const returned = {
      testCommandId: value && (value.testCommandId || value.test_command_id),
      commitSha: value && (value.commitSha || value.commit_sha),
      treeSha: value && (value.treeSha || value.tree_sha),
      preflightDecisionDigest: value && (
        value.preflightDecisionDigest || value.preflight_decision_digest
      ),
    };
    if (
      returned.testCommandId !== testCommandId
      || returned.commitSha !== commitSha
      || returned.treeSha !== treeSha
      || returned.preflightDecisionDigest !== preflightDecisionDigest
    ) {
      const error = new Error('Deployment approval did not match the tested immutable lineage.');
      error.code = 'pipeline_deployment_approval_invalid';
      error.status = 503;
      throw error;
    }
    return {
      approved: value && value.approved === true,
      approvalId: value && (value.approvalId || value.approval_id),
      by: value && (value.approvedBy || value.approved_by),
      at: value && (value.approvedAt || value.approved_at),
      ...returned,
    };
  }
}

module.exports = { SettingsDeploymentApproval, idTokenHeader, originOf };
