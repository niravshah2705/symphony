import { one, query } from './client.ts';
import type { Outcome } from '../a2a/contract.ts';

export interface SessionRow {
  id: string;
  org_id: string;
  project_id: string;
  user_id: string;
  agent_name: string;
  agent_namespace: string;
  model: string | null;
  kagent_session_id: string | null;
  kagent_task_id: string | null;
  status: string;
  tier: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  metered_at: string | null;
  outcome: string | null;
  close_reason: string | null;
  meter_seconds: number | null;
  billed_seconds: number | null;
  awaiting_since: string | null;
  turn: number;
  metered_seconds: number | null;
  metered_outcome: string | null;
  thread_id: string | null;
}

const COLS =
  'id, org_id, project_id, user_id, agent_name, agent_namespace, model, kagent_session_id, kagent_task_id, status, tier, started_at, ended_at, duration_seconds, metered_at, outcome, close_reason, meter_seconds, billed_seconds, awaiting_since, turn, metered_seconds, metered_outcome, thread_id';

export async function createSession(input: {
  orgId: string;
  projectId: string;
  userId: string;
  agentName: string;
  agentNamespace: string;
  model?: string;
  tier?: string;
  threadId?: string;
}): Promise<SessionRow> {
  const row = await one<SessionRow>(
    `INSERT INTO sessions (org_id, project_id, user_id, agent_name, agent_namespace, model, tier, thread_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
    [
      input.orgId,
      input.projectId,
      input.userId,
      input.agentName,
      input.agentNamespace,
      input.model ?? null,
      input.tier ?? 'gvisor-default',
      input.threadId ?? null,
    ],
  );
  if (!row) throw new Error('session insert returned no row');
  return row;
}

export async function setKagentIds(sessionId: string, kagentSessionId: string, kagentTaskId?: string): Promise<void> {
  await query('UPDATE sessions SET kagent_session_id = $2, kagent_task_id = COALESCE($3, kagent_task_id) WHERE id = $1', [
    sessionId,
    kagentSessionId,
    kagentTaskId ?? null,
  ]);
}

export async function getSession(id: string): Promise<SessionRow | undefined> {
  return one<SessionRow>(`SELECT ${COLS} FROM sessions WHERE id = $1`, [id]);
}

export async function listSessions(orgId: string, projectId?: string): Promise<SessionRow[]> {
  const res = projectId
    ? await query<SessionRow>(`SELECT ${COLS} FROM sessions WHERE org_id = $1 AND project_id = $2 ORDER BY started_at DESC`, [orgId, projectId])
    : await query<SessionRow>(`SELECT ${COLS} FROM sessions WHERE org_id = $1 ORDER BY started_at DESC`, [orgId]);
  return res.rows;
}

// One turn of a conversation, settled. duration_seconds stays the session's wall
// clock (the human-facing total); the billable amount is meter_seconds, the time
// an agent stream actually ran. outcome says WHICH terminal it was and reason
// carries the agent's own explanation when it failed — together they are what the
// UI renders instead of "(no output)".
//
// meter_seconds is CUMULATIVE for the conversation, seeded from what history has
// already invoiced (billed_seconds, or the legacy wall clock) so a turn's compute
// is never counted twice and the sweeper's delta is never negative.
export async function settleTurn(
  sessionId: string,
  seconds: number,
  outcome: Outcome,
  reason: string | null = null,
): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    `UPDATE sessions
        SET status = 'closed', ended_at = now(),
            duration_seconds = EXTRACT(EPOCH FROM (now() - started_at)),
            meter_seconds = COALESCE(meter_seconds, billed_seconds, duration_seconds, 0) + $2,
            outcome = $3, close_reason = $4, awaiting_since = NULL
      WHERE id = $1 AND status <> 'closed'
      RETURNING ${COLS}`,
    [sessionId, seconds > 0 ? seconds : 0, outcome, reason],
  );
}

// input-required / auth-required: the agent is waiting on a human. The turn keeps
// the compute it already spent, but the row stays open so the wait itself is
// never billed and the conversation can resume.
export async function pauseTurn(sessionId: string, seconds: number, reason: string | null = null): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    `UPDATE sessions
        SET status = 'awaiting_input', awaiting_since = now(), outcome = 'awaiting_input',
            meter_seconds = COALESCE(meter_seconds, billed_seconds, duration_seconds, 0) + $2,
            close_reason = COALESCE($3, close_reason)
      WHERE id = $1 AND status <> 'closed'
      RETURNING ${COLS}`,
    [sessionId, seconds > 0 ? seconds : 0, reason],
  );
}

// A turn of an EXISTING conversation re-arms the row for its own outcome and
// error fields. meter_seconds is NOT reset — it is the conversation's cumulative
// compute, and the sweeper bills the delta against billed_seconds, which is what
// keeps a turn that settles before the next 60s sweep from being discarded.
export async function beginTurn(sessionId: string): Promise<void> {
  await query(
    `UPDATE sessions
        SET status = 'running', turn = turn + 1, metered_at = NULL,
            outcome = NULL, close_reason = NULL, awaiting_since = NULL
      WHERE id = $1`,
    [sessionId],
  );
}

// The A2A contextId is the conversation handle the browser holds, so
// continuation resolves by it rather than by the BFF's own row id.
export async function findSessionByContext(orgId: string, projectId: string, contextId: string): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    `SELECT ${COLS} FROM sessions WHERE org_id = $1 AND project_id = $2 AND kagent_session_id = $3`,
    [orgId, projectId, contextId],
  );
}

// A task id is not tenant-scoped upstream, so the facade resolves which agent
// owns a task through the session row that recorded it — that lookup IS the
// cross-tenant check, and GetTask then confirms the task's own context id.
export async function findSessionByTask(orgId: string, projectId: string, taskId: string): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    `SELECT ${COLS} FROM sessions
      WHERE org_id = $1 AND project_id = $2 AND kagent_task_id = $3
      ORDER BY started_at DESC LIMIT 1`,
    [orgId, projectId, taskId],
  );
}

// The AG-UI client mints its own threadId and never learns the A2A contextId, so
// a resumed conversation arrives identified by the thread handle alone. Project
// scope is the tenant check here, exactly as in the two lookups above.
export async function findSessionByThread(orgId: string, projectId: string, threadId: string): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    `SELECT ${COLS} FROM sessions WHERE org_id = $1 AND project_id = $2 AND thread_id = $3`,
    [orgId, projectId, threadId],
  );
}

export async function listContextIds(orgId: string, projectId: string): Promise<string[]> {
  const res = await query<{ kagent_session_id: string }>(
    `SELECT DISTINCT kagent_session_id FROM sessions
      WHERE org_id = $1 AND project_id = $2 AND kagent_session_id IS NOT NULL`,
    [orgId, projectId],
  );
  return res.rows.map((row) => row.kagent_session_id);
}

// Turns owed an accounting. 'awaiting_input' is included on purpose: a turn that
// paused did real compute before it paused, and that must not vanish. What must
// NOT be billed is the wait itself, which is why this compares the measured
// stream windows against what has already been invoiced and never the wall
// clock. A NULL meter_seconds means the row predates measurement, so the only
// signal that it is still owing is metered_at.
export async function listUnmeteredSettled(): Promise<SessionRow[]> {
  const res = await query<SessionRow>(
    `SELECT ${COLS} FROM sessions
      WHERE status IN ('closed', 'awaiting_input')
        AND ( meter_seconds > COALESCE(billed_seconds, 0)
              OR (meter_seconds IS NULL AND metered_at IS NULL) )
      ORDER BY started_at, turn`,
  );
  return res.rows;
}

// Records WHAT was accounted, not just that something was, so a disputed line on
// a statement can be explained from the row alone. billed_seconds moves up to
// everything measured — a turn the platform broke is written off, not left in
// the sweep forever — while metered_seconds says how much of it was invoiced.
export async function markMetered(sessionId: string, seconds: number, outcome: Outcome): Promise<void> {
  await query(
    `UPDATE sessions
        SET metered_at = now(), metered_seconds = $2, metered_outcome = $3,
            billed_seconds = COALESCE(meter_seconds, COALESCE(billed_seconds, 0) + $2)
      WHERE id = $1`,
    [sessionId, seconds, outcome],
  );
}