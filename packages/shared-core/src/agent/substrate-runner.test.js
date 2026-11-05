'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
