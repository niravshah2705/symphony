'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_STAGE_COMMAND_BASE64_BYTES,
  MAX_STAGE_COMMAND_PUSH_BODY_BYTES,
  PUBSUB_PUSH_ENVELOPE_HEADROOM_BYTES,
  DirectStageCommandBus,
  HttpStageCommandBus,
  PubSubStageCommandBus,
  toPipelinePushEnvelope,
  decodePipelinePushMessage,
} = require('./bus');
const {
  MAX_STAGE_COMMAND_BYTES,
  createPreflightSnapshot,
  createStageCommandV1,
} = require('./contracts');

const clock = () => '2026-08-12T10:00:00.000Z';

function command(stage = 'plan') {
  const requestedStages = ['plan', 'code', 'test', 'deploy'].slice(
    0,
    ['plan', 'code', 'test', 'deploy'].indexOf(stage) + 1,
  );
  const preflight = createPreflightSnapshot({
    runId: 'run-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages,
  }, { clock });
  return createStageCommandV1({
    runId: 'run-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages,
    preflight,
    stage,
    attempt: 1,
  }, { clock });
}

test('DirectStageCommandBus dispatches the contract to an injected local handler', async () => {
  const calls = [];
  const bus = new DirectStageCommandBus({
    handlers: { plan: async (value) => calls.push(value) },
  });
  const value = command();

  const receipt = await bus.dispatch(value);

  assert.deepEqual(calls, [value]);
  assert.deepEqual(receipt, { messageId: 'direct:run-1:plan:1', transport: 'direct' });
});

test('HTTP direct delivery and Pub/Sub use the same push-compatible message body', async () => {
  const value = command('test');
  const requests = [];
  const httpBus = new HttpStageCommandBus({
    endpointForStage: (stage) => `http://local/${stage}`,
    headers: { 'x-internal-token': 'local-token' },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 204, headers: { get: () => 'http-message' } };
    },
  });

  const receipt = await httpBus.dispatch(value);
  assert.equal(receipt.transport, 'http');
  assert.equal(requests[0].url, 'http://local/test');
  assert.equal(requests[0].init.headers['x-internal-token'], 'local-token');
  assert.deepEqual(decodePipelinePushMessage(JSON.parse(requests[0].init.body)), value);

  const published = [];
  const pubsubBus = new PubSubStageCommandBus({
    pubsub: {
      topic(name) {
        return { publishMessage: async (message) => { published.push({ name, message }); return 'pubsub-123'; } };
      },
    },
    topicForStage: (stage) => `pipeline-${stage}`,
  });
  assert.deepEqual(await pubsubBus.dispatch(value), { messageId: 'pubsub-123', transport: 'pubsub' });
  assert.equal(published[0].name, 'pipeline-test');
  assert.deepEqual(published[0].message.json, value);
  assert.equal(published[0].message.attributes.pipelineStage, 'test');
});

test('push envelope decoding returns null for malformed or non-JSON messages', () => {
  assert.deepEqual(decodePipelinePushMessage(toPipelinePushEnvelope({ ok: true })), { ok: true });
  assert.equal(decodePipelinePushMessage({}), null);
  assert.equal(decodePipelinePushMessage({ message: { data: 'not-base64-json' } }), null);
});

test('StageCommand transport budget accounts for base64 expansion and rejects one byte over the raw ceiling', () => {
  const preflight = createPreflightSnapshot({
    runId: 'budget-run',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages: ['plan'],
  }, { clock });
  const make = (size) => createStageCommandV1({
    runId: preflight.runId,
    organizationId: preflight.organizationId,
    projectId: preflight.projectId,
    requestedStages: preflight.requestedStages,
    preflight,
    stage: 'plan',
    attempt: 1,
    input: { padding: 'x'.repeat(size) },
  }, { clock });

  let low = 0;
  let high = MAX_STAGE_COMMAND_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    try {
      make(middle);
      low = middle;
    } catch (_) {
      high = middle - 1;
    }
  }
  const boundary = make(low);
  assert.equal(Buffer.byteLength(JSON.stringify(boundary), 'utf8'), MAX_STAGE_COMMAND_BYTES);
  assert.throws(() => make(low + 1), /StageCommandV1 must be at most/);

  const envelope = toPipelinePushEnvelope(boundary);
  assert.deepEqual(decodePipelinePushMessage(envelope), boundary);
  assert.equal(MAX_STAGE_COMMAND_BASE64_BYTES, 4 * Math.ceil(MAX_STAGE_COMMAND_BYTES / 3));
  assert.equal(
    MAX_STAGE_COMMAND_PUSH_BODY_BYTES,
    MAX_STAGE_COMMAND_BASE64_BYTES + PUBSUB_PUSH_ENVELOPE_HEADROOM_BYTES,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MAX_STAGE_COMMAND_PUSH_BODY_BYTES);

  const oversized = toPipelinePushEnvelope({ padding: 'x'.repeat(MAX_STAGE_COMMAND_BYTES) });
  assert.equal(decodePipelinePushMessage(oversized), null);
});

test('transport adapters fail closed when a stage route is not configured', async () => {
  await assert.rejects(
    () => new DirectStageCommandBus({ handlers: {} }).dispatch(command()),
    /No direct pipeline handler/,
  );
  await assert.rejects(
    () => new HttpStageCommandBus({ endpointForStage: () => '' }).dispatch(command()),
    /No HTTP pipeline endpoint/,
  );
});
