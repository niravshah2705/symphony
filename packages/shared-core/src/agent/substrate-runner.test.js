'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const grpc = require('./grpc-wire');
const r = require('./substrate-runner');

test('fingerprintOnly never leaks raw secret values', () => {
  const out = JSON.stringify(r.fingerprintOnly({ githubToken: 'gh-secret-xyz', openrouterApiKey: 'or-key-123' }));
  assert.equal(out.includes('gh-secret-xyz'), false);
  assert.equal(out.includes('or-key-123'), false);
  assert.match(out, /"fingerprint":"[0-9a-f]{12}"/);
});

test('syncSubstrateSecrets fails closed without an applyManifest seam but leaks nothing', async () => {
  await assert.rejects(
    () => r.syncSubstrateSecrets({ atespace: 'tenant-a', secrets: { githubToken: 'gh-secret-abc' } }),
    /applyManifest/,
  );
});

test('syncSubstrateSecrets applies manifests and returns fingerprint-only state', async () => {
  const applied = [];
  const res = await r.syncSubstrateSecrets({
    atespace: 'tenant-a',
    guardrailSpec: { credentials: { scopes: ['github', 'openrouter'] } },
    secrets: { githubToken: 'gh-secret-abc', openrouterApiKey: 'or-key-999' },
    applyManifest: async (m) => { applied.push(m.kind === 'Secret' ? m.metadata.name : m.kind); },
  });
  assert.deepEqual(res.syncedSecrets.sort(), ['ghcr-pull-and-clone', 'openrouter-api-key']);
  assert.ok(applied.includes('CredentialProviderReadGrant'));
  const serialized = JSON.stringify(res);
  assert.equal(serialized.includes('gh-secret-abc'), false);
  assert.equal(serialized.includes('or-key-999'), false);
});

test('dispatchActorPrompt posts with the ate-target-actor header and Bearer JWT', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify({ finalText: 'PLAN', model: 'm1' }) };
  };
  const out = await r.dispatchActorPrompt({
    ingressUrl: 'https://router.test',
    atespace: 'tenant-a',
    actorName: 'plan-x',
    actorJwt: 'a.b.c',
    prompt: 'go',
    fetchImpl,
  });
  assert.equal(seen.url, 'https://router.test/internal/plan/run');
  assert.equal(seen.init.headers['ate-target-actor'], 'tenant-a/plan-x');
  assert.equal(seen.init.headers.authorization, 'Bearer a.b.c');
  assert.equal(out.finalText, 'PLAN');
});

test('verifyActorJwt rejects malformed / expired / wrong trust domain', async () => {
  assert.equal((await r.verifyActorJwt('not-a-jwt')).reason, 'malformed_jwt');

  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const expired = `${b64u({ alg: 'RS256', kid: 'k' })}.${b64u({ sub: 'spiffe://cluster.local/ns/x', exp: 1 })}.sig`;
  assert.equal((await r.verifyActorJwt(expired)).reason, 'expired');

  const wrongDomain = `${b64u({ alg: 'RS256' })}.${b64u({ sub: 'spiffe://evil/actor', exp: Math.floor(Date.now() / 1000) + 60 })}.sig`;
  assert.equal((await r.verifyActorJwt(wrongDomain, { trustDomain: 'cluster.local' })).reason, 'trust_domain_mismatch');
});

test('verifyActorJwt passes structural checks (no jwks seam) for a well-formed SPIFFE JWT', async () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwtpart = `${b64u({ alg: 'none' })}.${b64u({ sub: 'spiffe://cluster.local/actor/plan-x', aud: 'substrate-router', exp: Math.floor(Date.now() / 1000) + 60 })}.x`;
  const v = await r.verifyActorJwt(jwtpart, { audience: 'substrate-router', trustDomain: 'cluster.local' });
  assert.equal(v.valid, true);
});

void crypto;

// ── runPlanningOnSubstrate: the ateapi credential ────────────────────────────

const substrate = require('./substrate');

function okFrame(payload) {
  return { status: 0, message: '', headers: {}, trailers: {}, frames: [payload], firstFrame: payload };
}

/**
 * Minimal fake Control plane (docs/SUBSTRATE_INTEGRATION.md §8 seam). Records the
 * `authorization` header the client would have put on the wire for every RPC.
 */
function recordingTransport(sink) {
  return (method, payload, opts) => {
    sink.push({ method, authorization: opts.authorization });
    if (method === 'CreateActor' || method === 'GetActor') {
      return Promise.resolve(okFrame(Buffer.concat([
        grpc.pbMessage(1, substrate.encodeMetadata({ atespace: 'tenant-a', name: 'plan-x', uid: 'u1', version: 1 })),
        grpc.pbMessage(5, grpc.pbVarint(1, 2)), // status.state = RUNNING, so the poll loop exits
      ])));
    }
    if (method === 'MintActorJwt') return Promise.resolve(okFrame(grpc.pbString(1, 'actor.jwt')));
    return Promise.resolve(okFrame(Buffer.alloc(0)));
  };
}

async function runOnce({ transport, fetchSecrets, substrateApiToken, organizationId = 'acme' }) {
  const origUrl = substrate.resolveSubstrateUrl;
  const origIngress = substrate.resolveSubstrateIngressUrl;
  substrate.resolveSubstrateUrl = () => 'https://ateapi.ate-system.svc:8443';
  substrate.resolveSubstrateIngressUrl = () => 'https://router.test';
  try {
    return await r.runPlanningOnSubstrate({
      organizationId,
      projectId: 'p1',
      prompt: 'plan it',
      secrets: { githubToken: 'gh-1' },
      guardrailSpec: { credentials: { scopes: ['github'] } },
      substrateApiToken,
      transport,
      applyManifest: async () => {},
      fetchSecrets,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ finalText: 'PLAN' }) }),
    });
  } finally {
    substrate.resolveSubstrateUrl = origUrl;
    substrate.resolveSubstrateIngressUrl = origIngress;
  }
}

test('runPlanningOnSubstrate puts the S2S-resolved credential on every control-plane RPC', async () => {
  const sink = [];
  const out = await runOnce({
    transport: recordingTransport(sink),
    fetchSecrets: async () => ({ substrateApiToken: 'sa-run-1' }),
  });
  assert.equal(out.finalText, 'PLAN');
  const methods = sink.map((s) => s.method);
  for (const m of ['CreateAtespace', 'CreateActorTemplate', 'CreateActor', 'MintActorJwt', 'DeleteActor']) {
    assert.ok(methods.includes(m), `${m} must be called`);
  }
  assert.deepEqual([...new Set(sink.map((s) => s.authorization))], ['Bearer sa-run-1']);
});

test('a run re-resolves the credential — it never reuses the previous run/org token', async () => {
  const issued = ['sa-run-1', 'sa-run-2'];
  let resolutions = 0;
  const fetchSecrets = async () => {
    resolutions += 1;
    return { substrateApiToken: issued[resolutions - 1] };
  };

  const first = [];
  await runOnce({ transport: recordingTransport(first), fetchSecrets, organizationId: 'acme' });
  const second = [];
  await runOnce({ transport: recordingTransport(second), fetchSecrets, organizationId: 'other-org' });

  assert.equal(resolutions, 2);
  assert.deepEqual([...new Set(first.map((s) => s.authorization))], ['Bearer sa-run-1']);
  assert.deepEqual([...new Set(second.map((s) => s.authorization))], ['Bearer sa-run-2']);
  // The tenant that rotates hourly must be able to see the new value at all.
  assert.equal(new Set([...first, ...second].map((s) => s.authorization)).size, 2);
});

test('runPlanningOnSubstrate uses a caller-resolved token without a second fetch', async () => {
  const sink = [];
  let fetched = 0;
  await runOnce({
    transport: recordingTransport(sink),
    substrateApiToken: 'sa-from-route',
    fetchSecrets: async () => {
      fetched += 1;
      return {};
    },
  });
  assert.equal(fetched, 0);
  assert.deepEqual([...new Set(sink.map((s) => s.authorization))], ['Bearer sa-from-route']);
});
