import { one, query } from './client.ts';

export type OrgStatus = 'active' | 'disabled' | 'offboarding' | 'deleted';

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
}

const COLS = 'id, slug, name, status';

export async function findOrgBySlug(slug: string): Promise<OrgRow | undefined> {
  return one<OrgRow>(`SELECT ${COLS} FROM orgs WHERE slug = $1`, [slug]);
}

export async function findOrgById(id: string): Promise<OrgRow | undefined> {
  return one<OrgRow>(`SELECT ${COLS} FROM orgs WHERE id = $1`, [id]);
}

// The single-column read the agent-call gate needs on every turn: cheaper than a
// full row, and it keeps the gate from depending on what OrgRow carries.
export async function orgStatus(id: string): Promise<OrgStatus | undefined> {
  return one<{ status: OrgStatus }>('SELECT status FROM orgs WHERE id = $1', [id])
    .then((row) => row?.status);
}

// The DB mints the canonical org UUID (gen_random_uuid); every downstream system
// adopts it verbatim. Find-or-create by slug keeps re-onboarding idempotent.
// name only is updated on conflict: a re-run must never reset a lifecycle status.
export async function ensureOrg(slug: string, name: string): Promise<OrgRow> {
  const row = await one<OrgRow>(
    `INSERT INTO orgs (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING ${COLS}`,
    [slug, name],
  );
  if (!row) throw new Error('org upsert returned no row');
  return row;
}

// A guarded transition: the WHERE clause is the concurrency check, so 0 rows means
// someone else moved the org (or the transition was illegal) and the caller must
// not assume its write landed.
export async function setOrgStatus(
  id: string,
  from: readonly OrgStatus[],
  to: OrgStatus,
): Promise<OrgRow | undefined> {
  return one<OrgRow>(
    `UPDATE orgs SET status = $3, status_updated_at = now()
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING ${COLS}`,
    [id, from, to],
  );
}

export async function addMember(orgId: string, userId: string, role = 'owner'): Promise<void> {
  await query(
    `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [orgId, userId, role],
  );
}
