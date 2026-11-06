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

test('resolveSubstrateAtespace maps org/project to an allowed atespace', () => {
  assert.equal(s.resolveSubstrateAtespace({ atespace: 'tenant-b' }), 'tenant-b');
  assert.equal(s.resolveSubstrateAtespace({ atespace: 'nope' }), 'tenant-a');
  assert.equal(s.resolveSubstrateAtespace({ organizationId: 'acme-tenant-b' }), 'tenant-b');
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
