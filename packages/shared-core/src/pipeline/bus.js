'use strict';

const {
  MAX_STAGE_COMMAND_BYTES,
  validateStageCommandV1,
} = require('./contracts');

// Pub/Sub encodes message data as base64 and adds delivery metadata around it.
// Keep parser sizing derived from the canonical raw command budget, with enough
// bounded headroom for the push envelope fields Google adds at delivery time.
const PUBSUB_PUSH_ENVELOPE_HEADROOM_BYTES = 16 * 1024;
const MAX_STAGE_COMMAND_BASE64_BYTES = 4 * Math.ceil(MAX_STAGE_COMMAND_BYTES / 3);
const MAX_STAGE_COMMAND_PUSH_BODY_BYTES =
  MAX_STAGE_COMMAND_BASE64_BYTES + PUBSUB_PUSH_ENVELOPE_HEADROOM_BYTES;

function assertCommand(command) {
  const validation = validateStageCommandV1(command);
  if (!validation.valid) {
    const error = new TypeError(validation.errors.join(' '));
    error.code = 'invalid_stage_command';
    throw error;
  }
  return validation.value;
}

/** Encode one control-plane message in the shape accepted by Pub/Sub push. */
function toPipelinePushEnvelope(message) {
  return { message: { data: Buffer.from(JSON.stringify(message)).toString('base64') } };
}

function decodePipelinePushMessage(body, { maxDecodedBytes = MAX_STAGE_COMMAND_BYTES } = {}) {
  const data = body && body.message && body.message.data;
  if (typeof data !== 'string' || !data) return null;
  try {
    if (data.length > 4 * Math.ceil(maxDecodedBytes / 3)) return null;
    const decoded = Buffer.from(data, 'base64');
    if (decoded.byteLength > maxDecodedBytes) return null;
    return JSON.parse(decoded.toString('utf8'));
  } catch (_) {
    return null;
  }
}

/** In-process adapter for unit tests and a single-process local deployment. */
class DirectStageCommandBus {
  constructor({ handlers = {} } = {}) {
    this.handlers = { ...handlers };
  }

  async dispatch(rawCommand) {
    const command = assertCommand(rawCommand);
    const handler = this.handlers[command.stage];
    if (typeof handler !== 'function') {
      const error = new Error(`No direct pipeline handler configured for stage "${command.stage}".`);
      error.code = 'pipeline_stage_route_missing';
      throw error;
    }
    await handler(command);
    return { messageId: `direct:${command.commandId}`, transport: 'direct' };
  }
}

/**
 * Multi-process local adapter. It intentionally sends the Pub/Sub push body so
 * each stage service has one decoding and validation path in local and cloud.
 */
class HttpStageCommandBus {
  constructor({ endpointForStage, fetchImpl = globalThis.fetch, headers = {} } = {}) {
    if (typeof endpointForStage !== 'function') throw new TypeError('endpointForStage is required.');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required.');
    this.endpointForStage = endpointForStage;
    this.fetchImpl = fetchImpl;
    this.headers = { ...headers };
  }

  async dispatch(rawCommand) {
    const command = assertCommand(rawCommand);
    const endpoint = this.endpointForStage(command.stage);
    if (typeof endpoint !== 'string' || !endpoint) {
      const error = new Error(`No HTTP pipeline endpoint configured for stage "${command.stage}".`);
      error.code = 'pipeline_stage_route_missing';
      throw error;
    }
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(toPipelinePushEnvelope(command)),
    });
    if (!response.ok) {
      const error = new Error(`Pipeline stage dispatch failed with HTTP ${response.status}.`);
      error.code = 'pipeline_dispatch_failed';
      throw error;
    }
    const responseId = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('x-message-id')
      : null;
    return { messageId: responseId || `http:${command.commandId}`, transport: 'http' };
  }
}

/** Cloud adapter; callers inject a configured @google-cloud/pubsub client. */
class PubSubStageCommandBus {
  constructor({ pubsub, topicForStage } = {}) {
    if (!pubsub || typeof pubsub.topic !== 'function') throw new TypeError('pubsub client is required.');
    if (typeof topicForStage !== 'function') throw new TypeError('topicForStage is required.');
    this.pubsub = pubsub;
    this.topicForStage = topicForStage;
  }

  async dispatch(rawCommand) {
    const command = assertCommand(rawCommand);
    const topicName = this.topicForStage(command.stage);
    if (typeof topicName !== 'string' || !topicName) {
      const error = new Error(`No Pub/Sub topic configured for stage "${command.stage}".`);
      error.code = 'pipeline_stage_route_missing';
      throw error;
    }
    const messageId = await this.pubsub.topic(topicName).publishMessage({
      json: command,
      attributes: {
        pipelineContract: 'stage-command-v1',
        pipelineRunId: command.runId,
        pipelineStage: command.stage,
        pipelineAttempt: String(command.attempt),
      },
    });
    return { messageId, transport: 'pubsub' };
  }
}

function createPubSubStageCommandBus({ topicForStage, projectId, pubsubFactory } = {}) {
  const pubsub = typeof pubsubFactory === 'function'
    ? pubsubFactory()
    : (() => {
        const { PubSub } = require('@google-cloud/pubsub');
        return new PubSub({ projectId: projectId || undefined });
      })();
  return new PubSubStageCommandBus({ pubsub, topicForStage });
}

module.exports = {
  MAX_STAGE_COMMAND_BASE64_BYTES,
  MAX_STAGE_COMMAND_PUSH_BODY_BYTES,
  PUBSUB_PUSH_ENVELOPE_HEADROOM_BYTES,
  DirectStageCommandBus,
  HttpStageCommandBus,
  PubSubStageCommandBus,
  createPubSubStageCommandBus,
  toPipelinePushEnvelope,
  decodePipelinePushMessage,
};
