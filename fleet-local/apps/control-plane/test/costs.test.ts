import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCosts, defaultWindow } from '../src/costs/flexprice.ts';
import type { FlexpriceEvent } from '../src/clients/flexprice.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJ_A = '22222222-2222-4222-8222-222222222222';
const PROJ_B = '33333333-3333-4333-8333-333333333333';
const window = defaultWindow(30);

function ev(eventName: string, properties: Record<string, string>): FlexpriceEvent {
  return {
    id: `ev-${Math.random()}`,
    event_name: eventName,
    external_customer_id: ORG,
    timestamp: new Date().toISOString(),
    properties,
  };
}

const usage = [
  ev('ai.usage', { raw_team: PROJ_A, raw_user: 'alice@example.com', input_tokens: '100', output_tokens: '50', total_tokens: '150', reported_cost: '0.02' }),
  ev('ai.usage', { raw_team: PROJ_B, raw_user: 'bob@example.com', input_tokens: '200', output_tokens: '100', total_tokens: '300', reported_cost: '0.05' }),
];
const compute = [
  ev('fleet.actor_compute', { project_id: PROJ_A, user_id: 'alice@example.com', duration_seconds: '120' }),
  ev('fleet.actor_compute', { project_id: PROJ_B, user_id: 'bob@example.com', duration_seconds: '60' }),
];

test('aggregateCosts sums totals across projects and users', () => {
  const c = aggregateCosts(ORG, window, usage, compute);
  assert.equal(c.totals.inputTokens, 300);
  assert.equal(c.totals.outputTokens, 150);
  assert.equal(c.totals.totalTokens, 450);
  assert.ok(Math.abs(c.totals.usd - 0.07) < 1e-9);
  assert.equal(c.totals.actorSeconds, 180);
});

test('aggregateCosts breaks down by project (raw_team) and user (raw_user)', () => {
  const c = aggregateCosts(ORG, window, usage, compute);
  assert.equal(c.byProject[PROJ_A]?.totalTokens, 150);
  assert.equal(c.byProject[PROJ_B]?.inputTokens, 200);
  assert.equal(c.byUser['alice@example.com']?.outputTokens, 50);
  assert.equal(c.byUser['bob@example.com']?.totalTokens, 300);
});

test('aggregateCosts rows carry per-project actor seconds', () => {
  const c = aggregateCosts(ORG, window, usage, compute);
  assert.equal(c.rows.length, 2);
  const a = c.rows.find((r) => r.projectId === PROJ_A);
  const b = c.rows.find((r) => r.projectId === PROJ_B);
  assert.equal(a?.actorSeconds, 120);
  assert.equal(a?.usd, 0.02);
  assert.equal(b?.actorSeconds, 60);
  assert.equal(b?.orgId, ORG);
});

test('aggregateCosts tolerates missing/blank numeric properties', () => {
  const c = aggregateCosts(ORG, window, [ev('ai.usage', { raw_team: PROJ_A })], []);
  assert.equal(c.totals.totalTokens, 0);
  assert.equal(c.totals.usd, 0);
  assert.equal(c.byProject[PROJ_A]?.inputTokens, 0);
});

test('aggregateCosts counts untagged usage in totals but not breakdowns', () => {
  const c = aggregateCosts(ORG, window, [ev('ai.usage', { total_tokens: '10', reported_cost: '0.01' })], []);
  assert.equal(c.totals.totalTokens, 10);
  assert.deepEqual(c.byProject, {});
  assert.deepEqual(c.byUser, {});
  assert.equal(c.rows.length, 0);
});

test('aggregateCosts on empty input is all zeros', () => {
  const c = aggregateCosts(ORG, window, [], []);
  assert.equal(c.totals.actorSeconds, 0);
  assert.equal(c.totals.usd, 0);
  assert.deepEqual(c.rows, []);
});