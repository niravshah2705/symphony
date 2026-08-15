'use strict';

const crypto = require('node:crypto');
const store = require('../store');
const framework = require('./framework');
const testingWorkflow = require('./workflows/testing.workflow');
const deploymentWorkflow = require('./workflows/deployment.workflow');
const { resolveLlm } = require('./llm');
const { registry: harnessRegistry } = require('./harnesses');
const { preparePlannedWorkspace, sanitizeBranch } = require('./workspace');
const { redactSecrets, runCommand, sanitizedToolEnv } = require('./tools/exec');
const { pickTestRunner } = require('./tools/quality');

const FULL_DEPLOYMENT_SEQUENCE = Object.freeze(['plan', 'code', 'test', 'deploy']);
const POLICY_DOMAINS = Object.freeze(['harness', 'tools', 'skills', 'plugins', 'hooks', 'models']);
const CHECK_STATUSES = new Set(['passed', 'failed', 'skipped']);
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

class StageExecutionError extends Error {
  constructor(message, code, { retryable = false } = {}) {
    super(message);
    this.name = 'StageExecutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

function stageConfiguration(command, stage = command && command.stage) {
  const configuration = command && command.preflight && command.preflight.stageConfiguration;
  const value = configuration && configuration[stage];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function priorResult(command, stage) {
  const results = command && command.input && command.input.priorResults;
  return (Array.isArray(results) ? results : []).find(
    (candidate) => candidate && candidate.stage === stage && candidate.output && typeof candidate.output === 'object',
  ) || null;
}

function immutableArtifact(value, field = 'artifact') {
  const artifact = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const commitSha = String(artifact.commitSha || '').trim().toLowerCase();
  const treeSha = String(artifact.treeSha || '').trim().toLowerCase();
  if (!SHA_RE.test(commitSha) || !SHA_RE.test(treeSha)) {
    throw new StageExecutionError(`${field} must contain an exact GitHub commit and tree SHA.`, 'immutable_artifact_required');
  }
  return Object.freeze({ commitSha, treeSha });
}

function artifactFromResult(result, stage) {
  if (!result || result.status !== 'succeeded') {
    throw new StageExecutionError(`A successful ${stage} artifact is required.`, 'immutable_artifact_required');
  }
  const artifact = immutableArtifact(result.artifact, `${stage} artifact`);
  if (result.output && result.output.artifact) {
    const projected = immutableArtifact(result.output.artifact, `${stage} output artifact`);
    if (!sameArtifact(artifact, projected)) {
      throw new StageExecutionError(
        `The ${stage} result contains contradictory artifact revisions.`,
        'immutable_artifact_mismatch',
      );
    }
  }
  return artifact;
}

function sameArtifact(left, right) {
  return left.commitSha === right.commitSha && left.treeSha === right.treeSha;
}

function preflightDecisionDigest(command) {
  const digest = String(command && command.preflight && command.preflight.preflightDecisionDigest || '').trim().toLowerCase();
  if (!DIGEST_RE.test(digest)) {
    throw new StageExecutionError('The immutable preflight decision digest is unavailable.', 'preflight_decision_digest_required');
  }
  return digest;
}

function evidencePayload(value) {
  return {
    source: 'pipeline-tester',
    trusted: true,
    commandId: String(value.commandId || ''),
    commitSha: String(value.commitSha || '').toLowerCase(),
    treeSha: String(value.treeSha || '').toLowerCase(),
    name: boundedString(value.name, 160),
    runner: boundedString(value.runner, 80),
    command: boundedString(value.command, 500),
    status: CHECK_STATUSES.has(value.status) ? value.status : 'failed',
    exitCode: Number.isSafeInteger(value.exitCode) ? value.exitCode : null,
    timedOut: value.timedOut === true,
    startedAt: String(value.startedAt || ''),
    completedAt: String(value.completedAt || ''),
    outputDigest: String(value.outputDigest || '').toLowerCase(),
  };
}

function stampTrustedEvidence(value, command, artifact, { clock = () => new Date().toISOString() } = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = redactSecrets(String(raw.output || raw.stdout || '') + String(raw.stderr || ''));
  const payload = evidencePayload({
    ...raw,
    commandId: command.idempotencyKey,
    commitSha: artifact.commitSha,
    treeSha: artifact.treeSha,
    startedAt: raw.startedAt || clock(),
    completedAt: raw.completedAt || clock(),
    outputDigest: DIGEST_RE.test(String(raw.outputDigest || '').toLowerCase())
      ? String(raw.outputDigest).toLowerCase()
      : crypto.createHash('sha256').update(output).digest('hex'),
  });
  if (!payload.name || !payload.runner || !payload.command || !validApprovalTime(payload.startedAt) || !validApprovalTime(payload.completedAt)) {
    throw new StageExecutionError('Trusted test evidence is incomplete.', 'trusted_test_evidence_required');
  }
  const evidenceDigest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return Object.freeze({ ...payload, evidenceDigest });
}

function validateTrustedEvidence(values, commandId, artifact) {
  const evidence = Array.isArray(values) ? values : [];
  if (!evidence.length) {
    throw new StageExecutionError('The tester produced no trusted check evidence.', 'trusted_test_evidence_required');
  }
  let passed = false;
  for (const item of evidence) {
    const payload = evidencePayload(item || {});
    const expectedDigest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (
      item.source !== 'pipeline-tester'
      || item.trusted !== true
      || item.evidenceDigest !== expectedDigest
      || payload.commandId !== commandId
      || payload.commitSha !== artifact.commitSha
      || payload.treeSha !== artifact.treeSha
      || !payload.name
      || !payload.runner
      || !payload.command
      || !DIGEST_RE.test(payload.outputDigest)
      || !validApprovalTime(payload.startedAt)
      || !validApprovalTime(payload.completedAt)
    ) {
      throw new StageExecutionError('Trusted test evidence does not match its command and artifact.', 'trusted_test_evidence_mismatch');
    }
    if (payload.status === 'failed') {
      throw new StageExecutionError('A trusted repository check failed.', 'tests_failed');
    }
    if (payload.status === 'passed') {
      if (payload.timedOut || (payload.exitCode !== null && payload.exitCode !== 0)) {
        throw new StageExecutionError('Trusted passing evidence has a failing process outcome.', 'tests_failed');
      }
      passed = true;
    }
  }
  if (!passed) {
    throw new StageExecutionError('Skipped-only checks are not successful test evidence.', 'trusted_test_evidence_required');
  }
  return evidence;
}

async function defaultTrustedChecks(workspace, {
  clock = () => new Date().toISOString(),
  isolateNetwork = process.env.NODE_ENV === 'production',
} = {}) {
  const runner = pickTestRunner(workspace.workDir);
  if (!runner) {
    return [{
      name: 'repository test suite',
      runner: 'none',
      command: 'no supported repository test command',
      status: 'failed',
      exitCode: null,
      output: 'No supported repository test runner was detected.',
      startedAt: clock(),
      completedAt: clock(),
    }];
  }
  const startedAt = clock();
  const { env } = sanitizedToolEnv({ ...process.env, ...(workspace.env || {}) });
  const result = await runCommand(runner.command, runner.args, {
    cwd: workspace.workDir,
    env,
    isolateNetwork,
  });
  return [{
    name: `repository tests (${runner.key})`,
    runner: runner.key,
    command: `${runner.command} ${runner.args.join(' ')}`.trim(),
    status: result.ok ? 'passed' : 'failed',
    exitCode: Number.isSafeInteger(result.code) ? result.code : null,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    startedAt,
    completedAt: clock(),
  }];
}

function trustedTestContext(command) {
  const code = priorResult(command, 'code');
  const test = priorResult(command, 'test');
  const codeArtifact = artifactFromResult(code, 'code');
  const testArtifact = artifactFromResult(test, 'test');
  if (!sameArtifact(codeArtifact, testArtifact)) {
    throw new StageExecutionError('The tested artifact differs from the coded artifact.', 'tested_artifact_mismatch');
  }
  const commandId = String(test && test.commandId || '').trim();
  if (!commandId) {
    throw new StageExecutionError('The successful test command id is unavailable.', 'trusted_test_evidence_required');
  }
  const evidence = validateTrustedEvidence(test.output && test.output.testEvidence, commandId, testArtifact);
  return Object.freeze({ artifact: testArtifact, commandId, evidence });
}

function sameSequence(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((stage, index) => stage === expected[index]);
}

function validApprovalTime(value) {
  return typeof value === 'string' && value && !Number.isNaN(Date.parse(value));
}

/** Fail-closed deployment gate. Production approval is a durable, run-bound
 * orchestrator input injected only after the tester checkpoint; preflight
 * configuration is immutable caller-era data and is never approval authority. */
function assertDeploymentAllowed(command) {
  if (!command || command.stage !== 'deploy') {
    throw new StageExecutionError('A deploy StageCommand is required.', 'invalid_deploy_command');
  }
  if (!sameSequence(command.requestedStages, FULL_DEPLOYMENT_SEQUENCE)) {
    throw new StageExecutionError(
      'Deployment requires the full plan -> code -> test -> deploy sequence.',
      'deployment_sequence_required',
    );
  }
  const completedPrefix = FULL_DEPLOYMENT_SEQUENCE.slice(0, -1);
  if (!completedPrefix.every((stage) => {
    const result = priorResult(command, stage);
    return result && result.status === 'succeeded';
  })) {
    throw new StageExecutionError(
      'Deployment requires successful plan, code, and tester completions.',
      'successful_test_required',
    );
  }
  const configuration = stageConfiguration(command, 'deploy');
  if (configuration.enabled !== true) {
    throw new StageExecutionError('Deployment is disabled unless deploy.enabled is explicitly true.', 'deployment_disabled');
  }
  const environment = String(configuration.environment || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(environment)) {
    throw new StageExecutionError('A valid deployment environment is required.', 'invalid_deployment_environment');
  }
  const production = environment === 'production' || environment === 'prod';
  const tested = trustedTestContext(command);
  const decisionDigest = preflightDecisionDigest(command);
  const approval = command && command.input && command.input.deploymentApproval;
  if (production) {
    const approvedBy = approval && (approval.by || approval.approvedBy);
    const approvedAt = approval && (approval.at || approval.approvedAt);
    if (
      !approval
      || approval.approved !== true
      || approval.source !== 'server'
      || typeof approvedBy !== 'string'
      || !approvedBy.trim()
      || !validApprovalTime(approvedAt)
      || approval.testCommandId !== tested.commandId
      || approval.commitSha !== tested.artifact.commitSha
      || approval.treeSha !== tested.artifact.treeSha
      || approval.preflightDecisionDigest !== decisionDigest
    ) {
      throw new StageExecutionError(
        'Production deployment requires a trusted server-side approval.',
        'deployment_approval_required',
      );
    }
  }
  return {
    configuration,
    environment,
    production,
    artifact: tested.artifact,
    testCommandId: tested.commandId,
    preflightDecisionDigest: decisionDigest,
  };
}

function repositoryReference(command) {
  const repository = (command && command.preflight && command.preflight.repository) || {};
  const provider = String(repository.provider || '').trim().toLowerCase();
  if (provider !== 'github') {
    throw new StageExecutionError(
      'Fixed test and deploy stages currently require a brokered GitHub repository.',
      provider === 'gitlab' ? 'repository_provider_not_brokered' : 'repository_not_configured',
    );
  }
  const repoUrl = repository.url
    || repository.https
    || repository.fullName
    || (repository.owner && repository.name ? `${repository.owner}/${repository.name}` : '');
  if (!repoUrl) throw new StageExecutionError('Repository identity is incomplete.', 'repository_not_configured');
  return {
    provider,
    repoUrl: String(repoUrl),
    name: String(repository.fullName || repository.name || repoUrl).slice(0, 160),
  };
}

/** Bind an external Linear project to the exact native AI Fleet project that
 * admitted the command. Organization-scoped storage alone is insufficient: an
 * organization may contain several native projects and several Linear links. */
function assertLinearProjectScope(command, linearProjectId, storeImpl = store) {
  const externalId = String(linearProjectId || '').trim();
  const expectedProjectId = String(command && command.projectId || '').trim();
  const expectedOrganizationId = String(command && command.organizationId || '').trim();
  const business = externalId && storeImpl && typeof storeImpl.getBusinessByProjectId === 'function'
    ? storeImpl.getBusinessByProjectId(externalId)
    : null;
  const actualProjectId = String(business && business.nativeProjectId || '').trim();
  const actualOrganizationId = String(
    business && (business.orgId || business.organizationId) || '',
  ).trim();
  if (
    !business
    || !expectedProjectId
    || actualProjectId !== expectedProjectId
    || (actualOrganizationId && actualOrganizationId !== expectedOrganizationId)
  ) {
    throw new StageExecutionError(
      'The Linear project is not linked to the admitted AI Fleet project.',
      'linear_project_scope_mismatch',
    );
  }
  return business;
}

function sourceBranch(command) {
  const code = priorResult(command, 'code');
  const request = (command && command.input && command.input.request) || {};
  const workItem = (command && command.preflight && command.preflight.workItem) || {};
  return sanitizeBranch(
    (code && (code.output.branch || code.output.sourceBranch))
      || request.branch
      || workItem.identifier
      || `${command.runId}-${command.stage}`,
  );
}

async function prepareStageWorkspace(command, dependencies = {}) {
  const storeImpl = dependencies.store || store;
  const prepare = dependencies.prepareWorkspace || preparePlannedWorkspace;
  const repository = repositoryReference(command);
  const token = typeof storeImpl.getRepositoryToken === 'function'
    ? storeImpl.getRepositoryToken(repository.provider)
    : '';
  return prepare({
    repoUrl: repository.repoUrl,
    repositoryProvider: repository.provider,
    projectSlug: repository.name,
    projectId: `${command.projectId}:${command.runId}`,
    taskBranch: sourceBranch(command),
    repositoryToken: token,
    onStep: dependencies.step,
  });
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function effectivePolicySnapshot(command) {
  const policy = command && command.preflight && command.preflight.policy;
  const effective = policy && policy.effectivePolicy;
  if (!plainObject(effective)) {
    throw new StageExecutionError('The initiating user policy snapshot is unavailable.', 'policy_snapshot_required');
  }
  for (const domain of POLICY_DOMAINS) {
    const value = effective[domain];
    if (
      !plainObject(value)
      || !Array.isArray(value.effective)
      || value.effective.some((item) => typeof item !== 'string' || !item.trim())
    ) {
      throw new StageExecutionError(
        `The initiating user policy snapshot is missing the ${domain} allowlist.`,
        'policy_snapshot_incomplete',
      );
    }
  }
  return effective;
}

async function resolveStageAgent(command, { role, workflowStage }, dependencies = {}) {
  const storeImpl = dependencies.store || store;
  const settings = dependencies.settings || storeImpl.getSettings();
  const resolveModel = dependencies.resolveLlm || resolveLlm;
  const policySnapshot = command && command.preflight && command.preflight.policy;
  const effectivePolicy = effectivePolicySnapshot(command);
  const prefs = plainObject(policySnapshot.prefs) ? policySnapshot.prefs : {};
  // Per-request LLM gateway flag, admitted with the run and carried in the
  // command's request bag. It changes ROUTING only — never provider or model —
  // so the live-vs-snapshot cross-checks below stay valid for flagged runs.
  const admittedRequest = (command && command.input && command.input.request) || {};
  const llmGateway = admittedRequest.llmGateway === 'langsmith' ? 'langsmith' : '';
  const resolvedLlm = await resolveModel(llmGateway ? { ...settings, llmGateway } : settings, role);
  const configuration = stageConfiguration(command);
  if (
    typeof configuration.harness !== 'string'
    || !configuration.harness.trim()
    || typeof configuration.provider !== 'string'
    || !configuration.provider.trim()
    || typeof configuration.model !== 'string'
    || !configuration.model.trim()
    || typeof configuration.modelId !== 'string'
    || !configuration.modelId.trim()
    || configuration.providerReady !== true
    || configuration.brokered !== true
  ) {
    throw new StageExecutionError('The stage execution snapshot is incomplete.', 'stage_snapshot_incomplete');
  }
  if (resolvedLlm.provider !== configuration.provider || resolvedLlm.model !== configuration.model) {
    throw new StageExecutionError(
      'The live model selection no longer matches the admitted stage snapshot.',
      'stage_model_snapshot_mismatch',
    );
  }
  if (!effectivePolicy.harness.effective.includes(configuration.harness)) {
    throw new StageExecutionError(
      'The selected harness is not authorized by the initiating user policy snapshot.',
      'stage_harness_snapshot_mismatch',
    );
  }
  if (
    effectivePolicy.models.effective.length > 0
    && !effectivePolicy.models.effective.includes(configuration.modelId)
  ) {
    throw new StageExecutionError(
      'The selected model is not authorized by the initiating user policy snapshot.',
      'stage_model_snapshot_mismatch',
    );
  }
  const llm = resolvedLlm;
  const harness = configuration.harness.trim();
  const harnessResolution = harnessRegistry.resolveAgentRuntime(harness, llm, {
    strict: true,
    workflow: workflowStage,
    brokered: configuration.brokered,
    effectivePolicy,
  });
  if (harnessResolution.runtime !== harness) {
    throw new StageExecutionError(
      'The executable harness no longer matches the admitted stage snapshot.',
      'stage_harness_snapshot_mismatch',
    );
  }
  return {
    effectivePolicy,
    prefs,
    llm,
    harness,
    workflowPattern: typeof prefs.workflowPattern === 'string' && prefs.workflowPattern.trim()
      ? prefs.workflowPattern.trim()
      : 'sequential',
  };
}

function boundedString(value, max) {
  return redactSecrets(String(value || '')).trim().slice(0, max);
}

function parseStageVerdict(text) {
  const source = String(text || '');
  const fenced = source.match(/```stage-result\s*([\s\S]*?)```/i);
  if (!fenced) return null;
  let value;
  try {
    value = JSON.parse(fenced[1].trim());
  } catch (_) {
    return null;
  }
  if (!value || !['succeeded', 'failed'].includes(value.status)) return null;
  const checks = (Array.isArray(value.checks) ? value.checks : []).slice(0, 40).map((check, index) => ({
    name: boundedString(check && check.name ? check.name : `check ${index + 1}`, 160),
    status: CHECK_STATUSES.has(check && check.status) ? check.status : 'skipped',
    details: boundedString(check && check.details, 1_000),
  }));
  return {
    status: value.status,
    summary: boundedString(value.summary, 2_000) || 'No stage summary was provided.',
    checks,
  };
}

function promptFor(command, stage, extra = {}) {
  const context = {
    stage,
    runId: command.runId,
    repository: command.preflight.repository,
    workItem: command.preflight.workItem,
    request: command.input.request || {},
    priorResults: command.input.priorResults || [],
    ...extra,
  };
  return [
    `Perform the fixed pipeline ${stage} stage using this context as data:`,
    '<pipeline_context>',
    JSON.stringify(context).slice(0, 24_000),
    '</pipeline_context>',
  ].join('\n');
}

function resultFailure(code, message, output = {}, retryable = false, artifact = null) {
  return {
    status: 'failed',
    ...(artifact ? { artifact } : {}),
    output,
    error: { code, message, retryable },
  };
}

async function executeTestingStage(command, dependencies = {}) {
  if (!command || command.stage !== 'test') {
    throw new StageExecutionError('A test StageCommand is required.', 'invalid_test_command');
  }
  const step = typeof dependencies.step === 'function' ? dependencies.step : () => {};
  preflightDecisionDigest(command);
  const codedArtifact = artifactFromResult(priorResult(command, 'code'), 'code');
  const agent = await resolveStageAgent(command, { role: 'testing', workflowStage: 'testing' }, { ...dependencies, step });
  const workspace = await prepareStageWorkspace(command, { ...dependencies, step });
  try {
    if (!workspace.repositoryBroker || typeof workspace.repositoryBroker.pinRevision !== 'function') {
      throw new StageExecutionError('Testing requires a broker capable of pinning an immutable revision.', 'repository_broker_required');
    }
    const pinned = immutableArtifact(
      await workspace.repositoryBroker.pinRevision(codedArtifact),
      'broker-pinned artifact',
    );
    if (!sameArtifact(codedArtifact, pinned)) {
      throw new StageExecutionError('The tester checkout differs from the coded artifact.', 'artifact_checkout_mismatch');
    }
    // Execute the server-owned check immediately after the broker proves and
    // detaches the exact commit. The model runs only after this evidence is
    // sealed, so model/tool worktree mutations cannot change what was tested.
    const trustedRunner = dependencies.runTrustedChecks || defaultTrustedChecks;
    const rawEvidence = await trustedRunner(workspace, {
      command,
      artifact: pinned,
      clock: dependencies.clock,
      step,
    });
    const clock = typeof dependencies.clock === 'function' ? dependencies.clock : () => new Date().toISOString();
    const testEvidence = (Array.isArray(rawEvidence) ? rawEvidence : []).map(
      (item) => stampTrustedEvidence(item, command, pinned, { clock }),
    );
    try {
      validateTrustedEvidence(testEvidence, command.idempotencyKey, pinned);
    } catch (error) {
      return resultFailure(error.code || 'tests_failed', error.message, {
        summary: error.message,
        checks: [],
        selectedHarness: agent.harness,
        harness: agent.harness,
        provider: agent.llm.provider,
        model: agent.llm.model,
        branch: workspace.branch,
        artifact: pinned,
        testEvidence,
      }, false, pinned);
    }
    const runWorkflow = dependencies.runWorkflow || framework.runWorkflow;
    const execution = await runWorkflow({
      workflow: testingWorkflow,
      llm: agent.llm,
      userMessage: promptFor(command, 'test'),
      rootDir: workspace.workDir,
      skillPaths: [],
      ctx: {
        cwd: workspace.workDir,
        rootDir: workspace.workDir,
        step,
        effectivePolicy: agent.effectivePolicy,
        // Every repository-native command exposed to the tester model must use
        // the same fail-closed seccomp launcher as the authoritative first pass.
        isolateNetwork: process.env.NODE_ENV === 'production',
      },
      invokeConfig: {
        runName: `pipeline:test:${command.runId}`,
        tags: testingWorkflow.tags,
        metadata: { pipeline_run_id: command.runId, pipeline_stage: 'test', pipeline_attempt: command.attempt },
      },
      runtime: agent.harness,
      workflowPattern: agent.workflowPattern,
      env: workspace.env,
      // Workflow behavior comes from the initiating user's immutable preflight
      // preference snapshot. Fresh store settings are used only to resolve the
      // live model/credential descriptor above.
      settings: agent.prefs,
      attribution: {
        orgId: command.organizationId,
        projectId: command.projectId,
        taskId: command.preflight.workItem && command.preflight.workItem.id,
        source: 'tester',
      },
    });
    const verdict = parseStageVerdict(execution.finalText);
    const baseOutput = {
      summary: verdict ? verdict.summary : 'Tester did not emit a valid stage result.',
      checks: verdict ? verdict.checks : [],
      selectedHarness: agent.harness,
      harness: execution.runtime || agent.harness,
      provider: agent.llm.provider,
      model: agent.llm.model,
      branch: workspace.branch,
      artifact: pinned,
      testEvidence,
    };
    if (
      !verdict
      || verdict.status !== 'succeeded'
      || verdict.checks.some((check) => check.status === 'failed')
    ) {
      return resultFailure('tests_failed', baseOutput.summary, baseOutput, false, pinned);
    }
    return { status: 'succeeded', artifact: pinned, output: baseOutput };
  } finally {
    if (workspace.repositoryBroker) workspace.repositoryBroker.dispose();
  }
}

function publicDeploymentReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  return {
    provider: boundedString(receipt.provider, 80),
    environment: boundedString(receipt.environment, 40),
    workflow: receipt.workflow ? boundedString(receipt.workflow, 120) : null,
    ref: boundedString(receipt.ref, 120),
    sourceRef: boundedString(receipt.sourceRef, 120),
    commandId: boundedString(receipt.commandId, 160),
    commitSha: boundedString(receipt.commitSha, 40).toLowerCase(),
    treeSha: boundedString(receipt.treeSha, 40).toLowerCase(),
    runId: Number.isSafeInteger(Number(receipt.runId)) ? Number(receipt.runId) : null,
    url: typeof receipt.url === 'string' && /^https:\/\//.test(receipt.url) ? receipt.url.slice(0, 1_000) : null,
    status: receipt.status === 'succeeded' ? 'succeeded' : receipt.status === 'failed' ? 'failed' : 'waiting',
    conclusion: boundedString(receipt.conclusion, 80),
  };
}

async function executeDeploymentStage(command, dependencies = {}) {
  const gate = assertDeploymentAllowed(command);
  const step = typeof dependencies.step === 'function' ? dependencies.step : () => {};
  const agent = await resolveStageAgent(command, { role: 'deployment', workflowStage: 'deployment' }, { ...dependencies, step });
  const workspace = await prepareStageWorkspace(command, { ...dependencies, step });
  if (!workspace.repositoryBroker) {
    throw new StageExecutionError('Deployment requires a brokered repository.', 'repository_broker_required');
  }
  try {
    if (typeof workspace.repositoryBroker.pinRevision !== 'function') {
      throw new StageExecutionError('Deployment requires immutable revision pinning.', 'repository_broker_required');
    }
    const pinned = immutableArtifact(
      await workspace.repositoryBroker.pinRevision(gate.artifact),
      'broker-pinned deployment artifact',
    );
    if (!sameArtifact(pinned, gate.artifact)) {
      throw new StageExecutionError('The deployer checkout differs from the tested artifact.', 'deployment_revision_mismatch');
    }
    const deploymentTool = workspace.repositoryBroker.createDeploymentTool({
      environment: gate.environment,
      commandId: command.idempotencyKey,
      revision: pinned,
    });
    const runWorkflow = dependencies.runWorkflow || framework.runWorkflow;
    const execution = await runWorkflow({
      workflow: deploymentWorkflow,
      llm: agent.llm,
      userMessage: promptFor(command, 'deploy', { environment: gate.environment, artifact: pinned }),
      rootDir: workspace.workDir,
      skillPaths: [],
      ctx: { cwd: workspace.workDir, rootDir: workspace.workDir, step, effectivePolicy: agent.effectivePolicy },
      invokeConfig: {
        runName: `pipeline:deploy:${command.runId}`,
        tags: deploymentWorkflow.tags,
        metadata: { pipeline_run_id: command.runId, pipeline_stage: 'deploy', pipeline_attempt: command.attempt },
      },
      runtime: agent.harness,
      workflowPattern: agent.workflowPattern,
      env: workspace.env,
      extraTools: [deploymentTool],
      settings: agent.prefs,
      attribution: {
        orgId: command.organizationId,
        projectId: command.projectId,
        taskId: command.preflight.workItem && command.preflight.workItem.id,
        source: 'deployer',
      },
    });
    const availabilityError = workspace.repositoryBroker.availabilityError();
    if (availabilityError) throw availabilityError;
    const receipt = publicDeploymentReceipt(workspace.repositoryBroker.deploymentReceipt());
    const verdict = parseStageVerdict(execution.finalText);
    const output = {
      summary: verdict ? verdict.summary : 'Deployment broker result is authoritative.',
      checks: verdict ? verdict.checks : [],
      environment: gate.environment,
      selectedHarness: agent.harness,
      harness: execution.runtime || agent.harness,
      provider: agent.llm.provider,
      model: agent.llm.model,
      artifact: pinned,
      deployment: receipt,
    };
    const receiptMatches = receipt
      && receipt.commandId === command.idempotencyKey
      && receipt.commitSha === pinned.commitSha
      && receipt.treeSha === pinned.treeSha;
    if (!receipt || receipt.status !== 'succeeded' || !receiptMatches) {
      return resultFailure(
        receipt && receipt.status === 'failed'
          ? 'deployment_failed'
          : receipt && !receiptMatches
            ? 'deployment_revision_mismatch'
            : 'deployment_not_executed',
        receipt && receipt.status === 'failed'
          ? `Allowlisted deployment completed with ${receipt.conclusion || 'failure'}.`
          : 'The deployment broker did not confirm a successful deployment.',
        output,
        false,
        pinned,
      );
    }
    return { status: 'succeeded', artifact: pinned, output };
  } finally {
    workspace.repositoryBroker.dispose();
  }
}

module.exports = {
  FULL_DEPLOYMENT_SEQUENCE,
  POLICY_DOMAINS,
  StageExecutionError,
  assertLinearProjectScope,
  stageConfiguration,
  priorResult,
  immutableArtifact,
  artifactFromResult,
  preflightDecisionDigest,
  stampTrustedEvidence,
  validateTrustedEvidence,
  defaultTrustedChecks,
  trustedTestContext,
  assertDeploymentAllowed,
  repositoryReference,
  sourceBranch,
  prepareStageWorkspace,
  effectivePolicySnapshot,
  resolveStageAgent,
  parseStageVerdict,
  executeTestingStage,
  executeDeploymentStage,
  publicDeploymentReceipt,
};
