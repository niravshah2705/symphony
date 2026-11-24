import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActorComputeEvent, turnEventId, turnOutcome, turnSeconds } from '../src/metering/sweeper.ts';
import { settlementPolicy } from '../src/a2a/contract.ts';
import type { SessionRow } from '../src/db/sessions.ts';

const ORG = '33333333-3333-4333-8333-333333333333';

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's-1',
    org_id: ORG,
    project_id: '44444444-4444-4444-8444-444444444444',
    user_id: 'u-1',
    agent_name: 'demo-agent-claude-worker',
    agent_namespace: 'org-demo',
    model: 'claude',
    kagent_session_id: 'ctx-1',
    kagent_task_id: null,
    status: 'closed',
    tier: 'gvisor-default',
    started_at: '2026-11-22T10:00:00.000Z',
    ended_at: '2026-11-22T10:01:30.000Z',
    duration_seconds: 90,
    metered_at: null,
    outcome: 'completed',
    close_reason: null,
    meter_seconds: 42,
    billed_seconds: 0,
    awaiting_since: null,
    turn: 1,
    metered_seconds: null,
    metered_outcome: null,
    ...overrides,
  };
}

test('a legacy row with no outcome still reads as a completed turn', () => {
  // Billing history must keep reconciling instead of silently stopping.
  assert.equal(turnOutcome(row({ outcome: null })), 'completed');
  assert.equal(turnOutcome(row({ outcome: 'DROP TABLE sessions' })), 'completed');
  assert.equal(turnOutcome(row({ outcome: 'failed' })), 'failed');
});

test('the billable amount is measured compute minus what was already invoiced', () => {
  assert.equal(turnSeconds(row({ meter_seconds: 42, billed_seconds: 0 })), 42);
  // Turn 2 of a conversation: 42s total measured, 30s of it already billed.
  assert.equal(turnSeconds(row({ meter_seconds: 42, billed_seconds: 30, turn: 2 })), 12);
  // A pre-migration row: no measurement, so the wall clock it was billed on.
  assert.equal(turnSeconds(row({ meter_seconds: null, billed_seconds: null, duration_seconds: 90 })), 90);
  assert.equal(turnSeconds(row({ meter_seconds: null, duration_seconds: null })), 0);
  // Replayed accounting must never bill backwards.
  assert.equal(turnSeconds(row({ meter_seconds: 10, billed_seconds: 25 })), 0);
});

test('a paused turn bills its compute and never the human think-time', () => {
  // 90s of wall clock, 42s of it streaming; the rest was the user reading.
  const paused = row({ status: 'awaiting_input', outcome: 'awaiting_input', duration_seconds: 900, meter_seconds: 42 });
  assert.equal(settlementPolicy(paused.status, turnOutcome(paused)), 'meter');
  assert.equal(turnSeconds(paused), 42);
  const e = buildActorComputeEvent(paused, 'nirav@example.com');
  assert.equal(e.properties.duration_seconds, '42');
  assert.equal(e.properties.wall_seconds, '900');
  assert.equal(e.properties.outcome, 'awaiting_input');
});

test('a turn the platform broke is acknowledged with zero, never billed', () => {
  // The expired-key case: TASK_STATE_FAILED came from a dead provider, so the
  // wall clock is not something the customer should pay for.
  const broke = row({ outcome: 'upstream_error', close_reason: 'Error 401: Invalid API key #1005', meter_seconds: 12 });
  assert.equal(settlementPolicy(broke.status, turnOutcome(broke)), 'skip');

  const silent = row({ outcome: 'no_events', meter_seconds: 0 });
  assert.equal(settlementPolicy(silent.status, turnOutcome(silent)), 'skip');
});

test('a turn the agent itself failed, or the user cancelled, does bill', () => {
  assert.equal(settlementPolicy('closed', turnOutcome(row({ outcome: 'failed' }))), 'meter');
  assert.equal(settlementPolicy('closed', turnOutcome(row({ outcome: 'cancelled' }))), 'meter');
  assert.equal(settlementPolicy('closed', turnOutcome(row({ outcome: 'rejected' }))), 'meter');
  assert.equal(settlementPolicy('closed', turnOutcome(row({ outcome: 'client_abort' }))), 'meter');
});

test('an unsettled row is never swept', () => {
  assert.equal(settlementPolicy('running', 'completed'), 'skip');
  assert.equal(settlementPolicy('running', null), 'skip');
});

test('the event id is stable per turn so retries dedup but continuations do not', () => {
  const first = turnEventId(row());
  assert.equal(turnEventId(row()), first);
  assert.notEqual(turnEventId(row({ turn: 2 })), first);
  assert.notEqual(turnEventId(row({ id: 's-2' })), first);
});
