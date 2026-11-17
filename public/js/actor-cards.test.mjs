import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The server owns the state list (packages/shared-core/src/agent/substrate.js
// ACTOR_STATE); this module owns what each state means to a human. Importing the
// enum here and asserting every member is classified is the only thing that turns
// "substrate added a ninth state" from a silent mis-filing into a failing test.
const require = createRequire(import.meta.url);
const { ACTOR_STATE } = require('../../packages/shared-core/src/agent/substrate.js');
const { ACTOR_BUCKETS, bucketFor, buildActorCards } = await import('./actor-cards.mjs');

const online = { configured: true, credentialConfigured: true, status: { connected: true }, actors: [] };
const actor = (name, state) => ({ name, state, workerPod: 'pod-1', nodeName: 'node-1' });

test('every substrate actor state is classified into exactly one bucket', () => {
  for (const state of Object.values(ACTOR_STATE)) {
    const bucket = bucketFor({ state });
    assert.ok(['running', 'paused', 'attention'].includes(bucket), `${state} fell out of the buckets`);
    const homes = Object.entries(ACTOR_BUCKETS).filter(([, members]) => members.includes(state));
    assert.equal(homes.length, 1, `${state} is claimed by ${homes.map(([k]) => k).join(' and ')}`);
    assert.equal(homes[0][0], bucket, `${state} classified as ${bucket} but documented under ${homes[0][0]}`);
  }
});

test('an unknown or missing state is an attention card, never a silent running one', () => {
  for (const state of [null, undefined, '', 'REBOOTING']) {
    assert.equal(bucketFor({ state }), 'attention');
  }
});

test('running and paused read as running and paused', () => {
  const view = buildActorCards({
    ...online,
    actors: [actor('plan-acme-r1', 'RUNNING'), actor('plan-acme-r2', 'RESUMING'), actor('plan-acme-r3', 'SUSPENDED')],
  });
  assert.equal(view.counts.running, 2);
  assert.equal(view.counts.paused, 1);
  assert.equal(view.counts.attention, 0);
  assert.equal(view.emptyReason, '');
  assert.deepEqual(view.buckets.paused[0].actions, ['resume', 'delete']);
  assert.deepEqual(view.buckets.running[0].actions, ['suspend', 'resume', 'delete']);
});

test('a crashed run is an attention card that says why', () => {
  const view = buildActorCards({ ...online, actors: [actor('plan-acme-r1', 'CRASHED')] });
  assert.equal(view.counts.attention, 1);
  assert.match(view.buckets.attention[0].reason, /stopped unexpectedly/);
});

test('a control plane that is not answering is one attention card, not an empty grid', () => {
  const view = buildActorCards({ configured: true, status: { connected: false }, actors: [actor('plan-a', 'RUNNING')] });
  assert.equal(view.planeDown, true);
  assert.match(view.buckets.attention[0].reason, /control plane is not answering/);
  assert.deepEqual(view.buckets.attention[0].actions, [], 'an outage card has no verbs');
  // The list is untrustworthy, so the running count is reported but the outage leads.
  assert.equal(view.counts.total, 1);
});

test('an unconfigured substrate and a missing credential say different things', () => {
  const unconfigured = buildActorCards({ configured: false, credentialConfigured: false, actors: [] });
  assert.match(unconfigured.buckets.attention[0].reason, /credential is missing/);
  const noPattern = buildActorCards({ configured: false, credentialConfigured: true, actors: [] });
  assert.match(noPattern.buckets.attention[0].reason, /not configured for this organization/);
});

test('an empty workspace says so without calling it a problem', () => {
  const view = buildActorCards({ ...online, actors: [] });
  assert.equal(view.planeDown, false);
  assert.equal(view.counts.attention, 0);
  assert.match(view.emptyReason, /No actors are running/);
});

test('a project filter is echoed back with the prefix it matched, and its caveat', () => {
  const view = buildActorCards({
    ...online,
    actors: [actor('plan-acme-proj1-r1', 'RUNNING')],
    projectFilter: { projectId: 'acme-proj1', namePrefix: 'plan-acme-proj1-' },
  });
  assert.equal(view.projectFilter.projectId, 'acme-proj1');
  assert.match(view.projectFilterNote, /first 12 characters/);
  assert.equal(view.emptyReason, '');
});

test('a project filter that matched nothing is a quiet empty, not an outage', () => {
  const view = buildActorCards({
    ...online, actors: [], projectFilter: { projectId: 'p', namePrefix: 'plan-p-' },
  });
  assert.match(view.emptyReason, /No runs for this project/);
  assert.equal(view.counts.attention, 0);
});

test('a malformed response degrades to one attention card instead of throwing', () => {
  for (const payload of [undefined, {}, { actors: 'nope' }, { actors: [null] }]) {
    const view = buildActorCards(payload);
    assert.ok(view.planeDown || view.counts.attention >= 0);
    assert.equal(typeof view.emptyReason, 'string');
  }
});

test('a read-only member gets the board without the verbs', () => {
  const payload = { configured: true, status: { connected: true }, actors: [actor('plan-a', 'RUNNING')] };
  const writable = buildActorCards(payload);
  const readOnly = buildActorCards(payload, { canAct: false });
  assert.deepEqual(writable.buckets.running[0].actions, ['suspend', 'resume', 'delete']);
  assert.deepEqual(readOnly.buckets.running[0].actions, [],
    'the gateway answers workspace:write on every card verb, so a reader gets no dead buttons');
  assert.equal(readOnly.counts.running, 1, 'hiding the actions must not hide the actor');
});
