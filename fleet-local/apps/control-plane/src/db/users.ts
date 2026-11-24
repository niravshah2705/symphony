import { one, query } from './client.ts';
import type { OrgStatus } from './orgs.ts';
import type { GoogleIdentity } from '../auth/google.ts';

export interface UserRow {
  id: string;
  email: string;
  google_sub: string | null;
  name: string | null;
}

// Find-or-create by email (the canonical identity across the fleet). The Google
// sub/name are refreshed on every login so a renamed account stays current.
export async function upsertUser(identity: GoogleIdentity): Promise<UserRow> {
  const row = await one<UserRow>(
    `INSERT INTO users (email, google_sub, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET google_sub = EXCLUDED.google_sub,
           name = COALESCE(EXCLUDED.name, users.name)
     RETURNING id, email, google_sub, name`,
    [identity.email, identity.sub, identity.name ?? null],
  );
  if (!row) throw new Error('user upsert returned no row');
  return row;
}

export async function getUser(id: string): Promise<UserRow | undefined> {
  return one<UserRow>('SELECT id, email, google_sub, name FROM users WHERE id = $1', [id]);
}

export interface UserOrg {
  id: string;
  slug: string;
  name: string;
  role: string;
  status: OrgStatus;
}

// A deleted org carries no rows here by construction: the teardown's last step
// removes its membership, which is what makes it invisible to every member
// without any query needing a status filter.
export async function orgsForUser(userId: string): Promise<UserOrg[]> {
  const res = await query<UserOrg>(
    `SELECT o.id, o.slug, o.name, m.role, o.status
       FROM org_members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1
      ORDER BY o.created_at`,
    [userId],
  );
  return res.rows;
}

export async function assertMember(orgId: string, userId: string): Promise<void> {
  const row = await one('SELECT 1 AS ok FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (!row) {
    const err = new Error('not a member of this organisation') as Error & { statusCode?: number };
    err.statusCode = 403;
    throw err;
  }
}

// Lifecycle changes (disable, delete) belong to the owner alone; a member can
// still chat, read costs, and close their own sessions.
export async function assertOwner(orgId: string, userId: string): Promise<void> {
  const row = await one<{ role: string }>(
    'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  if (!row) {
    const err = new Error('not a member of this organisation') as Error & { statusCode?: number };
    err.statusCode = 403;
    throw err;
  }
  if (row.role !== 'owner') {
    const err = new Error('only an organisation owner can do this') as Error & { statusCode?: number };
    err.statusCode = 403;
    throw err;
  }
}

export async function removeMembers(orgId: string): Promise<number> {
  const res = await query('DELETE FROM org_members WHERE org_id = $1', [orgId]);
  return res.rowCount ?? 0;
}