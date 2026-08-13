'use strict';

const { createHash, randomUUID } = require('node:crypto');

const PIPELINE_CONTRACT_VERSION = 1;
const PIPELINE_STAGES = Object.freeze(['plan', 'code', 'test', 'deploy']);
const STAGE_RESULT_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled']);

// One raw, UTF-8 JSON ceiling for StageCommandV1 on every transport. Pub/Sub
// base64 expansion is accounted for by pipeline/bus.js; the gateway reserves
// only one quarter of this budget for caller input so immutable preflight data
// and up to three prior stage summaries still have bounded room.
const MAX_STAGE_COMMAND_BYTES = 256 * 1024;
const MAX_STAGE_COMMAND_REQUEST_BYTES = Math.floor(MAX_STAGE_COMMAND_BYTES / 4);
const MAX_STAGE_RESULT_OUTPUT_BYTES = 32 * 1024;
const MAX_STAGE_RESULT_BYTES = 48 * 1024;

const KINDS = Object.freeze({
  start: 'pipeline.start.v1',
  preflight: 'pipeline.preflight.snapshot.v1',
  command: 'pipeline.stage.command.v1',
  result: 'pipeline.stage.result.v1',
});

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9._-]{0,79}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SECRET_KEY_RE = /(?:^|[_-])(?:api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key|access[_-]?key|client[_-]?secret)(?:$|[_-])/i;
const SECRET_COMPACT_KEYS = new Set([
  'apikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'authtoken', 'oauthtoken', 'bearertoken', 'secret', 'password',
  'passwd', 'credential', 'credentials', 'authorization', 'cookie',
  'privatekey', 'accesskey', 'clientsecret',
]);
const CREDENTIAL_VALUE_RES = [
  /(?:^|\s)(?:bearer|basic)\s+[A-Za-z0-9+/_.=-]{8,}(?:\s|$)/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Require a real scheme boundary. Without it, the engine retries the greedy
  // scheme at every character and a maximum-size benign string becomes O(n^2).
  /(?:^|[^A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|lin_api_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b/,
];
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_JSON_DEPTH = 64;

class PipelineContractError extends TypeError {
  constructor(message, code = 'invalid_pipeline_contract') {
    super(message);
    this.name = 'PipelineContractError';
    this.code = code;
  }
}

function fail(message) {
  throw new PipelineContractError(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertIdentifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    fail(`${field} must be a 1-160 character control-plane identifier.`);
  }
  return value;
}

function assertIsoTimestamp(value, field) {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be an ISO-8601 timestamp.`);
  }
  return value;
}

function assertVersionAndKind(value, kind) {
  if (value.schemaVersion !== PIPELINE_CONTRACT_VERSION) {
    fail(`schemaVersion must be ${PIPELINE_CONTRACT_VERSION}.`);
  }
  if (value.kind !== kind) fail(`kind must be "${kind}".`);
}

function normalizeRequestedStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    fail('requestedStages must explicitly contain at least one pipeline stage.');
  }
  const normalized = stages.map((stage, index) => {
    if (typeof stage !== 'string' || !PIPELINE_STAGES.includes(stage)) {
      fail(`requestedStages[${index}] is an unsupported stage.`);
    }
    return stage;
  });
  if (new Set(normalized).size !== normalized.length) fail('requestedStages cannot contain duplicate stages.');
  const positions = normalized.map((stage) => PIPELINE_STAGES.indexOf(stage));
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] <= positions[index - 1]) {
      fail('requestedStages must follow the canonical order: plan -> code -> test -> deploy.');
    }
  }
  if (normalized.includes('deploy') && (
    normalized.length !== PIPELINE_STAGES.length
    || normalized.some((stage, index) => stage !== PIPELINE_STAGES[index])
  )) {
    fail('deploy requires the exact full sequence: plan -> code -> test -> deploy.');
  }
  if (normalized.includes('test') && !normalized.includes('code')) {
    fail('test requires an earlier code stage so it can verify immutable code artifacts.');
  }
  return normalized;
}

/**
 * Copy JSON-compatible data while refusing common secret-bearing keys and
 * credential-shaped strings. Pipeline contracts are durable and travel over a
 * message bus, so raw credentials belong in the settings/proxy resolution path
 * and can never be smuggled into generic metadata or stage input/output.
 */
function copySecretFreeJson(value, path = '$', seen = new Set(), depth = 0) {
  if (depth > MAX_JSON_DEPTH) fail(`${path} exceeds the maximum JSON nesting depth.`);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail(`${path} must contain finite JSON numbers.`);
    return value;
  }
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE_RES.some((pattern) => pattern.test(value))) {
      fail(`${path} contains a credential-shaped value.`);
    }
    return value;
  }
  if (typeof value !== 'object') fail(`${path} must be JSON-compatible.`);
  if (seen.has(value)) fail(`${path} must not contain circular references.`);
  seen.add(value);
  let copied;
  if (Array.isArray(value)) {
    copied = value.map((item, index) => copySecretFreeJson(item, `${path}[${index}]`, seen, depth + 1));
  } else {
    if (!isPlainObject(value)) fail(`${path} must contain only plain JSON objects.`);
    copied = {};
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_OBJECT_KEYS.has(key)) fail(`${path}.${key} is an unsafe object key and is forbidden.`);
      if (isSecretFieldName(key)) fail(`${path}.${key} is a secret-bearing field and is forbidden.`);
      copied[key] = copySecretFreeJson(item, `${path}.${key}`, seen, depth + 1);
    }
  }
  seen.delete(value);
  return copied;
}

function isSecretFieldName(key) {
  const snake = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return SECRET_KEY_RE.test(snake) || SECRET_COMPACT_KEYS.has(snake.replace(/_/g, ''));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeObject(value, field, fallback = {}) {
  const resolved = value === undefined ? fallback : value;
  if (!isPlainObject(resolved)) fail(`${field} must be an object.`);
  return copySecretFreeJson(resolved, field);
}

function normalizeOptionalIdentifier(value, field) {
  return value === undefined || value === null || value === '' ? null : assertIdentifier(value, field);
}

function normalizePipelineStart(value) {
  if (!isPlainObject(value)) fail('PipelineStart must be an object.');
  assertVersionAndKind(value, KINDS.start);
  return deepFreeze({
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    kind: KINDS.start,
    runId: assertIdentifier(value.runId, 'runId'),
    organizationId: assertIdentifier(value.organizationId, 'organizationId'),
    projectId: assertIdentifier(value.projectId, 'projectId'),
    requestedStages: normalizeRequestedStages(value.requestedStages),
    request: normalizeObject(value.request, 'request'),
    requestedBy: normalizeOptionalIdentifier(value.requestedBy, 'requestedBy'),
    correlationId: normalizeOptionalIdentifier(value.correlationId, 'correlationId'),
    createdAt: assertIsoTimestamp(value.createdAt, 'createdAt'),
    metadata: normalizeObject(value.metadata, 'metadata'),
  });
}

function createPipelineStart(input, { clock = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  if (!isPlainObject(input)) fail('PipelineStart input must be an object.');
  return normalizePipelineStart({
    ...input,
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    kind: KINDS.start,
    runId: input.runId || idFactory(),
    request: input.request || {},
    createdAt: input.createdAt || clock(),
    metadata: input.metadata || {},
  });
}

function normalizeStageConfiguration(value, stages) {
  const configuration = normalizeObject(value, 'stageConfiguration');
  for (const key of Object.keys(configuration)) {
    if (!stages.includes(key)) fail(`stageConfiguration contains unrequested stage "${key}".`);
  }
  return configuration;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function calculatePreflightDecisionDigest(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

function normalizePreflightSnapshot(value) {
  if (!isPlainObject(value)) fail('PreflightSnapshot must be an object.');
  assertVersionAndKind(value, KINDS.preflight);
  const requestedStages = normalizeRequestedStages(value.requestedStages);
  const snapshot = {
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    kind: KINDS.preflight,
    runId: assertIdentifier(value.runId, 'runId'),
    organizationId: assertIdentifier(value.organizationId, 'organizationId'),
    projectId: assertIdentifier(value.projectId, 'projectId'),
    requestedStages,
    repository: normalizeObject(value.repository, 'repository'),
    workItem: normalizeObject(value.workItem, 'workItem'),
    stageConfiguration: normalizeStageConfiguration(value.stageConfiguration, requestedStages),
    policy: normalizeObject(value.policy, 'policy'),
    capturedAt: assertIsoTimestamp(value.capturedAt, 'capturedAt'),
    metadata: normalizeObject(value.metadata, 'metadata'),
  };
  const digest = calculatePreflightDecisionDigest(snapshot);
  if (value.preflightDecisionDigest !== undefined && value.preflightDecisionDigest !== digest) {
    fail('preflightDecisionDigest does not match the immutable preflight snapshot.');
  }
  if (!SHA256_RE.test(digest)) fail('preflightDecisionDigest must be a SHA-256 hex digest.');
  return deepFreeze({ ...snapshot, preflightDecisionDigest: digest });
}

function createPreflightSnapshot(input, { clock = () => new Date().toISOString() } = {}) {
  if (!isPlainObject(input)) fail('PreflightSnapshot input must be an object.');
  return normalizePreflightSnapshot({
    ...input,
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    kind: KINDS.preflight,
    repository: input.repository || {},
    workItem: input.workItem || {},
    stageConfiguration: input.stageConfiguration || {},
    policy: input.policy || {},
    capturedAt: input.capturedAt || clock(),
    metadata: input.metadata || {},
  });
}

function assertAttempt(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    fail('attempt must be an integer between 1 and 100.');
  }
  return value;
}

function stageIdempotencyKey(runId, stage, attempt) {
  assertIdentifier(runId, 'runId');
  if (!PIPELINE_STAGES.includes(stage)) fail('stage is unsupported.');
  assertAttempt(attempt);
  return `${runId}:${stage}:${attempt}`;
}

function normalizeStageCommandV1(value) {
  if (!isPlainObject(value)) fail('StageCommandV1 must be an object.');
  assertVersionAndKind(value, KINDS.command);
  const runId = assertIdentifier(value.runId, 'runId');
  const stage = PIPELINE_STAGES.includes(value.stage) ? value.stage : fail('stage is unsupported.');
  const attempt = assertAttempt(value.attempt);
  const expectedId = stageIdempotencyKey(runId, stage, attempt);
  if (value.commandId !== expectedId) fail(`commandId must equal the idempotency key "${expectedId}".`);
  if (value.idempotencyKey !== expectedId) fail(`idempotencyKey must equal "${expectedId}".`);
  const requestedStages = normalizeRequestedStages(value.requestedStages);
  if (!requestedStages.includes(stage)) fail('stage must be present in requestedStages.');
  const preflight = normalizePreflightSnapshot(value.preflight);
  if (preflight.runId !== runId) fail('preflight.runId must match runId.');
  if (preflight.organizationId !== value.organizationId || preflight.projectId !== value.projectId) {
    fail('preflight scope must match the command scope.');
  }
  if (JSON.stringify(preflight.requestedStages) !== JSON.stringify(requestedStages)) {
    fail('preflight.requestedStages must match requestedStages.');
  }
  const command = {
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    kind: KINDS.command,
    commandId: expectedId,
    idempotencyKey: expectedId,
    runId,
    stage,
    attempt,
    organizationId: assertIdentifier(value.organizationId, 'organizationId'),
    projectId: assertIdentifier(value.projectId, 'projectId'),
    requestedStages,
    preflight,
    input: normalizeObject(value.input, 'input'),
    issuedAt: assertIsoTimestamp(value.issuedAt, 'issuedAt'),
    trace: normalizeObject(value.trace, 'trace'),
  };
  if (Buffer.byteLength(JSON.stringify(command), 'utf8') > MAX_STAGE_COMMAND_BYTES) {
    fail(`StageCommandV1 must be at most ${MAX_STAGE_COMMAND_BYTES} bytes.`);
  }
  return deepFreeze(command);
}

function createStageCommandV1(input, { clock = () => new Date().toISOString() } = {}) {
  if (!isPlainObject(input)) fail('StageCommandV1 input must be an object.');
  const commandId = stageIdempotencyKey(input.runId, input.stage, input.attempt);
  return normalizeStageCommandV1({
    ...input,
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    kind: KINDS.command,
    commandId: input.commandId || commandId,
    idempotencyKey: input.idempotencyKey || commandId,
    input: input.input || {},
    issuedAt: input.issuedAt || clock(),
    trace: input.trace || {},
  });
}

function normalizeResultError(error, status) {
  if (status === 'succeeded') {
    if (error !== undefined && error !== null) fail('error must be null for a succeeded result.');
    return null;
  }
  if (status === 'failed' && !isPlainObject(error)) fail('error is required for a failed result.');
  if (error === undefined || error === null) return null;
  const copied = normalizeObject(error, 'error');
  const code = copied.code;
  const message = copied.message;
  if (typeof code !== 'string' || !ERROR_CODE_RE.test(code)) fail('error.code is invalid.');
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
    fail('error.message must contain 1-2000 characters.');
  }
  return {
    code,
    message,
    retryable: copied.retryable === true,
  };
}

function normalizeArtifact(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) fail('artifact must be an object.');
  const keys = Object.keys(value);
  if (keys.some((key) => !['commitSha', 'treeSha'].includes(key))) {
    fail('artifact may contain only commitSha and treeSha.');
  }
  if (typeof value.commitSha !== 'string' || !GIT_SHA_RE.test(value.commitSha)) {
    fail('artifact.commitSha must be a 40-character Git object id.');
  }
  if (typeof value.treeSha !== 'string' || !GIT_SHA_RE.test(value.treeSha)) {
    fail('artifact.treeSha must be a 40-character Git object id.');
  }
  return {
    commitSha: value.commitSha.toLowerCase(),
    treeSha: value.treeSha.toLowerCase(),
  };
}

function normalizeStageResultV1(value) {
  if (!isPlainObject(value)) fail('StageResultV1 must be an object.');
  assertVersionAndKind(value, KINDS.result);
  const runId = assertIdentifier(value.runId, 'runId');
  const stage = PIPELINE_STAGES.includes(value.stage) ? value.stage : fail('stage is unsupported.');
  const attempt = assertAttempt(value.attempt);
  const expectedId = stageIdempotencyKey(runId, stage, attempt);
  if (value.commandId !== expectedId) fail(`commandId must equal the idempotency key "${expectedId}".`);
  if (value.idempotencyKey !== expectedId) fail(`idempotencyKey must equal "${expectedId}".`);
  if (!STAGE_RESULT_STATUSES.includes(value.status)) fail('status is unsupported.');
  const output = normalizeObject(value.output, 'output');
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_STAGE_RESULT_OUTPUT_BYTES) {
    fail(`StageResultV1 output must be at most ${MAX_STAGE_RESULT_OUTPUT_BYTES} bytes.`);
  }
  const topLevelArtifact = normalizeArtifact(value.artifact);
  const outputArtifact = normalizeArtifact(output.artifact);
  if (
    topLevelArtifact
    && outputArtifact
    && JSON.stringify(topLevelArtifact) !== JSON.stringify(outputArtifact)
  ) {
    fail('artifact must match output.artifact when both are present.');
  }
  const artifact = topLevelArtifact || outputArtifact;
  if (value.status === 'succeeded' && ['code', 'test', 'deploy'].includes(stage) && !artifact) {
    fail(`artifact is required for a succeeded ${stage} result.`);
  }
  const result = {
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    kind: KINDS.result,
    commandId: expectedId,
    idempotencyKey: expectedId,
    runId,
    stage,
    attempt,
    status: value.status,
    output,
    artifact,
    error: normalizeResultError(value.error, value.status),
    startedAt: value.startedAt ? assertIsoTimestamp(value.startedAt, 'startedAt') : null,
    completedAt: assertIsoTimestamp(value.completedAt, 'completedAt'),
    metrics: normalizeObject(value.metrics, 'metrics'),
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_STAGE_RESULT_BYTES) {
    fail(`StageResultV1 must be at most ${MAX_STAGE_RESULT_BYTES} bytes.`);
  }
  return deepFreeze(result);
}

function createStageResultV1(input, { clock = () => new Date().toISOString() } = {}) {
  if (!isPlainObject(input)) fail('StageResultV1 input must be an object.');
  const commandId = stageIdempotencyKey(input.runId, input.stage, input.attempt);
  return normalizeStageResultV1({
    ...input,
    schemaVersion: PIPELINE_CONTRACT_VERSION,
    kind: KINDS.result,
    commandId: input.commandId || commandId,
    idempotencyKey: input.idempotencyKey || commandId,
    output: input.output || {},
    completedAt: input.completedAt || clock(),
    metrics: input.metrics || {},
  });
}

function validationFor(normalize, value) {
  try {
    return { valid: true, errors: [], value: normalize(value) };
  } catch (error) {
    if (!(error instanceof PipelineContractError)) throw error;
    return { valid: false, errors: [error.message], value: null };
  }
}

const validatePipelineStart = (value) => validationFor(normalizePipelineStart, value);
const validatePreflightSnapshot = (value) => validationFor(normalizePreflightSnapshot, value);
const validateStageCommandV1 = (value) => validationFor(normalizeStageCommandV1, value);
const validateStageResultV1 = (value) => validationFor(normalizeStageResultV1, value);

module.exports = {
  PIPELINE_CONTRACT_VERSION,
  PIPELINE_STAGES,
  STAGE_RESULT_STATUSES,
  MAX_STAGE_COMMAND_BYTES,
  MAX_STAGE_COMMAND_REQUEST_BYTES,
  MAX_STAGE_RESULT_OUTPUT_BYTES,
  MAX_STAGE_RESULT_BYTES,
  KINDS,
  PipelineContractError,
  normalizeRequestedStages,
  calculatePreflightDecisionDigest,
  copySecretFreeJson,
  isSecretFieldName,
  stageIdempotencyKey,
  createPipelineStart,
  createPreflightSnapshot,
  createStageCommandV1,
  createStageResultV1,
  validatePipelineStart,
  validatePreflightSnapshot,
  validateStageCommandV1,
  validateStageResultV1,
};
