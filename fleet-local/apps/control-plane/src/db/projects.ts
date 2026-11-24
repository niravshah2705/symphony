import { one, query } from './client.ts';

export interface ProjectRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  agent_name: string | null;
  agent_namespace: string | null;
}

const COLS = 'id, org_id, slug, name, agent_name, agent_namespace';

export async function findProject(orgId: string, slug: string): Promise<ProjectRow | undefined> {
  return one<ProjectRow>(`SELECT ${COLS} FROM projects WHERE org_id = $1 AND slug = $2`, [orgId, slug]);
}

export async function findProjectById(id: string): Promise<ProjectRow | undefined> {
  return one<ProjectRow>(`SELECT ${COLS} FROM projects WHERE id = $1`, [id]);
}

// The DB mints the canonical project UUID; LiteLLM team_id adopts it verbatim.
export async function ensureProject(orgId: string, slug: string, name: string): Promise<ProjectRow> {
  const row = await one<ProjectRow>(
    `INSERT INTO projects (org_id, slug, name) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING ${COLS}`,
    [orgId, slug, name],
  );
  if (!row) throw new Error('project upsert returned no row');
  return row;
}

export async function listProjects(orgId: string): Promise<ProjectRow[]> {
  const res = await query<ProjectRow>(`SELECT ${COLS} FROM projects WHERE org_id = $1 ORDER BY created_at`, [orgId]);
  return res.rows;
}

export async function attachAgent(projectId: string, agentName: string, agentNamespace: string): Promise<void> {
  await query('UPDATE projects SET agent_name = $2, agent_namespace = $3 WHERE id = $1', [
    projectId,
    agentName,
    agentNamespace,
  ]);
}

// The inverse of attach, and the inverse of a delete that cannot be left to
// ON DELETE CASCADE: the project row is history, but a stale agent_name is a
// pointer into a namespace that no longer exists, which the facade would dial.
export async function detachAgents(orgId: string): Promise<number> {
  const res = await query(
    'UPDATE projects SET agent_name = NULL, agent_namespace = NULL WHERE org_id = $1',
    [orgId],
  );
  return res.rowCount ?? 0;
}