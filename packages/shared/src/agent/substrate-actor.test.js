'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const { createSubstrateActorRouter } = require('./substrate-actor');

// The audience is a declared deployment fact now — verifyActorJwt has no default to
// fall back to — so every router built here states the name substrate.tf emits.
process.env.SUBSTRATE_ACTOR_JWT_AUDIENCE = 'substrate-router';

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

/** A token whose claims the caller chose and nobody signed - the shape the old
// empty-JWKS path used to accept. */
function forgedActorToken() {
  const b64 = (x) => Buffer.from(x).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const p = b64(JSON.stringify({ sub: 'spiffe://cluster.local/ns/tenant-a/sa/actor-1', aud: 'substrate-router', exp: now + 60 }));
  return `${h}.${p}.`;
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

/**
 * Every test below stubs `verify`, so the router must never dial the JWKS seam.
 * An empty key set used to be passed around here as if it were a supported state
 * — it is precisely the shape that made verifyActorJwt accept an unsigned token,
 * so reaching it is now a failure rather than a fixture.
 */
const jwksUnused = async () => { throw new Error('getJwks reached with verify stubbed'); };

test('substrate-actor: rejects missing Bearer token', async () => {
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: false, reason: 'missing' }),
    runner: async () => ({ finalText: 'unused' }),
    jwks: jwksUnused,
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
    jwks: jwksUnused,
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
    jwks: jwksUnused,
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
    jwks: jwksUnused,
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

/**
 * A two-tenant deployment: the actor's own space comes from the ActorTemplate env,
 * the claimed organization comes from the request body. Mirrors
 * resolveSubstrateAtespace's contract, including throwing for an org the operator
 * never bound — which must read as "not yours, not here", not as "does not exist".
 */
function atespaceResolverFor(home) {
  const bindings = { 'org-a': 'tenant-a', 'org-b': 'tenant-b' };
  return ({ organizationId } = {}) => {
    if (!organizationId) return home;
    const bound = bindings[String(organizationId)];
    if (!bound) throw new Error(`substrate: organization ${organizationId} is not bound to any atespace`);
    return bound;
  };
}

const authorizedOrgBody = (organizationId) => JSON.stringify({
  prompt: 'plan', organizationId, projectId: 'proj-1', settings: { openrouterApiKey: 'sk-of-the-other-tenant' },
});

test('substrate-actor: a verified token cannot run another tenant organization', async () => {
  // This is the whole of defect (b): check.valid proves WHICH WORKLOAD called, never
  // WHICH TENANT it may serve. Before the bind, body.organizationId went straight to
  // the harness with that tenant's settings attached.
  let ran = false;
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/tenant-a/sa/actor-1' } }),
    runner: async () => { ran = true; return { finalText: 'never', messages: [] }; },
    jwks: jwksUnused,
    resolveAtespace: atespaceResolverFor('tenant-a'),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: authorizedOrgBody('org-b'),
    });
    assert.equal(res.status, 404, 'a cross-tenant claim is refused as absent, not as forbidden');
    assert.equal((await res.json()).error, 'context_not_found');
    assert.equal(ran, false, 'the harness must never see a refused tenant');
  } finally { server.close(); }
});

test('substrate-actor: an organization the operator never bound is refused too', async () => {
  let ran = false;
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/tenant-a/sa/actor-1' } }),
    runner: async () => { ran = true; return { finalText: 'never', messages: [] }; },
    jwks: jwksUnused,
    resolveAtespace: atespaceResolverFor('tenant-a'),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: authorizedOrgBody('org-unbound'),
    });
    assert.equal(res.status, 404);
    assert.equal(ran, false);
  } finally { server.close(); }
});

test('substrate-actor: the actor serves its own organization', async () => {
  let seen = null;
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/tenant-a/sa/actor-1' } }),
    runner: async (opts) => { seen = opts; return { finalText: 'P', messages: [] }; },
    jwks: jwksUnused,
    resolveAtespace: atespaceResolverFor('tenant-a'),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: authorizedOrgBody('org-a'),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.organizationId, 'org-a');
  } finally { server.close(); }
});

test('substrate-actor: an actor that cannot name its own atespace serves nothing', async () => {
  // Fail closed on the missing deployment fact rather than falling back to
  // "accept whatever org the body says".
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/tenant-a/sa/actor-1' } }),
    runner: async () => ({ finalText: 'never', messages: [] }),
    jwks: jwksUnused,
    resolveAtespace: () => { throw new Error('no atespace configured for this deployment'); },
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: authorizedOrgBody('org-a'),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'actor_atespace_unresolved');
  } finally { server.close(); }
});

test('substrate-actor: an unsigned token is refused when the JWKS endpoint answers with no keys', async () => {
  // Phase 0 end to end: the real verifier + the real cache-shaped seam. keys: [] used
  // to reach verifyActorJwt as "nothing to check against" and the run was accepted.
  const router = createSubstrateActorRouter({
    verify: require('@software-factory/shared/agent/substrate-runner').verifyActorJwt,
    runner: async () => ({ finalText: 'never', messages: [] }),
    jwks: async () => ({ keys: [] }),
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${forgedActorToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'plan', organizationId: 'org-a' }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'no_jwks_keys');
  } finally { server.close(); }
});

test('substrate-actor: a JWKS that yields nothing is a 503, not a pass and not a caller 401', async () => {
  const router = createSubstrateActorRouter({
    verify: require('@software-factory/shared/agent/substrate-runner').verifyActorJwt,
    runner: async () => ({ finalText: 'never', messages: [] }),
    jwks: async () => { const e = new Error('no usable signing keys'); e.code = 'jwks_empty'; throw e; },
  });
  const { server, url } = await startApp(router);
  try {
    const res = await fetch(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${forgedActorToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'plan' }),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'jwks_empty');
  } finally { server.close(); }
});

test('substrate-actor: binds the caller trace so actor logs and spans join the run', async () => {
  // The actor is a separate process created by a template that sets no env, so
  // the inbound traceparent is the ONLY thing that connects its log lines and
  // spans to the run the user asked for.
  const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const log = require('@software-factory/shared/logger');
  let seen = null;
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/ate/sa/a1' } }),
    runner: async () => { seen = log.currentContext(); return { finalText: 'ok', messages: [] }; },
    jwks: jwksUnused,
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
  const log = require('@software-factory/shared/logger');
  let seen = null;
  const router = createSubstrateActorRouter({
    verify: async () => ({ valid: true, claims: { sub: 'spiffe://cluster.local/ns/ate/sa/a1' } }),
    runner: async () => { seen = log.currentContext(); return { finalText: 'ok', messages: [] }; },
    jwks: jwksUnused,
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
    jwks: jwksUnused,
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
    jwks: jwksUnused,
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
    verify: require('@software-factory/shared/agent/substrate-runner').verifyActorJwt,
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
    verify: require('@software-factory/shared/agent/substrate-runner').verifyActorJwt,
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
