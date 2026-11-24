import { one, query } from './client.ts';

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
}

export async function findOrgBySlug(slug: string): Promise<OrgRow | undefined> {
  return one<OrgRow>('SELECT id, slug, name FROM orgs WHERE slug = $1', [slug]);
}

export async function findOrgById(id: string): Promise<OrgRow | undefined> {
  return one<OrgRow>('SELECT id, slug, name FROM orgs WHERE id = $1', [id]);
}

// The DB mints the canonical org UUID (gen_random_uuid); every downstream system
// adopts it verbatim. Find-or-create by slug keeps re-onboarding idempotent.
export async function ensureOrg(slug: string, name: string): Promise<OrgRow> {
  const row = await one<OrgRow>(
    `INSERT INTO orgs (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, slug, name`,
    [slug, name],
  );
  if (!row) throw new Error('org upsert returned no row');
  return row;
}

export async function addMember(orgId: string, userId: string, role = 'owner'): Promise<void> {
  await query(
    `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [orgId, userId, role],
  );
}