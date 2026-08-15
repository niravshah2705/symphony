'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

process.env.STREAM_TOKEN_PROXY_URL ||= 'http://127.0.0.1:4030';

const events = require('@ai-fleet/shared-core/messaging/events');
const sse = require('./sse');

function makeReqRes(query) {
  const req = new EventEmitter();
  req.query = query;
  const res = {
    headers: {},
    statusCode: 200,
    chunks: [],
    body: null,
    set(h) { Object.assign(this.headers, h); return this; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    write(chunk) { this.chunks.push(chunk); return true; },
    flushHeaders() {},
  };
  return { req, res };
}

test('stream requires a conversationId', async () => {
  const { req, res } = makeReqRes({});
  await sse.handleStream(req, res);
  assert.equal(res.statusCode, 400);
});

test('stream sets SSE headers, a connected preamble, and delivers events', async () => {
  const { req, res } = makeReqRes({ conversationId: 'sse-c1' });
  await sse.handleStream(req, res);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(res.chunks[0].includes(': connected'));

  events.publishEvent('sse-c1', { level: 'info', message: 'hi' });
  const dataFrame = res.chunks.find((c) => c.startsWith('data: '));
  assert.ok(dataFrame, 'expected a data frame');
  assert.deepEqual(JSON.parse(dataFrame.slice(6).trim()), { level: 'info', message: 'hi' });
  req.emit('close');
});

test('closing the request tears down the subscription (no further writes)', async () => {
  const { req, res } = makeReqRes({ conversationId: 'sse-c2' });
  await sse.handleStream(req, res);
  req.emit('close');
  const before = res.chunks.length;
  events.publishEvent('sse-c2', { message: 'after-close' });
  assert.equal(res.chunks.length, before);
});

test('workspace stream needs no conversationId and delivers global workspace events', async () => {
  const { req, res } = makeReqRes({});
  await sse.handleWorkspaceStream(req, res);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.ok(res.chunks[0].includes(': connected'));

  events.publishWorkspace({ type: 'jobs', jobs: [] });
  const dataFrame = res.chunks.find((c) => c.startsWith('data: '));
  assert.ok(dataFrame, 'expected a data frame');
  assert.deepEqual(JSON.parse(dataFrame.slice(6).trim()), { type: 'jobs', jobs: [] });
  req.emit('close');
});

test('closing a workspace stream tears down its subscription', async () => {
  const { req, res } = makeReqRes({});
  await sse.handleWorkspaceStream(req, res);
  req.emit('close');
  const before = res.chunks.length;
  events.publishWorkspace({ type: 'coder', coder: { running: false } });
  assert.equal(res.chunks.length, before);
});

test('SSE query context selects only the matching scoped relay', async () => {
  const context = { organizationId: 'sse-org', projectId: 'sse-project' };
  const { req, res } = makeReqRes({ conversationId: 'sse-context', ...context });
  await sse.handleStream(req, res);

  events.publishEvent('sse-context', { message: 'wrong project' }, {
    organizationId: 'sse-org', projectId: 'other-project',
  });
  events.publishEvent('sse-context', { message: 'right project' }, context);

  const frames = res.chunks.filter((chunk) => chunk.startsWith('data: '));
  assert.equal(frames.length, 1);
  assert.equal(JSON.parse(frames[0].slice(6).trim()).message, 'right project');
  req.emit('close');
});

test('auth-enabled stream maps an invalid or expired token to 401 without subscribing', async () => {
  let subscriptions = 0;
  const handlers = sse.createSseHandlers({
    authEnabled: true,
    verifyStreamToken: async () => false,
    subscribe: () => { subscriptions += 1; return () => {}; },
    subscribeWorkspace: () => { subscriptions += 1; return () => {}; },
  });
  const { req, res } = makeReqRes({ conversationId: 'sse-invalid', t: 'bad-token' });

  await handlers.handleStream(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Invalid or expired stream token.' });
  assert.equal(subscriptions, 0);
});

test('auth-enabled stream maps proxy failures to exact 503 without subscribing', async () => {
  let subscriptions = 0;
  let verified;
  const handlers = sse.createSseHandlers({
    authEnabled: true,
    verifyStreamToken: async (token, channelId, context) => {
      verified = { token, channelId, context };
      throw new Error('proxy unavailable');
    },
    subscribe: () => { subscriptions += 1; return () => {}; },
    subscribeWorkspace: () => { subscriptions += 1; return () => {}; },
  });
  const { req, res } = makeReqRes({
    conversationId: 'sse-unavailable',
    t: '123.signature',
    organizationId: 'org-1',
    projectId: 'project-1',
  });

  await handlers.handleStream(req, res);

  assert.deepEqual(verified, {
    token: '123.signature',
    channelId: 'sse-unavailable',
    context: { organizationId: 'org-1', projectId: 'project-1' },
  });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    error: 'Stream token service is unavailable.',
    code: 'stream_token_unavailable',
  });
  assert.equal(subscriptions, 0);
});

test('auth-enabled workspace stream verifies the reserved channel before subscribing', async () => {
  let channelId;
  let subscriptions = 0;
  const handlers = sse.createSseHandlers({
    authEnabled: true,
    verifyStreamToken: async (_token, channel) => { channelId = channel; return true; },
    subscribe: () => () => {},
    subscribeWorkspace: () => { subscriptions += 1; return () => {}; },
  });
  const { req, res } = makeReqRes({ t: '123.signature' });

  await handlers.handleWorkspaceStream(req, res);

  assert.equal(channelId, events.WORKSPACE_CHANNEL);
  assert.equal(subscriptions, 1);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  req.emit('close');
});
