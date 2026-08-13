'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test, expect } = require('@playwright/test');

const { loadLiveConfig } = require('./support/config');
const {
  PIPELINE_STAGES,
  approveDeployment,
  boundedSafeText,
  freshBrowserBearer,
  jsonRequest,
  latestStageRuns,
  mergeEvidence,
  saveStableVideo,
  setEvidenceHud,
  waitForRun,
} = require('./support/pipeline-evidence');

let config;

function liveConfig() {
  if (!config) config = loadLiveConfig({ requireAuth: true, requireDeploy: true });
  return config;
}

test.describe.configure({ mode: 'serial' });
test.use({
  storageState: path.resolve(
    process.env.E2E_QA_TENANT_A_STATE_PATH || '.playwright-auth/tenant-a.json',
  ),
});

function requiredPipelineFixture(fixtures) {
  const tenantA = fixtures && fixtures.tenantA;
  const task = fixtures && fixtures.pipelineTask;
  if (!tenantA || !tenantA.organizationId || !tenantA.projectId || !tenantA.linearProjectId) {
    throw new Error('E2E_QA_FIXTURES_JSON must define tenantA organizationId, projectId, and linearProjectId.');
  }
  if (!task || typeof task.description !== 'string' || task.description.trim().length < 20) {
    throw new Error('E2E_QA_FIXTURES_JSON must define a precise pipelineTask.description for the disposable QA repository.');
  }
  return { tenantA, task };
}

function issueFromResponse(data) {
  const issue = data && data.issue;
  if (!issue || typeof issue.id !== 'string' || !issue.id) {
    throw new Error('The QA issue endpoint did not return a Linear issue id.');
  }
  return issue;
}

function finalEvidence(status, issue, healthStatus, activeConfig) {
  const latest = latestStageRuns(status);
  const stages = Object.fromEntries(PIPELINE_STAGES.map((stage) => {
    const stageRun = latest.get(stage);
    const artifact = stageRun && stageRun.result && stageRun.result.artifact;
    return [stage, {
      status: stageRun && stageRun.status || 'missing',
      attempt: stageRun && stageRun.attempt || null,
      commandId: stageRun && stageRun.commandId || null,
      artifact: artifact ? { commitSha: artifact.commitSha, treeSha: artifact.treeSha } : null,
    }];
  }));
  const deployment = latest.get('deploy')?.result?.output?.deployment || null;
  return {
    result: 'passed',
    completedAt: new Date().toISOString(),
    runId: status.run.runId,
    issue: { id: issue.id, identifier: issue.identifier || null },
    requestedStages: status.run.requestedStages,
    status: status.run.status,
    stages,
    deployment: deployment ? {
      environment: deployment.environment,
      status: deployment.status,
      conclusion: deployment.conclusion || null,
      url: deployment.url || null,
      commitSha: deployment.commitSha,
      treeSha: deployment.treeSha,
    } : null,
    health: { url: activeConfig.deployHealthUrl, status: healthStatus },
  };
}

test('03 — Tenant A completes the approved plan → code → test → deploy pipeline', async ({ page }, testInfo) => {
  test.setTimeout(75 * 60 * 1_000);
  const startedAt = new Date().toISOString();
  let runId = '';
  let apiBaseUrl = '';
  let token = '';
  let approvalCommitted = false;
  let issue = null;
  let recordedError = null;
  let fixture;
  let activeConfig;

  try {
    // Re-run the strict deploy-specific checks at the last possible point
    // before creating the Linear issue. This is the mutation safety boundary.
    activeConfig = liveConfig();
    fixture = requiredPipelineFixture(activeConfig.fixtures);

    await page.goto('/#/agent');
    await expect(page.locator('.auth-user')).toBeVisible({ timeout: 25_000 });
    await setEvidenceHud(page, 'Full QA pipeline', [
      'target: non-production QA',
      'scope: Tenant A synthetic fixture',
      'status: preflight passed',
    ]);

    ({ token, apiBaseUrl } = await freshBrowserBearer(page));
    const headers = {
      token,
      organizationId: fixture.tenantA.organizationId,
      projectId: fixture.tenantA.projectId,
    };
    const marker = `qa-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const titlePrefix = typeof fixture.task.title === 'string' && fixture.task.title.trim()
      ? fixture.task.title.trim()
      : 'Update the QA deployment canary';
    const created = await jsonRequest(apiBaseUrl, '/api/issues', {
      method: 'POST',
      ...headers,
      body: {
        projectId: fixture.tenantA.linearProjectId,
        title: `[${marker}] ${titlePrefix}`.slice(0, 255),
        description: `${fixture.task.description.trim()}\n\nAuthorized synthetic marker: ${marker}`,
        priority: Number.isInteger(fixture.task.priority) ? fixture.task.priority : 2,
        idempotencyKey: marker,
      },
      expectedStatuses: [200, 201],
    });
    issue = issueFromResponse(created.data);
    await setEvidenceHud(page, 'Full QA pipeline', [
      'fixture: synthetic work item created',
      'requested: plan → code → test → deploy',
      'status: submitting',
    ]);

    const submitted = await jsonRequest(apiBaseUrl, '/api/pipeline/runs', {
      method: 'POST',
      ...headers,
      body: {
        requestedStages: PIPELINE_STAGES,
        request: {
          projectId: fixture.tenantA.linearProjectId,
          linearProjectId: fixture.tenantA.linearProjectId,
          workItem: {
            id: issue.id,
            issueId: issue.id,
            identifier: issue.identifier || issue.id,
            title: issue.title || titlePrefix,
            projectId: fixture.tenantA.linearProjectId,
            linearProjectId: fixture.tenantA.linearProjectId,
          },
          deployment: { environment: activeConfig.deployEnvironment },
        },
      },
      expectedStatuses: [202],
    });
    runId = String(submitted.data && submitted.data.runId || '');
    expect(runId, 'pipeline admission returns a run id').not.toBe('');
    expect(submitted.data.requestedStages).toEqual(PIPELINE_STAGES);

    const deadline = Date.now() + 60 * 60 * 1_000;
    const load = async () => (await jsonRequest(
      apiBaseUrl,
      `/api/pipeline/runs/${encodeURIComponent(runId)}`,
      { ...headers, expectedStatuses: [200] },
    )).data;
    const awaiting = await waitForRun({
      load,
      page,
      deadline,
      stopStatuses: ['awaiting_approval', 'failed', 'cancelled', 'succeeded'],
    });
    expect(awaiting.run.status, 'QA requires a post-test operator approval').toBe('awaiting_approval');
    for (const stage of ['plan', 'code', 'test']) {
      expect(latestStageRuns(awaiting).get(stage)?.status, `${stage} succeeds before approval`).toBe('succeeded');
    }
    expect(latestStageRuns(awaiting).has('deploy'), 'deploy is not claimed before approval').toBe(false);

    await setEvidenceHud(page, 'Full QA pipeline', [
      'plan: succeeded', 'code: succeeded', 'test: succeeded',
      'deploy: awaiting protected approval',
    ]);
    ({ token, apiBaseUrl } = await freshBrowserBearer(page));
    await approveDeployment({
      token,
      apiBaseUrl,
      settingsUrl: activeConfig.settingsUrl,
      organizationId: fixture.tenantA.organizationId,
      projectId: fixture.tenantA.projectId,
      repository: activeConfig.repository,
      environment: activeConfig.deployEnvironment,
      runId,
      cwd: path.resolve(__dirname, '..'),
    });
    approvalCommitted = true;
    await jsonRequest(apiBaseUrl, `/api/pipeline/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      token,
      organizationId: fixture.tenantA.organizationId,
      projectId: fixture.tenantA.projectId,
      body: { retryFailed: false },
      expectedStatuses: [200],
    });

    const final = await waitForRun({
      load: async () => (await jsonRequest(
        apiBaseUrl,
        `/api/pipeline/runs/${encodeURIComponent(runId)}`,
        {
          token,
          organizationId: fixture.tenantA.organizationId,
          projectId: fixture.tenantA.projectId,
          expectedStatuses: [200],
        },
      )).data,
      page,
      deadline,
      stopStatuses: ['succeeded', 'failed', 'cancelled'],
    });
    expect(final.run.status).toBe('succeeded');
    expect(final.run.requestedStages).toEqual(PIPELINE_STAGES);
    const latest = latestStageRuns(final);
    for (const stage of PIPELINE_STAGES) expect(latest.get(stage)?.status, `${stage} stage status`).toBe('succeeded');

    const codeArtifact = latest.get('code').result.artifact;
    const testArtifact = latest.get('test').result.artifact;
    const deployArtifact = latest.get('deploy').result.artifact;
    expect(testArtifact).toEqual(codeArtifact);
    expect(deployArtifact).toEqual(testArtifact);
    const receipt = latest.get('deploy').result.output.deployment;
    expect(receipt.status).toBe('succeeded');
    expect(receipt.environment).toBe(activeConfig.deployEnvironment);
    expect({ commitSha: receipt.commitSha, treeSha: receipt.treeSha }).toEqual(deployArtifact);

    const health = await fetch(activeConfig.deployHealthUrl, { redirect: 'manual' });
    expect(health.status, 'deployed QA health endpoint').toBeGreaterThanOrEqual(200);
    expect(health.status, 'deployed QA health endpoint').toBeLessThan(300);
    await setEvidenceHud(page, 'Full QA pipeline — PASS', [
      'plan: succeeded', 'code: succeeded', 'test: succeeded',
      `deploy (${activeConfig.deployEnvironment}): succeeded`,
      `health: HTTP ${health.status}`,
    ]);
    mergeEvidence(activeConfig.evidenceDir, 'fullPipeline', finalEvidence(final, issue, health.status, activeConfig));
  } catch (error) {
    recordedError = error;
    if (runId && token && apiBaseUrl && !approvalCommitted && fixture) {
      try {
        await jsonRequest(apiBaseUrl, `/api/pipeline/runs/${encodeURIComponent(runId)}/cancel`, {
          method: 'POST',
          token,
          organizationId: fixture.tenantA.organizationId,
          projectId: fixture.tenantA.projectId,
          body: { reason: 'QA E2E failed before deployment approval.' },
          expectedStatuses: [200],
        });
      } catch (_) {
        // Best effort: preserve the original failure and the server audit trail.
      }
    }
    try {
      await setEvidenceHud(page, 'Full QA pipeline — FAIL', [boundedSafeText(error.message)]);
    } catch (_) {
      // Page may already have closed after a browser-level failure.
    }
    const evidenceDir = activeConfig
      ? activeConfig.evidenceDir
      : path.resolve(__dirname, '..', 'test-results', 'live-evidence');
    mergeEvidence(evidenceDir, 'fullPipeline', {
      result: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      runId: runId || null,
      issue: issue ? { id: issue.id, identifier: issue.identifier || null } : null,
      error: boundedSafeText(error.message),
    });
  } finally {
    const evidenceDir = activeConfig
      ? activeConfig.evidenceDir
      : path.resolve(__dirname, '..', 'test-results', 'live-evidence');
    try { await saveStableVideo(page, evidenceDir, '03-full-pipeline.webm', testInfo); } catch (_) { /* retain Playwright's native video */ }
  }
  if (recordedError) throw recordedError;
});
