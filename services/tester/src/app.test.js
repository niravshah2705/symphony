'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createPreflightSnapshot, createStageCommandV1 } = require('@ai-fleet/shared-core/pipeline/contracts');
const {
  MAX_STAGE_COMMAND_PUSH_BODY_BYTES,
  toPipelinePushEnvelope,
} = require('@ai-fleet/shared-core/pipeline/bus');
const { createApp } = require('./app');

const NOW = '2026-08-13T10:00:00.000Z';

function command() {
  const requestedStages = ['plan', 'code', 'test'];
  const preflight = createPreflightSnapshot({
    runId: 'tester-service-run', organizationId: 'org-1', projectId: 'project-1', requestedStages,
    repository: {}, workItem: {}, stageConfiguration: { test: {} }, policy: {},
  }, { clock: () => NOW });
  return createStageCommandV1({
    runId: preflight.runId, organizationId: preflight.organizationId, projectId: preflight.projectId,
    requestedStages, preflight, stage: 'test', attempt: 1, input: {},
  }, { clock: () => NOW });
}

function jsonBodyWithBytes(bytes) {
  const prefix = '{"padding":"';
  const suffix = '"}';
  return `${prefix}${'x'.repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
}

async function parseBody(app, body) {
  const parser = app.router.stack[0].handle;
  const req = Readable.from([body]);
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  const error = await new Promise((resolve) => parser(req, {}, resolve));
  return { error, body: req.body };
}

function routeHandler(app, path) {
  const layer = app.router.stack.find((candidate) => candidate.route && candidate.route.path === path);
  return layer && layer.route.stack[layer.route.stack.length - 1].handle;
}

function responseRecorder() {
  return {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
    end() { return this; },
  };
}

test('tester exposes canonical internal and Pub/Sub push-compatible stage routes', async () => {
  const executed = [];
  const published = [];
  const app = createApp({
    initStore: async () => {},
    execute: async (value) => { executed.push(value); return { output: { summary: 'tested' } }; },
    publish: async (value) => { published.push(value); },
    projectResult: async () => {},
    internalAuth: (req, res, next) => next(),
    pushAuth: (req, res, next) => next(),
    logger: { error() {}, warn() {} },
  });
  for (const route of ['/internal/pipeline/stage', '/pubsub/pipeline-stage']) {
    const handler = routeHandler(app, route);
    assert.equal(typeof handler, 'function');
    const response = responseRecorder();
    await handler({ body: toPipelinePushEnvelope(command()) }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 204);
  }
  assert.equal(executed.length, 1, 'redelivery is executed once by the command processor');
  assert.equal(published.length, 2, 'each delivery republishes the cached typed completion');
  assert.equal(published[0].stage, 'test');
});

test('tester parser accepts the exact push-body budget and rejects one byte over', async () => {
  const app = createApp({
    internalAuth: (req, res, next) => next(),
    pushAuth: (req, res, next) => next(),
    logger: { error() {}, warn() {} },
  });
  const boundary = await parseBody(app, jsonBodyWithBytes(MAX_STAGE_COMMAND_PUSH_BODY_BYTES));
  assert.equal(boundary.error, undefined);
  assert.equal(typeof boundary.body.padding, 'string');
  const oversized = await parseBody(app, jsonBodyWithBytes(MAX_STAGE_COMMAND_PUSH_BODY_BYTES + 1));
  assert.equal(oversized.error.type, 'entity.too.large');
  assert.equal(oversized.error.status, 413);
});
