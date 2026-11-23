import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActorComputeEvent } from '../src/metering/sweeper.ts';
import type { SessionRow } from '../src/db/sessions.ts';
import { actorComputeEventId } from '@fleet-local/shared';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJ = '22222222-2222-4222-8222-222222222222';

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    org_id: ORG,
    project_id: PROJ,
    user_id: 'user-uuid',
    agent_name: 'demo-agent-worker',
    agent_namespace: 'org-demo',
    model: 'mock',
    kagent_session_id: 'ctx-1',
    kagent_task_id: 'task-1',
    status: 'closed',
    tier: 'gvisor-default',
    started_at: '2026-11-21T00:00:00.000Z',
    ended_at: '2026-11-21T00:02:00.000Z',
    duration_seconds: 120,
    metered_at: null,
    outcome: 'completed',
    close_reason: null,
    meter_seconds: 120,
    billed_seconds: 0,
    awaiting_since: null,
    turn: 1,
    metered_seconds: null,
    metered_outcome: null,
    ...overrides,
  };
}

test('actor-compute event_id is deterministic so retries dedup', () => {
  const s = session();
  const a = buildActorComputeEvent(s, 'nirav@example.com');
  const b = buildActorComputeEvent(s, 'nirav@example.com');
  assert.equal(a.event_id, b.event_id);
  // Keyed on the TURN, not only the session: a continuing conversation has to
  // bill more than once, while a retry of the same turn still dedups.
  assert.equal(a.event_id, actorComputeEventId(ORG, 'sess-1:t1'));
});

test('a different session or a different turn yields a different event_id', () => {
  const a = buildActorComputeEvent(session({ id: 'sess-1' }), 'u@x.com');
  const b = buildActorComputeEvent(session({ id: 'sess-2' }), 'u@x.com');
  const c = buildActorComputeEvent(session({ id: 'sess-1', turn: 2 }), 'u@x.com');
  assert.notEqual(a.event_id, b.event_id);
  assert.notEqual(a.event_id, c.event_id);
});

test('actor-compute event attributes to the bare org uuid with fleet properties', () => {
  const e = buildActorComputeEvent(session(), 'nirav@example.com');
  assert.equal(e.event_name, 'fleet.actor_compute');
  assert.equal(e.source, 'fleet-bff');
  assert.equal(e.external_customer_id, ORG);
  assert.equal(e.timestamp, '2026-11-21T00:02:00.000Z');
  assert.deepEqual(e.properties, {
    duration_seconds: '120',
    wall_seconds: '120',
    outcome: 'completed',
    turn: '1',
    org_id: ORG,
    project_id: PROJ,
    user_id: 'nirav@example.com',
    agent_id: 'demo-agent-worker',
    tier: 'gvisor-default',
    session_id: 'sess-1',
  });
});

test('actor-compute bills the measured compute, not the wall clock', () => {
  // A conversation paused 300s on input-required between two 40s turns: the
  // human's think-time must never reach the invoice.
  const e = buildActorComputeEvent(session({ duration_seconds: 380, meter_seconds: 80, billed_seconds: 40 }), 'u@x.com');
  assert.equal(e.properties.duration_seconds, '40');
  assert.equal(e.properties.wall_seconds, '380');
});

test('actor-compute tolerates a null duration', () => {
  const e = buildActorComputeEvent(session({ duration_seconds: null, meter_seconds: null }), 'u@x.com');
  assert.equal(e.properties.duration_seconds, '0');
});
