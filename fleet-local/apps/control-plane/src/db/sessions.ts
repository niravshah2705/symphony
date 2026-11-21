import { one, query } from './client.ts';

export interface SessionRow {
  id: string;
  org_id: string;
  project_id: string;
  user_id: string;
  agent_name: string;
  agent_namespace: string;
  kagent_session_id: string | null;
  kagent_task_id: string | null;
  status: string;
  tier: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  metered_at: string | null;
}

const COLS =
  'id, org_id, project_id, user_id, agent_name, agent_namespace, kagent_session_id, kagent_task_id, status, tier, started_at, ended_at, duration_seconds, metered_at';

export async function createSession(input: {
  orgId: string;
  projectId: string;
  userId: string;
  agentName: string;
  agentNamespace: string;
  tier?: string;
}): Promise<SessionRow> {
  const row = await one<SessionRow>(
    `INSERT INTO sessions (org_id, project_id, user_id, agent_name, agent_namespace, tier)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [input.orgId, input.projectId, input.userId, input.agentName, input.agentNamespace, input.tier ?? 'gvisor-default'],
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

// Terminal duration is BFF-recorded (terminal − start); the sweeper meters it.
export async function markTerminal(sessionId: string): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    `UPDATE sessions
        SET status = 'closed', ended_at = now(),
            duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))
      WHERE id = $1 AND status <> 'closed'
      RETURNING ${COLS}`,
    [sessionId],
  );
}

export async function listUnmeteredTerminal(): Promise<SessionRow[]> {
  const res = await query<SessionRow>(
    `SELECT ${COLS} FROM sessions WHERE status = 'closed' AND metered_at IS NULL ORDER BY ended_at`,
  );
  return res.rows;
}

export async function markMetered(sessionId: string): Promise<void> {
  await query('UPDATE sessions SET metered_at = now() WHERE id = $1', [sessionId]);
}