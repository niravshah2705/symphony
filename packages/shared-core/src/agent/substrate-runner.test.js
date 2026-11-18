'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const grpc = require('./grpc-wire');
const { pbString } = grpc;
const substrate = require('./substrate');
const runner = require('./substrate-runner');

/**
 * Stub the ateapi Control plane + the actor data plane so one full
 * runPlanningOnSubstrate lifecycle can be exercised with no cluster. Returns the
 * calls made, so billing assertions can be checked against real traffic.
 */
function stubSubstrate({ actorResponse, record = {} } = {}) {
  const originals = {};
  record.calls = [];
  // Every name that sends something to the control plane. The two resolve*
  // names are absent because they only read config, and the ordering assertion
  // below asks "did this run touch a cluster it should not have".
  const CLUSTER_WRITES = new Set([
    'ensureAtespace', 'upsertActorTemplate', 'createEphemeralActor', 'createActorEgressPolicy',
    'getActorStatus', 'resumeActor', 'suspendActor', 'deleteActor', 'mintActorJwt', 'grpcCall',
  ]);
  const fakes = {
    resolveSubstrateAtespace: () => 'tenant-a',
    resolveSubstrateIngressUrl: () => 'https://substrate.example.com',
    ensureAtespace: async () => ({ atespace: 'tenant-a' }),
    upsertActorTemplate: async () => ({ atespace: 'tenant-a', name: 'planner', created: true }),
    createEphemeralActor: async () => ({ metadata: { atespace: 'tenant-a', name: 'plan-proj-1-run-1' }, status: {} }),
    createActorEgressPolicy: async () => ({ applied: true }),
    getActorStatus: async () => ({ metadata: { name: 'plan-proj-1-run-1' }, status: { state: 'RUNNING' } }),
    resumeActor: async () => ({}),
    suspendActor: async () => { record.suspended = true; return {}; },
    deleteActor: async () => { record.deleted = true; return {}; },
    mintActorJwt: async () => ({ tokenPresent: true }),
    grpcCall: async () => ({ status: 0, firstFrame: pbString(1, 'actor-jwt'), frames: [pbString(1, 'actor-jwt')] }),
  };
  for (const [name, fn] of Object.entries(fakes)) {
    originals[name] = substrate[name];
    substrate[name] = CLUSTER_WRITES.has(name)
      ? async (...args) => { record.calls.push(name); return fn(...args); }
      : fn;
  }
  const fetchImpl = async (url, init) => {
    record.dispatch = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(actorResponse),
    };
  };
  const restore = () => {
    for (const [name, fn] of Object.entries(originals)) substrate[name] = fn;
  };
  return { fetchImpl, restore, record };
}

const BASE = {
  organizationId: 'org-1',
  projectId: 'proj-1',
  projectName: 'Project One',
  prompt: 'plan the thing',
  llm: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  traceContext: { runId: 'run-1' },
  userId: 'user-1',
  userEmail: 'user@test.invalid',
};

test('START follows actor creation and STOP precedes teardown, even when dispatch fails', async () => {
  const { restore, record } = stubSubstrate();
  let started;
  let stopped = false;
  try {
    await assert.rejects(runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl: async () => { throw new Error('dispatch failed'); },
      actorSessionMonitor: (session) => {
        assert.equal(record.calls.at(-1), 'createEphemeralActor');
        started = session;
        return { stop: () => {
          assert.ok(!record.calls.includes('suspendActor'));
          stopped = true;
        } };
      },
    }), /dispatch failed/);
    assert.equal(started.userId, BASE.userId);
    assert.equal(started.userEmail, BASE.userEmail);
    assert.equal(started.tier, 'standard-1v1g');
    assert.equal(started.hourlyRatePaise, 0);
    assert.equal(stopped, true);
    assert.equal(record.suspended, true);
    assert.equal(record.deleted, true);
  } finally { restore(); }
});

test('a substrate run meters exactly one usage record for the dispatching org', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({
    actorResponse: {
      finalText: 'PLAN',
      messages: [{ role: 'assistant', content: 'PLAN' }],
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      costUsd: 0.0031,
      traceId: 'trace-xyz',
    },
  });
  const calls = [];
  try {
    const result = await runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl,
      recordUsage: (attribution, runResult, llm) => {
        calls.push({ attribution, runResult, llm });
        return { id: 'use_1', billingSource: 'managed', ...attribution };
      },
    });
    assert.equal(calls.length, 1, 'exactly one usage record per run — never two, never zero');
    assert.equal(calls[0].attribution.orgId, 'org-1');
    assert.equal(calls[0].attribution.projectId, 'proj-1');
    assert.equal(calls[0].attribution.userId, 'user-1');
    assert.equal(calls[0].attribution.userEmail, 'user@test.invalid');
    assert.equal(calls[0].attribution.runId, 'run-1');
    assert.equal(calls[0].attribution.traceId, 'trace-xyz');
    assert.equal(calls[0].attribution.source, 'substrate-plan');
    assert.deepEqual(calls[0].runResult.usage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 });
    assert.equal(calls[0].runResult.costUsd, 0.0031);
    assert.equal(calls[0].llm.model, 'claude-sonnet-4-5');

    // The numbers also ride back to the caller, so a pipeline stage can show cost
    // without re-deriving it.
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 200, totalTokens: 300 });
    assert.equal(result.costUsd, 0.0031);
    assert.equal(result.traceId, 'trace-xyz');
    assert.equal(result.billingSource, 'managed');
    assert.equal(record.suspended, true);
    assert.equal(record.deleted, true);
  } finally {
    restore();
  }
});

// A substrate run on the organization's own key must reach the metering call with
// that decision attached. This proves only the hand-off — what the writer does with
// it is usage.test.js's job.
test('the runner hands the admitted credential decision to metering', async () => {
  const { fetchImpl, restore } = stubSubstrate({
    actorResponse: { finalText: 'PLAN', messages: [], usage: { totalTokens: 300 }, costUsd: 0.0031 },
  });
  const calls = [];
  try {
    const result = await runner.runPlanningOnSubstrate({
      ...BASE,
      providerSource: 'customer',
      fetchImpl,
      recordUsage: (attribution) => {
        calls.push(attribution);
        return { id: 'use_2', billingSource: attribution.providerSource === 'customer' ? 'customer' : 'managed' };
      },
    });
    assert.equal(calls[0].providerSource, 'customer');
    assert.equal(result.billingSource, 'customer');
  } finally {
    restore();
  }
});

test('a run with no admitted decision reaches metering with none either', async () => {
  const { fetchImpl, restore } = stubSubstrate({
    actorResponse: { finalText: 'PLAN', messages: [], usage: { totalTokens: 300 } },
  });
  const calls = [];
  try {
    await runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl,
      recordUsage: (attribution) => { calls.push(attribution); return null; },
    });
    // Null, not 'managed': the writer owns the conservative default, so the
    // runner must not invent a decision the preflight never made.
    assert.equal(calls[0].providerSource, null);
  } finally {
    restore();
  }
});

test('metering happens on the control plane, not in the actor request body', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({
    actorResponse: { finalText: 'PLAN', messages: [], usage: { totalTokens: 5 } },
  });
  const calls = [];
  try {
    await runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl,
      recordUsage: (a, r, l) => { calls.push(a); return null; },
    });
    // The actor is told the org so it can label its own work, but the billing
    // write is ours — a record written inside the actor would vanish with it.
    const body = JSON.parse(record.dispatch.init.body);
    assert.equal(body.organizationId, 'org-1');
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('an actor that reports no usage still records exactly one (skipped) attempt', async () => {
  const { fetchImpl, restore } = stubSubstrate({ actorResponse: { finalText: 'PLAN', messages: [] } });
  const calls = [];
  try {
    const result = await runner.runPlanningOnSubstrate({
      ...BASE,
      fetchImpl,
      recordUsage: (a, r) => { calls.push({ a, r }); return null; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].r.usage, null);
    assert.equal(result.usage, null);
  } finally {
    restore();
  }
});

test('traceparent crosses the process boundary when the caller has one', async () => {
  const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const { fetchImpl, restore, record } = stubSubstrate({ actorResponse: { finalText: 'P', messages: [] } });
  try {
    await runner.runPlanningOnSubstrate({
      ...BASE,
      traceContext: { runId: 'run-1', traceparent: tp },
      fetchImpl,
      recordUsage: () => null,
    });
    assert.equal(record.dispatch.init.headers.traceparent, tp);
    assert.equal(record.dispatch.init.headers['x-aifleet-run-id'], 'run-1');
    assert.equal(record.dispatch.init.headers['x-aifleet-org-id'], 'org-1');
  } finally {
    restore();
  }
});

test('the actor is still torn down when dispatch fails', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({});
  const boom = async () => { throw new Error('actor unreachable'); };
  try {
    await assert.rejects(
      () => runner.runPlanningOnSubstrate({
        ...BASE,
        fetchImpl: boom,
        recordUsage: () => null,
      }),
      /actor unreachable/,
    );
    assert.equal(record.suspended, true, 'a failed run must not leave an idle actor billing nodes');
    assert.equal(record.deleted, true);
  } finally {
    restore();
  }
});

// The credential-provider Secrets are k8s objects, and Secret CRUD is not an
// ateapi RPC — so writing them needs an injected `applyManifest`, which no
// deployed workload has (the GKE API server is private). What the run does about
// that is the contract, and both wrong answers were live: silently skipping the
// grant left the actor with an unexplained missing token, and throwing AFTER
// ensureAtespace + ActorTemplate landed left a half-provisioned tenant for a run
// that never started.
test('a granted scope with no applier refuses before any cluster write', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({ actorResponse: { finalText: 'P', messages: [] } });
  try {
    await assert.rejects(
      () => runner.runPlanningOnSubstrate({
        ...BASE,
        // The default spec grants github/openrouter/image-registry, so a GitHub
        // token in settings is a grant the caller cannot honor.
        secrets: { githubToken: 'ghp_secretvalue', openrouterApiKey: 'sk-or-secret' },
        fetchImpl,
        recordUsage: () => null,
      }),
      /no applyManifest seam is wired/,
    );
    assert.deepEqual(record.calls, [], 'the refusal must precede every atespace/ActorTemplate/actor write');
    assert.equal(record.suspended, undefined, 'nothing was created, so there is nothing to tear down');
    assert.equal(record.deleted, undefined);
  } finally {
    restore();
  }
});

test('a scope the spec never grants is withheld by name, not an error', async () => {
  const { fetchImpl, restore, record } = stubSubstrate({ actorResponse: { finalText: 'P', messages: [] } });
  try {
    const result = await runner.runPlanningOnSubstrate({
      ...BASE,
      guardrailSpec: { credentials: { scopes: ['image-registry'] } },
      secrets: {
        githubToken: 'ghp_secretvalue',
        imageRegistryPassword: 'ghcr-secret',
        imageRegistryUsername: 'bot',
      },
      applyManifest: async () => {},
      fetchImpl,
      recordUsage: () => null,
    });
    assert.deepEqual(result.substrate.credentialSync.withheld, ['github'],
      'github is present in settings and absent from spec.credentials.scopes');
    assert.equal(result.substrate.credentialSync.scopes.github, false);
    assert.deepEqual(result.substrate.credentialSync.syncedSecrets, ['image-registry-creds'],
      'only the granted scope is written — fail-closed means the scopes the spec grants');

    // Withheld is a policy answer that has to reach the operator, and the
    // raw token must never ride along with it.
    const rendered = JSON.stringify(result);
    assert.ok(!rendered.includes('ghp_secretvalue'), 'the runner response carried a raw GitHub token');
    assert.ok(!rendered.includes('ghcr-secret'), 'the runner response carried a raw registry password');
  } finally {
    restore();
  }
});

// ── runPlanningOnSubstrate: the ateapi credential ────────────────────────────

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
    return await runner.runPlanningOnSubstrate({
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

// ---------------------------------------------------------------------------
// verifyActorJwt — the actor run route's ONLY authentication. It used to return
// { valid: true } with no crypto done whenever the key set was empty or getJwks
// was not injected, which is every deployment whose JWKS endpoint answers 200
// without a `keys` array (the pre-hardening substrate-jwks.js cached that as keys: []).
// ---------------------------------------------------------------------------

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function rsaKeypair(kid = 'test-key') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid, alg: 'RS256', use: 'sig' });
  return { privateKey, jwk, kid };
}

/** A token as ate-idp-server issues one: RS256, kid in the header, SPIFFE sub. */
// Pass `null` for a claim or header member to omit it (undefined would be
// re-filled by the default, which is exactly the fixture bug these tests probe).
function dropNulls(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null));
}

function actorToken({ privateKey, kid = 'test-key', claims = {}, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify(dropNulls(Object.assign({ alg: 'RS256', typ: 'JWT', kid }, header))));
  const p = b64u(JSON.stringify(dropNulls(Object.assign({
    sub: 'spiffe://cluster.local/ns/ate/sa/actor-1',
    aud: 'substrate-router',
    exp: now + 60,
    iat: now,
  }, claims))));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  return `${h}.${p}.${b64u(signer.sign(privateKey))}`;
}

/** A token whose bytes the caller chose — no key involved. */
const forgedToken = (claims = {}) => `${b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}.`;

const VALID_CLAIMS = {
  sub: 'spiffe://cluster.local/ns/ate/sa/actor-1',
  aud: 'substrate-router',
  exp: Math.floor(Date.now() / 1000) + 60,
};

const jwksOf = (keys) => async () => ({ keys });

test('verifyActorJwt accepts a well-signed token and returns its claims', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const check = await runner.verifyActorJwt(actorToken({ privateKey }), {
    audience: 'substrate-router', getJwks: jwksOf([jwk]),
  });
  assert.equal(check.valid, true);
  assert.equal(check.claims.sub, 'spiffe://cluster.local/ns/ate/sa/actor-1');
});

// The exact shape of the original defect: keys: [] used to mean "skip verification".
test('an empty JWKS rejects a forged token instead of accepting it', async () => {
  const check = await runner.verifyActorJwt(
    forgedToken({ ...VALID_CLAIMS, sub: 'spiffe://cluster.local/ns/ate/sa/attacker' }),
    { audience: 'substrate-router', getJwks: jwksOf([]) },
  );
  assert.equal(check.valid, false, 'an empty key set must never be treated as verified');
  assert.equal(check.reason, 'no_jwks_keys');
});

test('a non-array keys payload rejects too (a JWKS endpoint answering with junk)', async () => {
  const check = await runner.verifyActorJwt(actorToken({ privateKey: rsaKeypair().privateKey }), {
    audience: 'substrate-router', getJwks: async () => ({ keys: 'not-a-list' }),
  });
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'no_jwks_keys');
});

test('no getJwks seam is a rejection, not an unchecked pass', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const check = await runner.verifyActorJwt(actorToken({ privateKey }), {
    audience: 'substrate-router', getJwks: undefined, jwk,
  });
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'jwks_unavailable');
});

test('a getJwks failure surfaces as an error, not as a caller 401', async () => {
  // The route maps this to 503. Swallowing it into { valid: false } would blame the
  // actor for the planner's own unreachable JWKS URL.
  await assert.rejects(
    () => runner.verifyActorJwt(forgedToken(VALID_CLAIMS), {
      audience: 'substrate-router', getJwks: async () => { throw new Error('jwks_unconfigured'); },
    }),
    /jwks_unconfigured/,
  );
});

test('a signature from a different key fails closed', async () => {
  const honest = rsaKeypair();
  // Same kid, different material: an unfamiliar kid is caught earlier (unknown_kid),
  // so this has to reach the crypto to prove the signature is really checked.
  const other = rsaKeypair();
  const check = await runner.verifyActorJwt(actorToken({ privateKey: honest.privateKey }), {
    audience: 'substrate-router', getJwks: jwksOf([other.jwk]),
  });
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'signature_invalid');
});

test('an unknown kid is rejected rather than verified against any available key', async () => {
  // The old `|| keys[0]` fallback turned a key rotation into "whichever key happens
  // to be published", so a token naming a kid nobody issued got a free pass.
  const { privateKey, jwk } = rsaKeypair('key-2');
  const check = await runner.verifyActorJwt(actorToken({ privateKey, kid: 'revoked-key' }), {
    audience: 'substrate-router', getJwks: jwksOf([jwk]),
  });
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'unknown_kid');
});

test('alg:none is rejected even with a fully valid claim set', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const check = await runner.verifyActorJwt(forgedToken(VALID_CLAIMS), {
    audience: 'substrate-router', getJwks: jwksOf([jwk]),
  });
  assert.equal(check.valid, false);
  assert.match(check.reason, /^unsupported_alg/);
});

test('a missing alg header does not default to RS256', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const [h, p, sig] = actorToken({ privateKey, header: { alg: null } }).split('.');
  assert.ok(!JSON.parse(Buffer.from(h, 'base64')).alg, 'fixture: header carries no alg');
  const check = await runner.verifyActorJwt(`${h}.${p}.${sig}`, {
    audience: 'substrate-router', getJwks: jwksOf([jwk]),
  });
  assert.equal(check.valid, false);
  assert.match(check.reason, /^unsupported_alg/);
});

test('an HMAC token keyed with the published public JWK does not verify', async () => {
  // The classic alg-confusion forgery: use the RSA modulus everyone can fetch as the
  // HMAC secret. The RS*-only pin is what makes this unreachable.
  const { jwk } = rsaKeypair();
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'test-key' }));
  const p = b64u(JSON.stringify({ ...VALID_CLAIMS, exp: now + 60, iat: now }));
  const mac = crypto.createHmac('sha256', JSON.stringify(jwk)).update(`${h}.${p}`).digest();
  const check = await runner.verifyActorJwt(`${h}.${p}.${b64u(mac)}`, {
    audience: 'substrate-router', getJwks: jwksOf([jwk]),
  });
  assert.equal(check.valid, false);
  assert.match(check.reason, /^unsupported_alg/);
});

test('a token with no exp is rejected: the control plane only mints short-lived ones', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const claims = { ...VALID_CLAIMS, exp: null };
  const check = await runner.verifyActorJwt(actorToken({ privateKey, claims }), {
    audience: 'substrate-router', getJwks: jwksOf([jwk]),
  });
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'exp_required');
});

test('an expired token is rejected', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const check = await runner.verifyActorJwt(
    actorToken({ privateKey, claims: { exp: Math.floor(Date.now() / 1000) - 5 } }),
    { audience: 'substrate-router', getJwks: jwksOf([jwk]) },
  );
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'expired');
});

test('an iat in the future is rejected', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const check = await runner.verifyActorJwt(
    actorToken({ privateKey, claims: { iat: Math.floor(Date.now() / 1000) + 3600 } }),
    { audience: 'substrate-router', getJwks: jwksOf([jwk]) },
  );
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'issued_in_future');
});

test('a token with no sub is rejected, so the audit identity is never empty', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const claims = { ...VALID_CLAIMS, sub: null };
  const check = await runner.verifyActorJwt(actorToken({ privateKey, claims }), {
    audience: 'substrate-router', getJwks: jwksOf([jwk]),
  });
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'sub_required');
});

test('another trust domain is rejected', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const check = await runner.verifyActorJwt(
    actorToken({ privateKey, claims: { sub: 'spiffe://other-cluster/ns/x/sa/y' } }),
    { audience: 'substrate-router', trustDomain: 'cluster.local', getJwks: jwksOf([jwk]) },
  );
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'trust_domain_mismatch');
});

test('audience is matched exactly, including when aud is an array', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const wrong = await runner.verifyActorJwt(actorToken({ privateKey, claims: { aud: ['some-other-service'] } }), {
    audience: 'substrate-router', getJwks: jwksOf([jwk]),
  });
  assert.equal(wrong.valid, false);
  assert.equal(wrong.reason, 'audience_mismatch');
  const shared = await runner.verifyActorJwt(
    actorToken({ privateKey, claims: { aud: ['substrate-router', 'fleet-planner'] } }),
    { audience: 'substrate-router', getJwks: jwksOf([jwk]) },
  );
  assert.equal(shared.valid, true, 'a multi-audience token still names its intended verifier');
});

test('a missing aud is a mismatch when the caller requires one', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const claims = { ...VALID_CLAIMS, aud: null };
  const check = await runner.verifyActorJwt(actorToken({ privateKey, claims }), {
    audience: 'substrate-router', getJwks: jwksOf([jwk]),
  });
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'audience_mismatch');
});

test('issuer is checked exactly when the caller pins one', async () => {
  const { privateKey, jwk } = rsaKeypair();
  const check = await runner.verifyActorJwt(
    actorToken({ privateKey, claims: { iss: 'https://attacker.example/oidc' } }),
    { audience: 'substrate-router', issuer: 'https://ate-idp-server.cluster.local', getJwks: jwksOf([jwk]) },
  );
  assert.equal(check.valid, false);
  assert.equal(check.reason, 'issuer_mismatch');
});

test('malformed tokens are rejected before any key lookup', async () => {
  for (const bad of ['', 'a.b', 'not-a-jwt', '....', 'a.b.c.d', 'a.!!!.c']) {
    const check = await runner.verifyActorJwt(bad, { audience: 'substrate-router', getJwks: jwksOf([]) });
    assert.equal(check.valid, false, `${JSON.stringify(bad)} must not verify`);
    assert.equal(check.reason, 'malformed_jwt');
  }
});
