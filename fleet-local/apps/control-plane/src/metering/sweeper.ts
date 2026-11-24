import { actorComputeEventId, customerId } from '@fleet-local/shared';
import { config } from '../config.ts';
import { isOutcome, settlementPolicy, type Outcome } from '../a2a/contract.ts';
import { flexprice } from '../clients/flexprice.ts';
import { listUnmeteredSettled, markMetered, type SessionRow } from '../db/sessions.ts';
import { getUser } from '../db/users.ts';
import { recordActorSeconds } from './otlp.ts';

export interface ActorComputeEvent {
  event_name: 'fleet.actor_compute';
  event_id: string;
  timestamp: string;
  source: 'fleet-bff';
  external_customer_id: string;
  properties: Record<string, string>;
}

// Rows created before the outcome column read as a completed turn, so billing
// history keeps reconciling instead of silently stopping.
export function turnOutcome(s: SessionRow): Outcome {
  return isOutcome(s.outcome) ? s.outcome : 'completed';
}

// The billable amount is the compute measured since the last accounting: the
// conversation's cumulative stream seconds minus whatever was already invoiced.
// A turn that settles while an earlier one is still unsweeped therefore bills
// both, and no window is lost. Legacy rows carry no measurement and fall back to
// the wall clock they were billed on before, keeping old statements reproducible.
export function turnSeconds(s: SessionRow): number {
  return Math.max(0, (s.meter_seconds ?? s.duration_seconds ?? 0) - (s.billed_seconds ?? 0));
}

// Deterministic per (org, session, turn): the turn number is what lets a
// continuing conversation bill more than once while a retry of the SAME turn
// still dedups in Flexprice.
export function turnEventId(s: SessionRow): string {
  return actorComputeEventId(s.org_id, `${s.id}:t${s.turn}`);
}

// Pure so the shape + id stability are unit-testable. Callers only build an event
// when settlementPolicy says the turn is billable.
export function buildActorComputeEvent(s: SessionRow, rawUser: string): ActorComputeEvent {
  return {
    event_name: 'fleet.actor_compute',
    event_id: turnEventId(s),
    timestamp: s.ended_at ?? new Date().toISOString(),
    source: 'fleet-bff',
    external_customer_id: customerId(s.org_id),
    properties: {
      duration_seconds: String(turnSeconds(s)),
      wall_seconds: String(s.duration_seconds ?? 0),
      outcome: turnOutcome(s),
      turn: String(s.turn),
      org_id: s.org_id,
      project_id: s.project_id,
      user_id: rawUser,
      agent_id: s.agent_name,
      tier: s.tier,
      session_id: s.id,
    },
  };
}

// Replaces the absent symphony orchestrator: on a settled turn, emit the measured
// compute seconds to Flexprice (fleet.actor_compute, dedup by event_id) and to
// Prometheus via OTLP. Retries are safe — the event_id is deterministic and
// metered_at is only stamped once the emit succeeded.
//
// A turn the platform broke is acknowledged with 0 seconds rather than left
// un-metered: it must not be billed, and it must not re-enter every sweep.
export async function sweepOnce(): Promise<number> {
  const sessions = await listUnmeteredSettled();
  let metered = 0;
  for (const s of sessions) {
    const outcome = turnOutcome(s);
    const seconds = settlementPolicy(s.status, outcome) === 'meter' ? turnSeconds(s) : 0;
    const user = await getUser(s.user_id);
    const rawUser = user?.email ?? s.user_id;
    try {
      if (seconds > 0) {
        await flexprice.bulkEvents([buildActorComputeEvent(s, rawUser)]);
        recordActorSeconds(
          { fleet_org_id: s.org_id, project_id: s.project_id, user_id: rawUser, agent_id: s.agent_name, tier: s.tier },
          seconds,
        );
      }
      await markMetered(s.id, seconds, outcome);
      if (seconds > 0) metered += 1;
    } catch (err) {
      // Leave metered_at null so the next sweep retries this turn.
      console.error(`sweeper: failed to meter session ${s.id} turn ${s.turn}:`, err instanceof Error ? err.message : err);
    }
  }
  return metered;
}

export function startSweeper(): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void sweepOnce().catch((err) => console.error('sweeper error:', err));
  }, config.sweeperIntervalSeconds * 1000);
  timer.unref();
  return timer;
}
