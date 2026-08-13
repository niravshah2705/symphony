'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { ReadableStream } = require('node:stream/web');
const { createProxyHandler } = require('./proxy');

function webStreamFromString(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function startServer(handler) {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('routes a request to the upstream, injecting the credential, and streams the body back', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/api/v1/internal/s2s/managed-secrets')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          secrets: { anthropicApiKey: { source: 'managed', value: null } },
        }),
      };
    }
    captured = { url, headers: init.headers, method: init.method };
    return {
      status: 200,
      headers: new Map([
        ['content-type', 'text/event-stream'],
        ['content-length', '9'], // stripped by the proxy on the way back
      ]),
      body: webStreamFromString('streamed!'),
    };
  };
  const oauthManager = {
    getClaudeAuth: async () => ({ accessToken: 'acc-token', betaHeader: 'oauth-2025-04-20' }),
  };
  const handler = createProxyHandler({ fetchImpl, oauthManager, logger: { error() {}, info() {}, warn() {} } });
  const { server, port } = await startServer(handler);

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer egress-proxy-sentinel', 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const text = await resp.text();

    assert.equal(resp.status, 200);
    assert.equal(text, 'streamed!');
    // Upstream was the real Anthropic host + path.
    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
    // The sentinel was replaced by the injected OAuth bearer + beta header.
    assert.equal(captured.headers.authorization, 'Bearer acc-token');
    assert.equal(captured.headers['anthropic-beta'], 'oauth-2025-04-20');
    // content-length from upstream was stripped (body re-framed by Node).
    assert.equal(resp.headers.get('content-length'), null);
    assert.equal(resp.headers.get('content-type'), 'text/event-stream');
  } finally {
    server.close();
  }
});

test('unknown path is rejected with 404 (no open relay)', async () => {
  const handler = createProxyHandler({
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
    logger: { error() {}, info() {}, warn() {} },
  });
  const { server, port } = await startServer(handler);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/evil.example/steal`);
    assert.equal(resp.status, 404);
  } finally {
    server.close();
  }
});

test('healthz returns ok', async () => {
  const handler = createProxyHandler({ fetchImpl: async () => ({}), logger: { error() {} } });
  const { server, port } = await startServer(handler);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { status: 'ok' });
  } finally {
    server.close();
  }
});
