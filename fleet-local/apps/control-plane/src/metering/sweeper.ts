import { actorComputeEventId, customerId } from '@fleet-local/shared';
import { config } from '../config.ts';
import { flexprice } from '../clients/flexprice.ts';
import { listUnmeteredTerminal, markMetered, type SessionRow } from '../db/sessions.ts';
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

// Deterministic event_id (org+session) is what makes retries dedup-safe in
// Flexprice. Pure so the shape + id stability are unit-testable.
export function buildActorComputeEvent(s: SessionRow, rawUser: string): ActorComputeEvent {
  return {
    event_name: 'fleet.actor_compute',
    event_id: actorComputeEventId(s.org_id, s.id),
    timestamp: s.ended_at ?? new Date().toISOString(),
    source: 'fleet-bff',
    external_customer_id: customerId(s.org_id),
    properties: {
      duration_seconds: String(s.duration_seconds ?? 0),
      org_id: s.org_id,
      project_id: s.project_id,
      user_id: rawUser,
      agent_id: s.agent_name,
      tier: s.tier,
      session_id: s.id,
    },
  };
}

// Replaces the absent symphony orchestrator: on a session's terminal state, emit
// the measured compute seconds to Flexprice (fleet.actor_compute, dedup by event_id)
// and to Prometheus via OTLP. Retries are safe — the event_id is deterministic.
export async function sweepOnce(): Promise<number> {
  const sessions = await listUnmeteredTerminal();
  let metered = 0;
  for (const s of sessions) {
    const seconds = s.duration_seconds ?? 0;
    const user = await getUser(s.user_id);
    const rawUser = user?.email ?? s.user_id;
    try {
      await flexprice.bulkEvents([buildActorComputeEvent(s, rawUser)]);
      recordActorSeconds(
        { fleet_org_id: s.org_id, project_id: s.project_id, user_id: rawUser, agent_id: s.agent_name, tier: s.tier },
        seconds,
      );
      await markMetered(s.id);
      metered += 1;
    } catch (err) {
      // Leave metered_at null so the next sweep retries this session.
      console.error(`sweeper: failed to meter session ${s.id}:`, err instanceof Error ? err.message : err);
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