'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { verifyPushToken } = require('@ai-fleet/shared-core/messaging/oidc');
const { decodePipelinePushMessage } = require('@ai-fleet/shared-core/pipeline/bus');
const {
  MAX_STAGE_RESULT_BYTES,
  PIPELINE_STAGES,
  PipelineContractError,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const { PipelineRepositoryError } = require('@ai-fleet/shared-core/pipeline/repository');

const ORGANIZATION_HEADER = 'x-ai-fleet-organization-id';
const PROJECT_HEADER = 'x-ai-fleet-project-id';

function header(req, name) {
  return String(req.get(name) || '').trim();
}

function safeEqual(left, right) {
  const expected = Buffer.from(String(left));
  const actual = Buffer.from(String(right));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requestScope(req) {
  return {
    organizationId: header(req, ORGANIZATION_HEADER),
    projectId: header(req, PROJECT_HEADER),
  };
}

function assertScope(scope, resource) {
  if (scope.organizationId && scope.organizationId !== resource.organizationId) {
    const error = new Error('Pipeline run was not found.');
    error.code = 'pipeline_run_not_found';
    error.status = 404;
    throw error;
  }
  if (scope.projectId && scope.projectId !== resource.projectId) {
    const error = new Error('Pipeline run was not found.');
    error.code = 'pipeline_run_not_found';
    error.status = 404;
    throw error;
  }
}

function internalResultAuth({ config, logger, verifyToken = verifyPushToken }) {
  const cloud = config.messagingMode === 'pubsub';
  return async function authenticate(req, res, next) {
    const supplied = header(req, 'x-internal-token');
    // Direct result ingress is still a service-to-service trust boundary. A
    // missing token fails closed instead of turning local/container networking
    // into an unauthenticated StageResult publisher.
    if (!cloud) {
      if (config.internalApiToken && supplied && safeEqual(config.internalApiToken, supplied)) return next();
      if (!config.internalApiToken) {
        return res.status(503).json({
          error: 'Pipeline result authentication is not configured.',
          code: 'pipeline_result_auth_unconfigured',
        });
      }
      return res.status(401).json({
        error: 'Unauthorized pipeline result.',
        code: 'pipeline_result_unauthorized',
      });
    }
    if (!config.resultAudience || !config.resultAllowedEmails.length) {
      logger.error('orchestrator result OIDC is missing an audience or allowed service account');
      return res.status(503).json({
        error: 'Pipeline result authentication is not configured.',
        code: 'pipeline_result_auth_unconfigured',
      });
    }
    try {
      req.pipelineResultPrincipal = await verifyToken(req, {
        audience: config.resultAudience,
        allowedEmails: config.resultAllowedEmails,
      });
      return next();
    } catch (error) {
      logger.warn('orchestrator rejected internal result authentication');
      return res.status(error && error.status ? error.status : 401).json({
        error: 'Unauthorized pipeline result.',
        code: 'pipeline_result_unauthorized',
      });
    }
  };
}

function controlApiAuth({ config }) {
  return function authenticateControl(req, res, next) {
    // Cloud Run IAM authenticates gateway -> orchestrator before Express. The
    // direct profile has no platform edge, so require the shared S2S token.
    if (config.messagingMode === 'pubsub') return next();
    if (!config.internalApiToken) {
      return res.status(503).json({
        error: 'Pipeline control authentication is not configured.',
        code: 'pipeline_control_auth_unconfigured',
      });
    }
    const supplied = header(req, 'x-internal-token');
    if (supplied && safeEqual(config.internalApiToken, supplied)) return next();
    return res.status(401).json({
      error: 'Unauthorized pipeline control request.',
      code: 'pipeline_control_unauthorized',
    });
  };
}

function resultFromBody(body) {
  if (body && body.message) {
    return decodePipelinePushMessage(body, { maxDecodedBytes: MAX_STAGE_RESULT_BYTES });
  }
  return body;
}

function errorResponse(error) {
  if (error instanceof PipelineContractError) {
    return { status: 400, body: { error: error.message, code: error.code } };
  }
  if (error instanceof PipelineRepositoryError) {
    return { status: error.status || 409, body: { error: error.message, code: error.code } };
  }
  const status = Number(error && error.status);
  if (status >= 400 && status < 500) {
    return {
      status,
      body: {
        error: error.message || 'Pipeline request was rejected.',
        code: error.code || 'pipeline_request_rejected',
      },
    };
  }
  return { status: 500, body: { error: 'Pipeline service unavailable.', code: 'pipeline_service_unavailable' } };
}

function createApp({ orchestrator, config, logger, authenticatePush, verifyResultToken } = {}) {
  if (!orchestrator) throw new TypeError('orchestrator is required.');
  if (!config) throw new TypeError('config is required.');
  const log = logger || { info() {}, warn() {}, error() {} };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (req, res) => res.json({ status: 'ready' }));
  const authenticateControl = controlApiAuth({ config });

  app.post('/api/v1/pipeline-runs', authenticateControl, asyncRoute(async (req, res) => {
    const scope = requestScope(req);
    const input = { ...(req.body || {}) };
    if (scope.organizationId) {
      if (input.organizationId && input.organizationId !== scope.organizationId) {
        return res.status(404).json({ error: 'Organization context not found.', code: 'context_not_found' });
      }
      input.organizationId = scope.organizationId;
    }
    if (scope.projectId) {
      if (input.projectId && input.projectId !== scope.projectId) {
        return res.status(404).json({ error: 'Project context not found.', code: 'context_not_found' });
      }
      input.projectId = scope.projectId;
    }
    // Admission and its immutable preflight snapshot are durable before the
    // response. Dispatch runs on the next event-loop turn so direct HTTP mode
    // cannot hold this client request open while stage services synchronously
    // execute and post their results back through the orchestrator.
    const status = await orchestrator.start(input, { deferDispatch: true });
    assertScope(scope, status.run);
    res.status(202).json(status);
    if (typeof orchestrator.advance === 'function') {
      setImmediate(() => {
        Promise.resolve(orchestrator.advance(status.run.runId)).catch((error) => {
          log.error(`pipeline background dispatch failed (${error && error.code ? error.code : 'unknown'})`);
        });
      });
    }
    return undefined;
  }));

  app.get('/api/v1/pipeline-runs/:runId', authenticateControl, asyncRoute(async (req, res) => {
    const status = await orchestrator.status(req.params.runId);
    assertScope(requestScope(req), status.run);
    return res.json(status);
  }));

  app.post('/api/v1/pipeline-runs/:runId/cancel', authenticateControl, asyncRoute(async (req, res) => {
    const current = await orchestrator.status(req.params.runId);
    assertScope(requestScope(req), current.run);
    return res.json(await orchestrator.cancel(req.params.runId, req.body || {}));
  }));

  app.post('/api/v1/pipeline-runs/:runId/resume', authenticateControl, asyncRoute(async (req, res) => {
    const current = await orchestrator.status(req.params.runId);
    assertScope(requestScope(req), current.run);
    return res.json(await orchestrator.resume(req.params.runId, {
      retryFailed: req.body && req.body.retryFailed === true,
    }));
  }));

  const handleInternalResult = asyncRoute(async (req, res) => {
    const result = resultFromBody(req.body);
    const expectedStage = req.params.stage;
    if (expectedStage && !PIPELINE_STAGES.includes(expectedStage)) {
      return res.status(404).json({ error: 'Not found.', code: 'not_found' });
    }
    if (expectedStage && (!result || result.stage !== expectedStage)) {
      return res.status(400).json({
        error: `Expected a ${expectedStage} stage result.`,
        code: 'pipeline_result_stage_mismatch',
      });
    }
    await orchestrator.handleStageResult(result);
    return res.status(204).end();
  });
  const authenticateInternalResult = internalResultAuth({
    config,
    logger: log,
    verifyToken: verifyResultToken || verifyPushToken,
  });
  if (config.messagingMode !== 'pubsub') {
    app.post('/internal/pipeline/results/:stage', authenticateInternalResult, handleInternalResult);
    // Local/direct compatibility. Cloud workers use IAM-isolated, stage-bound
    // Pub/Sub topics; exposing these routes there would let any holder of the
    // shared internal token select another stage's URL.
    app.post('/internal/pipeline/results', authenticateInternalResult, handleInternalResult);
  }

  const pushMiddleware = authenticatePush || internalResultAuth({
    config,
    logger: log,
    verifyToken: verifyResultToken || verifyPushToken,
  });
  for (const expectedStage of ['plan', 'code', 'test', 'deploy']) {
    app.post(`/pubsub/pipeline-stage-results/${expectedStage}`, pushMiddleware, async (req, res) => {
      const result = resultFromBody(req.body);
      if (!result || result.stage !== expectedStage) {
        log.warn(`orchestrator dropped result on the ${expectedStage} stage-only ingress`);
        return res.status(204).end();
      }
      try {
        await orchestrator.handleStageResult(result);
        return res.status(204).end();
      } catch (error) {
        if (error instanceof PipelineContractError) {
          log.warn(`orchestrator dropped invalid stage result: ${error.message}`);
          return res.status(204).end();
        }
        if (error instanceof PipelineRepositoryError && [400, 404, 409].includes(error.status)) {
          // Unknown/conflicting results cannot become valid through redelivery.
          log.warn(`orchestrator dropped non-retriable stage result: ${error.code}`);
          return res.status(204).end();
        }
        return res.status(500).json({ error: 'Pipeline result handling failed.', code: 'pipeline_result_failed' });
      }
    });
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found.', code: 'not_found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const response = errorResponse(error);
    if (response.status >= 500) {
      log.error(`orchestrator request failed (${error && error.code ? error.code : 'unknown'})`);
    }
    return res.status(response.status).json(response.body);
  });
  return app;
}

module.exports = { createApp, controlApiAuth, internalResultAuth, resultFromBody, errorResponse };
