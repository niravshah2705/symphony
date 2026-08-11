'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const events = require('@ai-fleet/shared/messaging/events');
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

test('stream requires a conversationId', () => {
  const { req, res } = makeReqRes({});
  sse.handleStream(req, res);
  assert.equal(res.statusCode, 400);
});

test('stream sets SSE headers, a connected preamble, and delivers events', () => {
  const { req, res } = makeReqRes({ conversationId: 'sse-c1' });
  sse.handleStream(req, res);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(res.chunks[0].includes(': connected'));

  events.publishEvent('sse-c1', { level: 'info', message: 'hi' });
  const dataFrame = res.chunks.find((c) => c.startsWith('data: '));
  assert.ok(dataFrame, 'expected a data frame');
  assert.deepEqual(JSON.parse(dataFrame.slice(6).trim()), { level: 'info', message: 'hi' });
  req.emit('close');
});

test('closing the request tears down the subscription (no further writes)', () => {
  const { req, res } = makeReqRes({ conversationId: 'sse-c2' });
  sse.handleStream(req, res);
  req.emit('close');
  const before = res.chunks.length;
  events.publishEvent('sse-c2', { message: 'after-close' });
  assert.equal(res.chunks.length, before);
});

test('workspace stream needs no conversationId and delivers global workspace events', () => {
  const { req, res } = makeReqRes({});
  sse.handleWorkspaceStream(req, res);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.ok(res.chunks[0].includes(': connected'));

  events.publishWorkspace({ type: 'jobs', jobs: [] });
  const dataFrame = res.chunks.find((c) => c.startsWith('data: '));
  assert.ok(dataFrame, 'expected a data frame');
  assert.deepEqual(JSON.parse(dataFrame.slice(6).trim()), { type: 'jobs', jobs: [] });
  req.emit('close');
});

test('closing a workspace stream tears down its subscription', () => {
  const { req, res } = makeReqRes({});
  sse.handleWorkspaceStream(req, res);
  req.emit('close');
  const before = res.chunks.length;
  events.publishWorkspace({ type: 'coder', coder: { running: false } });
  assert.equal(res.chunks.length, before);
});

test('SSE query context selects only the matching scoped relay', () => {
  const context = { organizationId: 'sse-org', projectId: 'sse-project' };
  const { req, res } = makeReqRes({ conversationId: 'sse-context', ...context });
  sse.handleStream(req, res);

  events.publishEvent('sse-context', { message: 'wrong project' }, {
    organizationId: 'sse-org', projectId: 'other-project',
  });
  events.publishEvent('sse-context', { message: 'right project' }, context);

  const frames = res.chunks.filter((chunk) => chunk.startsWith('data: '));
  assert.equal(frames.length, 1);
  assert.equal(JSON.parse(frames[0].slice(6).trim()).message, 'right project');
  req.emit('close');
});
