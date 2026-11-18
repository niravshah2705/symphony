'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const { createSubstrateActorRouter } = require('./substrate-actor');

/** Build a base64url-signed RS256 JWT the way ate-idp-server would. */
function signJwt({ claims, keypair, kid = 'test-key' }) {
  const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64(JSON.stringify(claims));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(keypair.privateKey).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${payload}.${sig}`;
}

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { privateKey, jwk };
}

function startApp(router) {
  const app = express();
  app.use(router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('substrate-actor: rejects missing Bearer token', async () => {
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: false, reason: 'missing' }),
    runner: async () => ({ finalText: 'unused' }),
    jwks: async () => ({ keys: [] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'plan a thing' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'missing_actor_jwt');
  } finally { server.close(); }
});

test('substrate-actor: rejects invalid JWT reason from verify', async () => {
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: false, reason: 'audience_mismatch' }),
    runner: async () => ({ finalText: 'unused' }),
    jwks: async () => ({ keys: [] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer abc.def.ghi', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'audience_mismatch');
  } finally { server.close(); }
});

test('substrate-actor: 503 when JWKS is unconfigured', async () => {
  const err = new Error('SUBSTRATE_JWKS_URL is not set');
  err.code = 'jwks_unconfigured';
  const router = createSubstrateActorRouter({
    verify: async () => { throw err; },
    runner: async () => ({ finalText: 'unused' }),
    jwks: async () => { throw err; },
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    assert.equal(res.status, 503);
  } finally { server.close(); }
});

test('substrate-actor: 400 when prompt is missing', async () => {
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/x' } }),
    runner: async () => ({ finalText: 'unused' }),
    jwks: async () => ({ keys: [] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'prompt_required');
  } finally { server.close(); }
});

test('substrate-actor: runs planning in-process and returns the result shape', async () => {
  let seen = null;
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/ate-demo/sa/actor-1' } }),
    runner: async (opts) => { seen = opts; return { finalText: 'PLAN TEXT', messages: [{ role: 'assistant', content: 'PLAN TEXT' }] }; },
    jwks: async () => ({ keys: [] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'plan',
        organizationId: 'org-1',
        projectId: 'proj-1',
        projectName: 'Project',
        llm: { model: 'openai/gpt-5', provider: 'openai' },
        runtime: 'deepagent',
        workflowPattern: 'plan-act',
        workflow: 'planner',
        stage: 'planning',
        settings: { agentRuntime: 'deepagent' },
        runId: 'run-99',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.finalText, 'PLAN TEXT');
    assert.deepEqual(body.messages, [{ role: 'assistant', content: 'PLAN TEXT' }]);
    assert.equal(body.model, 'openai/gpt-5');
    assert.equal(seen.organizationId, 'org-1');
    assert.equal(seen.runtime, 'deepagent');
    assert.equal(seen.invokeConfig.actorVerified, true);
    assert.equal(seen.invokeConfig.actorSub, 'spiffe://cluster.local/ns/ate-demo/sa/actor-1');
    assert.equal(seen.stage, 'planning');
  } finally { server.close(); }
});

test('substrate-actor: binds the caller trace so actor logs and spans join the run', async () => {
  // The actor is a separate process created by a template that sets no env, so
  // the inbound traceparent is the ONLY thing that connects its log lines and
  // spans to the run the user asked for.
  const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const log = require('@ai-fleet/shared/logger');
  let seen = null;
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/ate/sa/a1' } }),
    runner: async () => { seen = log.currentContext(); return { finalText: 'ok', messages: [] }; },
    jwks: async () => ({ keys: [] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json', traceparent: TP },
      body: JSON.stringify({ prompt: 'plan', organizationId: 'org-1', projectId: 'proj-1', runId: 'run-7' }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(seen.organizationId, 'org-1');
    assert.equal(seen.projectId, 'proj-1');
    assert.equal(seen.runId, 'run-7');
  } finally { server.close(); }
});

test('substrate-actor: an unusable traceparent is dropped, not carried into the logs', async () => {
  const log = require('@ai-fleet/shared/logger');
  let seen = null;
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/ate/sa/a1' } }),
    runner: async () => { seen = log.currentContext(); return { finalText: 'ok', messages: [] }; },
    jwks: async () => ({ keys: [] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json', traceparent: 'not-a-traceparent' },
      body: JSON.stringify({ prompt: 'plan', organizationId: 'org-1' }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.traceId, undefined);
    assert.equal(seen.organizationId, 'org-1');
  } finally { server.close(); }
});

test('substrate-actor: reports usage to the caller and never meters locally', async () => {
  // The ActorTemplate creates this container with no env, so it has no tenant
  // store: an in-actor recordUsage would write a phantom row that dies with the
  // actor. We must hand the numbers back and pass NO attribution (attribution is
  // what triggers metering in harnesses/contract.js).
  let seen = null;
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/ate/sa/a1' } }),
    runner: async (opts) => {
      seen = opts;
      return {
        finalText: 'P',
        messages: [],
        usage: { inputTokens: 120, outputTokens: 340, totalTokens: 460 },
        costUsd: 0.0042,
        traceId: 'trace-abc',
      };
    },
    jwks: async () => ({ keys: [] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'plan', organizationId: 'org-1', runId: 'run-1', llm: { model: 'm', provider: 'p' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.usage, { inputTokens: 120, outputTokens: 340, totalTokens: 460 });
    assert.equal(body.costUsd, 0.0042);
    assert.equal(body.traceId, 'trace-abc');
    assert.equal(seen.attribution, undefined, 'the actor must not be given billing attribution');
  } finally { server.close(); }
});

test('substrate-actor: a run without usage reports null rather than fabricating a row', async () => {  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/ate/sa/a1' } }),
    runner: async () => ({ finalText: 'P', messages: [] }),
    jwks: async () => ({ keys: [] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'plan' }),
    });
    const body = await res.json();
    assert.equal(body.usage, null);
    assert.equal(body.costUsd, null);
    assert.equal(body.traceId, null);
  } finally { server.close(); }
});

test('substrate-actor: real verifyActorJwt accepts a well-signed RS256 token', async () => {
  const { privateKey, jwk } = makeKeypair();
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({
    claims: {
      sub: 'spiffe://cluster.local/ns/ate-demo/sa/actor-1',
      aud: 'substrate-router',
      exp: now + 60,
      iat: now,
    },
    keypair: { privateKey },
  });
  const router = createSubstrateActorRouter({
    // Use the real substrate-runner verify + a fixture getJwks
    verify: require('@ai-fleet/shared/agent/substrate-runner').verifyActorJwt,
    runner: async () => ({ finalText: 'ok', messages: [] }),
    jwks: async () => ({ keys: [jwk] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'plan' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).finalText, 'ok');
  } finally { server.close(); }
});

test('substrate-actor: real verifyActorJwt rejects a tampered signature', async () => {
  const { privateKey, jwk } = makeKeypair();
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({
    claims: { sub: 'spiffe://cluster.local/x', aud: 'substrate-router', exp: now + 60 },
    keypair: { privateKey },
  });
  const [h, p] = token.split('.');
  const tamperedSig = 'A'.repeat(43);
  const router = createSubstrateActorRouter({
    verify: require('@ai-fleet/shared/agent/substrate-runner').verifyActorJwt,
    runner: async () => ({ finalText: 'never' }),
    jwks: async () => ({ keys: [jwk] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h}.${p}.${tamperedSig}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'plan' }),
    });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /signature/);
  } finally { server.close(); }
});
