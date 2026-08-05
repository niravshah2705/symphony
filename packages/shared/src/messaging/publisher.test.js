'use strict';

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

let server;
let received;
let publisher;

test.before(async () => {
  received = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  // Configure BEFORE the first require of config (via publisher).
  process.env.MESSAGING_MODE = 'direct';
  process.env.PLANNER_URL = `http://localhost:${port}`;
  publisher = require('./publisher');
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('toPushEnvelope/decodePushMessage roundtrip', () => {
  const message = { conversationId: 'c1', projectId: 'p1' };
  const envelope = publisher.toPushEnvelope(message);
  assert.ok(envelope.message.data);
  assert.deepEqual(publisher.decodePushMessage(envelope), message);
});

test('decodePushMessage returns null for malformed input', () => {
  assert.equal(publisher.decodePushMessage(null), null);
  assert.equal(publisher.decodePushMessage({}), null);
  assert.equal(publisher.decodePushMessage({ message: { data: Buffer.from('not json').toString('base64') } }), null);
});

test('publishRequest (direct) POSTs a push envelope to /pubsub/planner', async () => {
  const { CONFIG } = require('../config');
  await publisher.publishRequest(CONFIG.GCP.plannerTopic, { hello: 'world' });
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/pubsub/planner');
  assert.deepEqual(publisher.decodePushMessage(received[0].body), { hello: 'world' });
});

test('publishRequest (direct) throws for an unknown topic', async () => {
  await assert.rejects(() => publisher.publishRequest('no-such-topic', {}), /No direct route/);
});
