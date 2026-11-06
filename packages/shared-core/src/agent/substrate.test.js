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
