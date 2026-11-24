import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeBaggage,
  decodeBaggage,
  customerId,
  actorComputeEventId,
  nextRunnableSteps,
  ONBOARDING_STEPS,
  BAGGAGE_KEYS,
} from '../src/index.ts';

test('baggage roundtrip preserves unicode and skips empties', () => {
  const entries = {
    [BAGGAGE_KEYS.orgId]: '3f2b8c1e-0000-4000-8000-000000000001',
    [BAGGAGE_KEYS.userId]: 'nirav@example.com',
    empty: '',
    missing: undefined,
  };
  const header = encodeBaggage(entries);
  assert.ok(!header.includes('empty='));
  assert.ok(!header.includes('missing='));
  const back = decodeBaggage(header);
  assert.equal(back[BAGGAGE_KEYS.orgId], entries[BAGGAGE_KEYS.orgId]);
  assert.equal(back[BAGGAGE_KEYS.userId], 'nirav@example.com');
});

test('decodeBaggage tolerates malformed members', () => {
  const back = decodeBaggage('a=1, broken ,b=%zz,c=3');
  assert.equal(back.a, '1');
  assert.equal(back.b, '%zz');
  assert.equal(back.c, '3');
  assert.deepEqual(decodeBaggage(undefined), {});
});

test('customer id is the bare org uuid', () => {
  const uuid = '3f2b8c1e-0000-4000-8000-000000000001';
  assert.equal(customerId(uuid), uuid);
  assert.equal(actorComputeEventId(uuid, 'sess-1'), `ev:${uuid}:sess-1:actor-compute`);
});

test('onboarding DAG respects dependencies and diagram mapping', () => {
  assert.deepEqual(nextRunnableSteps({}), ['org']);
  const states = { org: { step: 'org', status: 'done', attempt: 1, idempotencyKey: 'k' } } as const;
  assert.deepEqual(nextRunnableSteps(states).sort(), ['flexprice', 'namespace', 'project']);
  const diagram = Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.id, s.diagram]));
  assert.equal(diagram.org, 1);
  assert.equal(diagram.namespace, 6);
  assert.equal(diagram.limits, 9);
  const allDone = Object.fromEntries(
    ONBOARDING_STEPS.map((s) => [s.id, { step: s.id, status: 'done', attempt: 1, idempotencyKey: 'k' }]),
  );
  assert.deepEqual(nextRunnableSteps(allDone), []);
});