'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFields, decodeVarint, pbVarint, pbString, pbMessage, getString, getStrings } = require('./grpc-wire');
const s = require('./substrate');

// A fake transport that echoes a canned gRPC frame per RPC method, so we can
// round-trip our encoders against our own decoders without a live Control plane.
function fakeTransport(responder) {
  return (method, requestPayload, opts) => {
    const frame = responder(method, requestPayload, opts);
    return Promise.resolve({
      status: frame.status ?? 0,
      message: frame.message ?? '',
      headers: {},
      trailers: {},
      frames: [frame.payload || Buffer.alloc(0)],
      firstFrame: frame.payload || Buffer.alloc(0),
    });
  };
}

// A deployment that declared no tenancy at all keeps the single historical space.
// The interesting cases — a binding table, a pinned per-tenant atespace, and an
// unbound org refusing — need env, so they live in substrate-atespace.test.js.
test('resolveSubstrateAtespace ignores a name the operator never declared', () => {
  assert.equal(s.resolveSubstrateAtespace({ atespace: 'tenant-b' }), 'tenant-a');
  assert.equal(s.resolveSubstrateAtespace({ organizationId: 'acme-tenant-b' }), 'tenant-a');
});

// The retired rule: an org id whose text happened to end in `-b` was routed into
// tenant-b's namespace, sharing its actors, worker pool and egress policy with an
// organization that never provisioned there.
test('the shape of an organization id no longer selects a namespace', () => {
  for (const organizationId of ['acme-tenant-b', 'x-b', 'B', 'tenant-b']) {
    assert.equal(s.resolveSubstrateAtespace({ organizationId }), 'tenant-a', organizationId);
  }
  // A project id never owned a namespace either.
  assert.equal(s.resolveSubstrateAtespace({ organizationId: 'org-a', projectId: 'proj-tenant-b' }), 'tenant-a');
});

test('normalizeActorName is DNS-safe and deterministic', () => {
  assert.equal(s.normalizeActorName('My_Actor 9', 'p', 'r'), 'my-actor-9');
  const auto = s.normalizeActorName(null, 'proj-1', 'run-2');
  assert.match(auto, /^plan-proj-1-run-2$/);
});

test('upsertActorTemplate requires a digest-pinned planner image', async () => {
  await assert.rejects(
    () => s.upsertActorTemplate({ url: 'http://x', image: 'ghcr.io/o/planner:latest' }),
    /digest/,
  );
});

// Two independent facts have to reach the actor container through this one map, and
// the ActorTemplate is the only way either can:
//   * verification — the image cannot self-bootstrap SUBSTRATE_JWKS_URL (empty env by
//     design), so the control plane must forward the JWT-verification names Terraform
//     rendered onto it, or the actor answers 503 jwks_unconfigured for every prompt;
//   * tenancy — a signature only says WHICH WORKLOAD called, while
//     `body.organizationId` is caller-written, so the template hands the actor its own
//     atespace, pinned to exactly one space, and the one org binding that resolves to
//     it.
// Nothing credential-shaped may join the map: an actor runs model-generated code, and
// its env is readable by that code.
// Not a pullable reference - upsertActorTemplate only requires the @sha256: digest
// form, and the transport below is stubbed.
const PINNED_IMAGE = `planner@sha256:${'0'.repeat(64)}`;

const JWT_ENV_NAMES = [
  'SUBSTRATE_JWKS_URL', 'SUBSTRATE_ACTOR_JWT_AUDIENCE', 'SUBSTRATE_TRUST_DOMAIN',
];

function capturingTransport(box) {
  return async (method, payload) => {
    box.method = method;
    box.payload = payload;
    return { status: 0, frames: [Buffer.alloc(0)], firstFrame: Buffer.alloc(0) };
  };
}

/** The actor container's env, as it went on the wire. */
function templateEnv(request) {
  // grpcCall's payload is CreateActorTemplateRequest{ template = 1 }.
  const template = decodeFields(decodeFields(request).get(1)[0].value);
  const containers = (template.get(3) || []).map((entry) => entry.value);
  assert.equal(containers.length, 1, 'one planner container');
  const env = {};
  for (const entry of decodeFields(containers[0]).get(5) || []) {
    const fields = decodeFields(entry.value);
    env[getString(fields, 1)] = getString(fields, 2);
  }
  return env;
}

/** Run `fn` with the actor-JWT env names set to `values`; an undefined value unset. */
async function withJwtEnv(values, fn) {
  const saved = Object.fromEntries(JWT_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of JWT_ENV_NAMES) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// 'tenant-a' because that is the space this (tenancy-free) test deployment resolves
// to; resolution itself is substrate-atespace.test.js's job. What is asserted here is
// that the template hands the actor exactly the space it was created in.
test('upsertActorTemplate pins the actor to its own atespace and org', async () => {
  await withJwtEnv({}, async () => {
    const box = {};
    await s.upsertActorTemplate({
      url: 'http://x',
      transport: capturingTransport(box),
      atespace: 'tenant-a',
      image: PINNED_IMAGE,
      organizationId: 'org-acme',
    });
    assert.equal(box.method, 'CreateActorTemplate');
    const env = templateEnv(box.payload);
    assert.equal(env.SUBSTRATE_ATESPACE, 'tenant-a');
    assert.equal(env.SUBSTRATE_ALLOWED_ATESPACES, 'tenant-a',
      'exactly one nameable space: a wider allowlist would let the actor route work into another tenant');
    assert.equal(env.SUBSTRATE_ATESPACE_BY_ORG, 'org-acme=tenant-a');
    assert.deepEqual(Object.keys(env).sort(), [
      'SUBSTRATE_ACTOR_MODE', 'SUBSTRATE_ALLOWED_ATESPACES', 'SUBSTRATE_ATESPACE', 'SUBSTRATE_ATESPACE_BY_ORG',
    ], 'the actor template carries identity and a mount flag, never a credential');
  });
});

test('upsertActorTemplate omits the org binding when the caller has no organization', async () => {
  await withJwtEnv({}, async () => {
    const box = {};
    await s.upsertActorTemplate({
      url: 'http://x', transport: capturingTransport(box), atespace: 'tenant-a', image: PINNED_IMAGE,
    });
    const env = templateEnv(box.payload);
    assert.equal(env.SUBSTRATE_ATESPACE, 'tenant-a');
    assert.equal(env.SUBSTRATE_ATESPACE_BY_ORG, undefined,
      'an unbound org must not be encoded as a binding to some other org');
  });
});

test('upsertActorTemplate forwards the actor-JWT verification env into the container', async () => {
  await withJwtEnv({
    SUBSTRATE_JWKS_URL: 'https://idp.example.com/discovery/keys',
    SUBSTRATE_ACTOR_JWT_AUDIENCE: 'substrate-router',
  }, async () => {
    const box = {};
    await s.upsertActorTemplate({
      url: 'http://substrate:8443',
      transport: capturingTransport(box),
      atespace: 'tenant-a',
      image: PINNED_IMAGE,
    });
    const env = templateEnv(box.payload);
    assert.equal(env.SUBSTRATE_ACTOR_MODE, 'true');
    assert.equal(env.SUBSTRATE_JWKS_URL, 'https://idp.example.com/discovery/keys');
    assert.equal(env.SUBSTRATE_ACTOR_JWT_AUDIENCE, 'substrate-router');
    assert.equal(env.SUBSTRATE_TRUST_DOMAIN, undefined, 'a name the operator never declared stays absent');
    assert.equal(env.SUBSTRATE_ATESPACE, 'tenant-a', 'forwarding verification must not drop the tenant pin');
  });
});
test('CreateActor round-trips through encodeActor -> decodeActor', async () => {
  const reqs = [];
  const transport = (method, payload) => {
    reqs.push({ method, payload });
    // Echo back an Actor whose metadata + RUNNING status we decode on the reply.
    const actor = Buffer.concat([
      pbMessage(1, s.encodeMetadata({ atespace: 'tenant-a', name: 'plan-x', uid: 'u1', version: 3 })),
      // status (field 5) with state RUNNING (field 1 = 2)
      pbMessage(5, pbVarint(1, 2)),
    ]);
    return Promise.resolve({ status: 0, frames: [actor], firstFrame: actor });
  };
  const actor = await s.createEphemeralActor({
    url: 'http://substrate:8443',
    atespace: 'tenant-a',
    actorTemplate: 'planner',
    actorName: 'plan-x',
    transport,
  });
  assert.equal(actor.metadata.name, 'plan-x');
  assert.equal(actor.metadata.atespace, 'tenant-a');
  assert.equal(actor.status.state, 'RUNNING');
  assert.equal(reqs[0].method, 'CreateActor');
});

test('createActorEgressPolicy renders allowHosts as HTTPS rules', async () => {
  let captured;
  const transport = (method, payload) => {
    captured = { method, payload };
    const policy = Buffer.concat([
      pbMessage(1, s.encodeMetadata({ atespace: 'tenant-a', name: 'default' })),
      pbMessage(2, pbMessage(2, pbString(1, 'openrouter.ai'))), // rules=2 -> https=2 -> hostnames=1
    ]);
    return Promise.resolve({ status: 0, frames: [policy], firstFrame: policy });
  };
  const policy = await s.createActorEgressPolicy({
    url: 'http://substrate',
    atespace: 'tenant-a',
    name: 'plan-x',
    guardrailSpec: { egress: { allowHosts: ['openrouter.ai'] } },
    transport,
  });
  assert.equal(captured.method, 'CreateActorEgressPolicy');
  assert.deepEqual(policy.rules, [{ scheme: 'https', hostnames: ['openrouter.ai'] }]);
});

test('encodePorts packs repeated int32 and round-trips at the wire layer', () => {
  const rule = s.encodeEgressRule({ https: { hostnames: ['api.github.com'], ports: [443, 80] } });
  const httpsBytes = decodeFields(rule).get(2)[0].value; // https=2
  const httpsFields = decodeFields(httpsBytes);
  assert.deepEqual(getStrings(httpsFields, 1), ['api.github.com']);
  const portsBytes = httpsFields.get(2)[0].value; // ports=2 -> Ports message
  const packed = decodeFields(portsBytes).get(2)[0].value; // numbers (packed)
  const nums = [];
  let off = 0;
  while (off < packed.length) {
    const v = decodeVarint(packed, off);
    nums.push(Number(v.value));
    off = v.nextOffset;
  }
  assert.deepEqual(nums, [443, 80]);
});

test('getControlPlaneStatus reports UNCONFIGURED with no url', async () => {
  const st = await s.getControlPlaneStatus({ url: '' });
  assert.equal(st.configured, false);
  assert.equal(st.status, 'UNCONFIGURED');
});

test('grpcCall throws when substrate is unconfigured', async () => {
  await assert.rejects(
    () => s.grpcCall('ListActors', Buffer.alloc(0), { url: '' }),
    /not configured/,
  );
});

// ── ateapi credential (managed secret `substrateApiToken`) ───────────────────

test('resolveSubstrateApiToken takes the S2S managed key, explicit wins, blank when absent', async () => {
  const calls = [];
  const fetchSecrets = async (opts) => {
    calls.push(opts);
    return { substrateApiToken: '  sa-projected-token  ', githubToken: 'gh' };
  };
  assert.equal(await s.resolveSubstrateApiToken({ organizationId: 'acme', projectId: 'p1', fetchSecrets }), 'sa-projected-token');
  assert.equal(calls[0].organizationId, 'acme');
  // An already-resolved value (the route's secrets map) short-circuits the fetch.
  assert.equal(await s.resolveSubstrateApiToken({ token: 'explicit', fetchSecrets }), 'explicit');
  assert.equal(calls.length, 1);
  // Nothing published yet → '' (the wire layer reports it), never a throw.
  assert.equal(await s.resolveSubstrateApiToken({ organizationId: 'acme', fetchSecrets: async () => ({}) }), '');
  // A resolver outage degrades to '' too rather than failing the whole run early.
  assert.equal(await s.resolveSubstrateApiToken({ organizationId: 'acme', fetchSecrets: async () => { throw new Error('settings down'); } }), '');
});

test('a resolved token reaches the gRPC authorization header', async () => {
  const seen = [];
  const transport = (method, payload, opts) => {
    seen.push({ method, authorization: opts.authorization });
    return Promise.resolve({ status: 0, message: '', headers: {}, trailers: {}, frames: [], firstFrame: Buffer.alloc(0) });
  };
  const token = await s.resolveSubstrateApiToken({
    organizationId: 'acme',
    fetchSecrets: async () => ({ substrateApiToken: 'sa-projected-token' }),
  });
  await s.listActors({ url: 'https://substrate.test', atespace: 'tenant-a', token, transport });
  assert.equal(seen[0].authorization, 'Bearer sa-projected-token');
  // A raw `Bearer …` value is not double-prefixed.
  await s.listActors({ url: 'https://substrate.test', atespace: 'tenant-a', token: 'Bearer sa-2', transport });
  assert.equal(seen[1].authorization, 'Bearer sa-2');
});

test('grpcCall fails closed naming substrateApiToken instead of sending an unauthenticated call', async () => {
  const saved = process.env.SUBSTRATE_TOKEN;
  delete process.env.SUBSTRATE_TOKEN;
  try {
    await assert.rejects(
      () => s.grpcCall('ListActors', Buffer.alloc(0), { url: 'https://substrate.test', organizationId: 'acme' }),
      /substrateApiToken/,
    );
  } finally {
    if (saved !== undefined) process.env.SUBSTRATE_TOKEN = saved;
  }
});

test('the legacy SUBSTRATE_TOKEN env fallback still authenticates local dev', async () => {
  const saved = process.env.SUBSTRATE_TOKEN;
  process.env.SUBSTRATE_TOKEN = 'local-dev-token';
  try {
    const seen = [];
    const transport = (method, payload, opts) => {
      seen.push(opts.authorization);
      return Promise.resolve({ status: 0, message: '', headers: {}, trailers: {}, frames: [], firstFrame: Buffer.alloc(0) });
    };
    await s.listActors({ url: 'https://substrate.test', atespace: 'tenant-a', transport });
    assert.deepEqual(seen, ['Bearer local-dev-token']);
  } finally {
    if (saved === undefined) delete process.env.SUBSTRATE_TOKEN;
    else process.env.SUBSTRATE_TOKEN = saved;
  }
});

test('a rejected credential is reported as such, not as a bare gRPC 16', async () => {
  const transport = () => Promise.resolve({
    status: 16,
    message: 'missing bearer token',
    headers: {},
    trailers: {},
    frames: [],
    firstFrame: Buffer.alloc(0),
  });
  await assert.rejects(
    () => s.listActors({ url: 'https://substrate.test', atespace: 'tenant-a', token: 'stale', transport }),
    /substrateApiToken/,
  );
});
