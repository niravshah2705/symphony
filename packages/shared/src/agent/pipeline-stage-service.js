'use strict';

const crypto = require('node:crypto');
const { CONFIG } = require('../config');
const { pushAuth } = require('../messaging/oidc');
const {
  createStageResultV1,
  validateStageCommandV1,
  validateStageResultV1,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const {
  MAX_STAGE_COMMAND_PUSH_BODY_BYTES,
  decodePipelinePushMessage,
  toPipelinePushEnvelope,
} = require('@ai-fleet/shared-core/pipeline/bus');
const { redactSecrets } = require('./tools/exec');
const {
  MemoryStageExecutionStore,
  StageExecutionStoreError,
  createStageExecutionStore,
} = require('./pipeline-stage-execution-store');

const DEFAULT_RESULTS_TOPICS = Object.freeze({
  plan: 'pipeline-plan-results',
  code: 'pipeline-code-results',
  test: 'pipeline-test-results',
  deploy: 'pipeline-deploy-results',
});
const DEFAULT_ORCHESTRATOR_PORT = 4070;
const MAX_COMPLETED_RESULTS = 1_000;

function safeCode(value, fallback = 'stage_execution_failed') {
  const code = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
  return /^[a-z][a-z0-9._-]{0,79}$/.test(code) ? code : fallback;
}

function safeError(error) {
  const raw = error && error.message ? error.message : String(error || 'Stage execution failed.');
  return {
    code: safeCode(error && error.code),
    message: redactSecrets(raw).trim().slice(0, 2_000) || 'Stage execution failed.',
    retryable: Boolean(error && error.retryable),
  };
}

function normalizeExecutionResult(value) {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value : { output: {} };
  const status = ['succeeded', 'failed', 'cancelled'].includes(result.status)
    ? result.status
    : 'succeeded';
  const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output)
    ? result.output
    : {};
  const metrics = result.metrics && typeof result.metrics === 'object' && !Array.isArray(result.metrics)
    ? result.metrics
    : {};
  const artifact = result.artifact && typeof result.artifact === 'object' && !Array.isArray(result.artifact)
    ? result.artifact
    : null;
  if (status === 'failed') {
    return { status, output, metrics, artifact, error: safeError(result.error || new Error('Stage reported failure.')) };
  }
  return { status, output, metrics, artifact, error: null };
}

function assertCommand(rawCommand, expectedStage) {
  const validation = validateStageCommandV1(rawCommand);
  if (!validation.valid) {
    const error = new TypeError(validation.errors.join(' '));
    error.code = 'invalid_stage_command';
    error.status = 400;
    throw error;
  }
  if (expectedStage && validation.value.stage !== expectedStage) {
    const error = new TypeError(`Expected a ${expectedStage} stage command.`);
    error.code = 'stage_command_mismatch';
    error.status = 400;
    throw error;
  }
  return validation.value;
}

function remember(map, key, value, max = MAX_COMPLETED_RESULTS) {
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

function recoveredExecutionResult(command, { startedAt, leaseExpiredAt }, clock) {
  return createStageResultV1({
    runId: command.runId,
    stage: command.stage,
    attempt: command.attempt,
    status: 'failed',
    output: {},
    error: {
      code: 'stage_execution_outcome_unknown',
      message: 'A previous worker lost its execution lease; its outcome is unknown and was not re-executed.',
      retryable: false,
    },
    metrics: {},
    startedAt: startedAt || null,
    completedAt: leaseExpiredAt || clock(),
  }, { clock });
}

function storedResult(rawResult) {
  const validation = validateStageResultV1(rawResult);
  if (!validation.valid) {
    throw new StageExecutionStoreError(
      'The durable stage completion is invalid.',
      'stage_execution_record_invalid',
    );
  }
  return validation.value;
}

/**
 * Execute each command id once behind a durable execution claim, while
 * publishing the exact persisted completion on every later delivery. The
 * process-local maps only coalesce concurrent work within this instance; the
 * injected store is the restart-safe idempotency authority.
 *
 * execute(command) may return `{output, metrics}` (implicit success) or
 * `{status, output, metrics, error}`. It never creates contract identity fields.
 */
function createStageCommandProcessor({
  stage,
  execute,
  publish,
  projectResult,
  clock = () => new Date().toISOString(),
  log = console,
  completedLimit = MAX_COMPLETED_RESULTS,
  executionStore = new MemoryStageExecutionStore(),
} = {}) {
  if (!['plan', 'code', 'test', 'deploy'].includes(stage)) throw new TypeError('A canonical pipeline stage is required.');
  if (typeof execute !== 'function') throw new TypeError('execute(command) is required.');
  if (typeof publish !== 'function') throw new TypeError('publish(result) is required.');
  if (!executionStore || typeof executionStore.claim !== 'function' || typeof executionStore.complete !== 'function') {
    throw new TypeError('A stage execution store with claim() and complete() is required.');
  }
  const executions = new Map();
  const completed = new Map();

  async function executeOnce(command) {
    const cached = completed.get(command.idempotencyKey);
    if (cached) return cached;
    const active = executions.get(command.idempotencyKey);
    if (active) return active;
    const startedAt = clock();
    const pending = (async () => {
      const claim = await executionStore.claim(command, {
        startedAt,
        recoverExpired: (lease) => recoveredExecutionResult(command, lease, clock),
      });
      if (!claim.acquired) {
        if (claim.state === 'in_progress') {
          throw new StageExecutionStoreError(
            'The stage command is already executing on another worker.',
            'stage_execution_in_progress',
          );
        }
        const replay = storedResult(claim.result);
        remember(completed, command.idempotencyKey, replay, completedLimit);
        return replay;
      }
      let normalized;
      try {
        normalized = normalizeExecutionResult(await execute(command));
      } catch (error) {
        normalized = {
          status: 'failed',
          output: {},
          metrics: {},
          error: safeError(error),
        };
      }
      let result;
      try {
        result = createStageResultV1({
          runId: command.runId,
          stage: command.stage,
          attempt: command.attempt,
          status: normalized.status,
          output: normalized.output,
          ...(normalized.artifact ? { artifact: normalized.artifact } : {}),
          error: normalized.error,
          metrics: normalized.metrics,
          startedAt,
        }, { clock });
      } catch (error) {
        // Model/service output is untrusted even after execution. Convert a
        // non-JSON or credential-bearing payload to a bounded terminal result
        // instead of retrying the same poison completion forever.
        if (log && typeof log.warn === 'function') {
          log.warn(`pipeline ${stage} emitted an unsafe result: ${safeError(error).message}`);
        }
        result = createStageResultV1({
          runId: command.runId,
          stage: command.stage,
          attempt: command.attempt,
          status: 'failed',
          output: {},
          error: {
            code: 'invalid_stage_output',
            message: 'Stage output could not be serialized safely.',
            retryable: false,
          },
          metrics: {},
          startedAt,
        }, { clock });
      }
      // Persist before publishing. A process crash after this point is recovered
      // by replaying the exact completion; an expired execution lease is never
      // reacquired because its external side effects may be ambiguous.
      await executionStore.complete(command, claim.claimId, result);
      remember(completed, command.idempotencyKey, result, completedLimit);
      return result;
    })();
    executions.set(command.idempotencyKey, pending);
    try {
      return await pending;
    } finally {
      executions.delete(command.idempotencyKey);
    }
  }

  return async function processStageCommand(rawCommand) {
    const command = assertCommand(rawCommand, stage);
    const result = await executeOnce(command);
    // Publish before projecting labels: a label is a recovery/visibility signal,
    // never authority for advancing the pipeline.
    const receipt = await publish(result, command);
    if (typeof projectResult === 'function') {
      try {
        await projectResult(command, result);
      } catch (error) {
        if (log && typeof log.warn === 'function') {
          log.warn(`pipeline ${stage} label projection failed: ${safeError(error).message}`);
        }
      }
    }
    return { command, result, receipt };
  };
}

/** Express handler for the canonical Pub/Sub push envelope. Poison messages are
 * acknowledged; valid commands are acknowledged only after their completion is
 * published, so a result-transport outage is safely redelivered. */
function createStageCommandHandler(options = {}) {
  const processorOptions = options.executionStore || options.processCommand
    ? options
    : {
      ...options,
      executionStore: createStageExecutionStore({
        stage: options.stage,
        env: options.env || process.env,
        now: options.now,
        firestoreFactory: options.firestoreFactory,
      }),
    };
  const processCommand = options.processCommand || createStageCommandProcessor(processorOptions);
  return async function pipelineStageCommand(req, res, next) {
    const raw = decodePipelinePushMessage(req && req.body);
    if (!raw) return res.status(204).end();
    try {
      await processCommand(raw);
      return res.status(204).end();
    } catch (error) {
      if (error && ['invalid_stage_command', 'stage_command_mismatch'].includes(error.code)) {
        if (options.log && typeof options.log.warn === 'function') options.log.warn(error.message);
        return res.status(204).end();
      }
      if (typeof next === 'function') return next(error);
      return res.status(503).json({ error: 'Stage completion could not be published.' });
    }
  };
}

function resultPublisherDefaults(env = process.env, stage) {
  const port = Number(env.ORCHESTRATOR_SERVICE_PORT || env.ORCHESTRATOR_PORT) || DEFAULT_ORCHESTRATOR_PORT;
  const orchestratorUrl = String(env.ORCHESTRATOR_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const normalizedStage = ['plan', 'code', 'test', 'deploy'].includes(stage) ? stage : null;
  const explicitStageTopic = normalizedStage
    ? env[`PUBSUB_PIPELINE_${normalizedStage.toUpperCase()}_RESULTS_TOPIC`]
      || env[`PIPELINE_${normalizedStage.toUpperCase()}_RESULTS_TOPIC`]
    : '';
  return {
    topic: String(
      explicitStageTopic
      || (normalizedStage ? DEFAULT_RESULTS_TOPICS[normalizedStage] : ''),
    ),
    url: String(env.PIPELINE_RESULTS_URL || `${orchestratorUrl}/internal/pipeline/results`),
  };
}

function createStageResultPublisher({
  mode = CONFIG.MESSAGING_MODE,
  topic,
  url,
  env = process.env,
  fetchImpl = globalThis.fetch,
  pubsub,
  pubsubFactory,
  projectId = CONFIG.GCP && CONFIG.GCP.projectId,
  } = {}) {
  const configuredUrl = url || env.PIPELINE_RESULTS_URL;
  const targetUrl = configuredUrl || resultPublisherDefaults(env).url;
  let client = pubsub || null;
  return async function publishStageResult(rawResult) {
    const validation = validateStageResultV1(rawResult);
    if (!validation.valid) throw new TypeError(validation.errors.join(' '));
    const result = validation.value;
    const targetTopic = topic || resultPublisherDefaults(env, result.stage).topic;
    if (mode === 'pubsub') {
      if (!targetTopic) throw new TypeError(`A ${result.stage} stage result topic is required.`);
      if (!client) {
        client = typeof pubsubFactory === 'function'
          ? pubsubFactory()
          : new (require('@google-cloud/pubsub').PubSub)({ projectId: projectId || undefined });
      }
      const messageId = await client.topic(targetTopic).publishMessage({
        json: result,
        attributes: {
          pipelineContract: 'stage-result-v1',
          pipelineRunId: result.runId,
          pipelineStage: result.stage,
          pipelineAttempt: String(result.attempt),
        },
      });
      return { messageId, transport: 'pubsub' };
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required for direct result delivery.');
    const headers = { 'content-type': 'application/json' };
    const internalToken = String(env.INTERNAL_API_TOKEN || '').trim();
    if (internalToken) headers['x-internal-token'] = internalToken;
    const stageTargetUrl = configuredUrl
      ? targetUrl
      : `${targetUrl.replace(/\/+$/, '')}/${encodeURIComponent(result.stage)}`;
    const response = await fetchImpl(stageTargetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(toPipelinePushEnvelope(result)),
    });
    if (!response || !response.ok) {
      const error = new Error(`Pipeline result publish failed with HTTP ${response && response.status ? response.status : 'unknown'}.`);
      error.code = 'pipeline_result_publish_failed';
      error.retryable = true;
      throw error;
    }
    return { messageId: `http:${result.commandId}`, transport: 'http' };
  };
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/** Pub/Sub OIDC in cloud mode; mandatory shared internal token in direct mode. */
function pipelineStageAuth({
  mode = CONFIG.MESSAGING_MODE,
  internalToken = process.env.INTERNAL_API_TOKEN,
  pushMiddleware = pushAuth(),
} = {}) {
  if (mode === 'pubsub') return pushMiddleware;
  const expected = String(internalToken || '').trim();
  return function verifyDirectStage(req, res, next) {
    if (!expected) {
      return res.status(503).json({ error: 'Pipeline stage authentication is not configured.' });
    }
    const supplied = req && typeof req.get === 'function' ? req.get('x-internal-token') : '';
    if (!constantTimeEqual(supplied, expected)) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  };
}

module.exports = {
  MAX_STAGE_COMMAND_PUSH_BODY_BYTES,
  DEFAULT_RESULTS_TOPICS,
  DEFAULT_ORCHESTRATOR_PORT,
  safeError,
  assertCommand,
  createStageCommandProcessor,
  createStageCommandHandler,
  createStageResultPublisher,
  resultPublisherDefaults,
  pipelineStageAuth,
};
