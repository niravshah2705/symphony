'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('./app');
const { MemoryIdempotencyStore } = require('./idempotency');
const { loadConfig } = require('./config');

function envelope(data, messageId = 'pubsub-1') {
  return {
    message: {
      messageId,
      data: Buffer.from(JSON.stringify(data)).toString('base64'),
    },
  };
}

function invitation(overrides = {}) {
  return {
    template: 'invitation',
    idempotencyKey: 'invite:org-1:user-1',
    to: 'person@example.com',
    variables: {
      organizationName: 'Acme',
      invitationToken: 'opaque-token',
      inviterName: 'Alice',
    },
    ...overrides,
  };
}

function billingAlert(overrides = {}) {
  return {
    template: 'billing_alert',
    idempotencyKey: 'billing:org-1:low-balance',
    to: 'owner@example.com',
    variables: {
      subject: 'Billing balance low',
      message: 'Please add credits.',
      orgId: 'org-1',
    },
    ...overrides,
  };
}

function testConfig() {
  return loadConfig({
    EMAIL_SMTP_HOST: 'smtp.example.com',
    EMAIL_FROM: 'AI Fleet <noreply@example.com>',
    PUBLIC_APP_URL: 'https://fleet.example.com',
  });
}

async function start(options = {}) {
  const logs = [];
  const logger = {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  };
  const app = createApp({
    config: testConfig(),
    idempotency: new MemoryIdempotencyStore(),
    authenticatePush: (req, res, next) => next(),
    logger,
    ...options,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}`, logs };
}

async function post(base, body) {
  return fetch(`${base}/pubsub/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('health is live while readiness reflects the SMTP transport', async () => {
  const mailer = { ready: async () => false, send: async () => {} };
  const { server, base } = await start({ mailer });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'not_ready' });
  } finally {
    server.close();
  }
});

test('push authentication runs before delivery', async () => {
  let sent = false;
  const mailer = { ready: async () => true, send: async () => { sent = true; } };
  const authenticatePush = (req, res) => res.status(401).json({ error: 'unauthorized' });
  const { server, base } = await start({ mailer, authenticatePush });
  try {
    assert.equal((await post(base, envelope(invitation()))).status, 401);
    assert.equal(sent, false);
  } finally {
    server.close();
  }
});

test('delivers a valid invitation once and acknowledges a duplicate', async () => {
  const sent = [];
  const mailer = { ready: async () => true, send: async (job) => sent.push(job) };
  const { server, base } = await start({ mailer });
  try {
    assert.equal((await post(base, envelope(invitation()))).status, 204);
    assert.equal((await post(base, envelope(invitation(), 'pubsub-redelivery'))).status, 204);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'person@example.com');
  } finally {
    server.close();
  }
});

test('does not acknowledge a concurrent redelivery while SMTP is unresolved', async () => {
  let releaseSend;
  let markStarted;
  const blocked = new Promise((resolve) => { releaseSend = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const mailer = { ready: async () => true, send: async () => { markStarted(); return blocked; } };
  const { server, base } = await start({ mailer });
  try {
    const first = post(base, envelope(invitation()));
    await started;
    assert.equal((await post(base, envelope(invitation()))).status, 409);
    releaseSend();
    assert.equal((await first).status, 204);
  } finally {
    server.close();
  }
});

test('dispatches the allow-listed billing alert contract', async () => {
  const sent = [];
  const mailer = { ready: async () => true, send: async (job) => sent.push(job) };
  const { server, base } = await start({ mailer });
  try {
    assert.equal((await post(base, envelope(billingAlert()))).status, 204);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].template, 'billing_alert');
    assert.equal(sent[0].subject, 'Billing balance low');
  } finally {
    server.close();
  }
});

test('acknowledges without releasing after SMTP succeeds but completion persistence fails', async () => {
  let releases = 0;
  const idempotency = {
    claim: async () => ({ acquired: true, claimId: 'claim-1' }),
    complete: async () => { throw new Error('firestore unavailable'); },
    release: async () => { releases += 1; },
  };
  const mailer = { ready: async () => true, send: async () => {} };
  const { server, base } = await start({ mailer, idempotency });
  try {
    assert.equal((await post(base, envelope(invitation()))).status, 204);
    assert.equal(releases, 0);
  } finally {
    server.close();
  }
});

test('SMTP failure returns 500 and releases the key for a Pub/Sub retry', async () => {
  let attempts = 0;
  const mailer = {
    ready: async () => true,
    send: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('provider unavailable');
    },
  };
  const { server, base, logs } = await start({ mailer });
  try {
    assert.equal((await post(base, envelope(invitation()))).status, 500);
    assert.equal((await post(base, envelope(invitation()))).status, 204);
    assert.equal(attempts, 2);
    assert.equal(JSON.stringify(logs).includes('provider unavailable'), false);
    assert.equal(JSON.stringify(logs).includes('opaque-token'), false);
    assert.equal(JSON.stringify(logs).includes('person@example.com'), false);
  } finally {
    server.close();
  }
});

test('unsupported or malformed messages are acknowledged without sending', async () => {
  let sent = false;
  const mailer = { ready: async () => true, send: async () => { sent = true; } };
  const { server, base } = await start({ mailer });
  try {
    const unsupported = invitation({ template: 'raw', subject: 'attacker controlled' });
    assert.equal((await post(base, envelope(unsupported))).status, 204);
    assert.equal((await post(base, { message: { data: 'not-base64-json' } })).status, 204);
    assert.equal(sent, false);
  } finally {
    server.close();
  }
});
