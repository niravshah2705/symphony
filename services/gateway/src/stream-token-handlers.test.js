'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STREAM_TOKEN_PROXY_URL ||= 'http://127.0.0.1:4030';

const { createStreamTokenHandlers } = require('./stream-token-handlers');
const { WORKSPACE_CHANNEL } = require('@ai-fleet/shared-core/messaging/events');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; },
  };
}

const context = { organizationId: 'org-1', projectId: 'project-1' };

test('conversation mint handler preserves the public response and authoritative context', async () => {
  let minted;
  const handlers = createStreamTokenHandlers({
    mintStreamToken: async (channelId, selected) => {
      minted = { channelId, selected };
      return '123.signature';
    },
    mintWorkspaceToken: async () => assert.fail('wrong mint function'),
    requestContext: () => context,
    getConversation: () => ({ organizationId: 'org-1', projectId: 'project-1' }),
    matchesEventContext: () => true,
  });
  const req = { query: { conversationId: ' conversation-1 ' } };
  const res = responseRecorder();

  await handlers.mintConversation(req, res);

  assert.deepEqual(minted, { channelId: 'conversation-1', selected: context });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, {
    token: '123.signature',
    conversationId: 'conversation-1',
    organizationId: 'org-1',
    projectId: 'project-1',
  });
});

test('workspace mint handler preserves the public response shape', async () => {
  const handlers = createStreamTokenHandlers({
    mintStreamToken: async () => assert.fail('wrong mint function'),
    mintWorkspaceToken: async (selected) => {
      assert.deepEqual(selected, context);
      return '123.signature';
    },
    requestContext: () => context,
    getConversation: () => null,
    matchesEventContext: () => false,
  });
  const res = responseRecorder();

  await handlers.mintWorkspace({}, res);

  assert.deepEqual(res.body, {
    token: '123.signature',
    conversationId: WORKSPACE_CHANNEL,
    organizationId: 'org-1',
    projectId: 'project-1',
  });
});

test('mint proxy failures map to exact 503 code', async () => {
  const handlers = createStreamTokenHandlers({
    mintStreamToken: async () => { throw new Error('proxy down'); },
    mintWorkspaceToken: async () => { throw new Error('proxy down'); },
    requestContext: () => context,
    getConversation: () => ({}),
    matchesEventContext: () => true,
  });

  for (const [handler, req] of [
    [handlers.mintConversation, { query: { conversationId: 'conversation-1' } }],
    [handlers.mintWorkspace, {}],
  ]) {
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, {
      error: 'Stream token service is unavailable.',
      code: 'stream_token_unavailable',
    });
  }
});

test('conversation mint keeps existing 400 and 404 decisions ahead of the proxy', async () => {
  let calls = 0;
  const handlers = createStreamTokenHandlers({
    mintStreamToken: async () => { calls += 1; },
    mintWorkspaceToken: async () => {},
    requestContext: () => context,
    getConversation: () => null,
    matchesEventContext: () => false,
  });

  const missing = responseRecorder();
  await handlers.mintConversation({ query: {} }, missing);
  assert.equal(missing.statusCode, 400);

  const unknown = responseRecorder();
  await handlers.mintConversation({ query: { conversationId: 'missing' } }, unknown);
  assert.equal(unknown.statusCode, 404);
  assert.equal(calls, 0);
});
