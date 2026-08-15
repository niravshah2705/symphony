'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { follow, parseFrame, drainFrames, formatEvent } = require('./stream');

test('parseFrame extracts a JSON event from a data frame', () => {
  const event = parseFrame('data: {"level":"info","message":"hello"}');
  assert.deepEqual(event, { level: 'info', message: 'hello' });
});

test('parseFrame ignores heartbeat/comment frames', () => {
  assert.equal(parseFrame(': connected'), null);
  assert.equal(parseFrame(': ping'), null);
});

test('parseFrame joins multi-line data payloads', () => {
  const event = parseFrame('data: {"a":1,\ndata: "b":2}');
  assert.deepEqual(event, { a: 1, b: 2 });
});

test('parseFrame returns null on malformed JSON', () => {
  assert.equal(parseFrame('data: not-json'), null);
});

test('drainFrames splits complete frames and keeps the remainder buffered', () => {
  const [frames, remainder] = drainFrames('data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}');
  assert.deepEqual(frames, ['data: {"n":1}', 'data: {"n":2}']);
  assert.equal(remainder, 'data: {"n":3}');
});

test('formatEvent renders level + message', () => {
  assert.equal(formatEvent({ level: 'warn', message: 'careful' }), '  [WARN] careful');
  assert.equal(formatEvent({ message: 'default level' }), '  [INFO] default level');
});

test('follow fails closed when token minting returns no usable token', async () => {
  let streamRequests = 0;
  const client = {
    base: 'https://gateway.example',
    headers: () => ({}),
    request: async () => ({ token: '   ' }),
  };

  await assert.rejects(
    follow(client, 'conversation-1', {
      fetchImpl: async () => {
        streamRequests += 1;
        throw new Error('the SSE request must not be opened');
      },
    }),
    (error) => error.code === 'stream_token_missing' && error.message === 'Stream token is unavailable.'
  );
  assert.equal(streamRequests, 0);
});

test('follow builds the SSE URL from the mint response authoritative context', async () => {
  let streamUrl;
  const client = {
    base: 'https://gateway.example',
    headers: () => ({ Accept: 'text/event-stream' }),
    request: async () => ({
      token: '123.signature',
      organizationId: 'authoritative-org',
      projectId: 'authoritative-project',
    }),
  };

  await follow(client, 'conversation-1', {
    fetchImpl: async (url) => {
      streamUrl = new URL(url);
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({ start(controller) { controller.close(); } }),
      };
    },
  });

  assert.equal(streamUrl.pathname, '/api/agent/stream');
  assert.equal(streamUrl.searchParams.get('conversationId'), 'conversation-1');
  assert.equal(streamUrl.searchParams.get('t'), '123.signature');
  assert.equal(streamUrl.searchParams.get('organizationId'), 'authoritative-org');
  assert.equal(streamUrl.searchParams.get('projectId'), 'authoritative-project');
});
