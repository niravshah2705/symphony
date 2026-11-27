import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BUNDLE_BASES } from '@fleet-local/shared';
import { requireAuth } from '../auth/plugin.ts';
import { config } from '../config.ts';
import { assertMember, assertOwner } from '../db/users.ts';
import { findOrgById, type OrgRow } from '../db/orgs.ts';
import { listBundleBuilds, listBundleRuns, loadBundleStates } from '../db/bundle.ts';
import { isBundleBuilding, runBundleBuild } from '../bundle/run.ts';
import { ALL_PACKS, packsFor, selectablePackIds } from '../bundle/plugins.ts';
import { runTarget, validateBundleSelection } from '../bundle/steps.ts';

// The owner-facing bundle wizard's endpoints: what may be built, what is built now,
// and a live run of the nine steps.
//
// They are separate from /onboard on purpose. Onboarding is a one-time machine whose
// steps are the tenant's identity; a bundle is a per-runtime build an owner re-runs
// whenever they change a plugin set. Sharing a route would mean a re-run could
// re-enter the onboarding DAG, which is the one thing that must not happen to a
// tenant that is serving traffic.

function sseHeaders(): Record<string, string> {
  return { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
}

function refused(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

export interface BundleGate {
  status: number;
  error: string;
}

/**
 * Every reason a run must not start, decided before the response is hijacked: once
 * an event-stream head is written there is no status code left to refuse with, and a
 * client cannot tell "you are not the owner" from a server that died mid-build.
 */
export function bundleGate(org: Pick<OrgRow, 'status'> | null, sel: { runtime: string; plugins: string[] }): BundleGate | null {
  if (!org) return { status: 404, error: 'organisation not found' };
  if (!config.bundleEnabled) return { status: 409, error: 'bundle builds are disabled (set BUNDLE_ENABLED=true)' };
  if (org.status !== 'active') {
    return { status: 409, error: `this organisation is ${org.status}; a bundle build needs an active tenant` };
  }
  const checked = validateBundleSelection(sel);
  return checked.ok ? null : { status: checked.status, error: checked.error };
}

/** The catalog the wizard renders, derived from the checked-in tables on every call. */
export function bundleCatalog() {
  return {
    enabled: config.bundleEnabled,
    bases: BUNDLE_BASES.map((b) => ({
      runtime: b.runtime,
      label: b.label,
      family: b.family,
      harnessType: b.harnessType,
      dispatchable: b.dispatchable,
      image: `${b.repo}:${b.version}`,
      selectable: selectablePackIds(b),
      packs: Object.fromEntries(packsFor(b).map((v) => [v.pack.id, { availability: v.availability, reason: v.reason }])),
    })),
    packs: ALL_PACKS.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      version: p.version,
      packages: p.requirements.packages,
    })),
  };
}

async function memberOrg(request: FastifyRequest, orgId: string, owner: boolean): Promise<OrgRow> {
  const user = request.fleetUser!;
  await assertMember(orgId, user.id);
  if (owner) await assertOwner(orgId, user.id);
  const org = await findOrgById(orgId);
  if (!org) {
    const err = new Error('organisation not found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  return org;
}

export async function bundleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/orgs/:orgId/bundles', { preHandler: requireAuth }, async (request) => {
    const { orgId } = request.params as { orgId: string };
    const org = await memberOrg(request, orgId, false);
    if (org.status === 'deleted') return { error: 'this organisation is deleted', builds: [], runs: [] };
    return { ...bundleCatalog(), builds: await listBundleBuilds(orgId), runs: await listBundleRuns(orgId) };
  });

  // One run's durable state, for a page load that must show where a build stands
  // without starting anything.
  app.get('/api/orgs/:orgId/bundles/:target', { preHandler: requireAuth }, async (request) => {
    const { orgId, target } = request.params as { orgId: string; target: string };
    await memberOrg(request, orgId, false);
    return { target, running: isBundleBuilding(orgId, target), states: await loadBundleStates(orgId, target) };
  });

  // Build (or resume) one bundle, streamed exactly like onboarding: one event per
  // step transition, then done/error. The body is a selection, not a build id — the
  // target is derived from it, so re-POSTing the same selection resumes it.
  app.post('/api/orgs/:orgId/bundles', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const user = request.fleetUser!;
    const body = (request.body ?? {}) as { runtime?: string; plugins?: string[] };
    const sel = { runtime: String(body.runtime ?? ''), plugins: Array.isArray(body.plugins) ? body.plugins.map(String) : [] };
    const org = await memberOrg(request, orgId, true);

    const gate = bundleGate({ status: org.status }, sel);
    if (gate) return refused(reply, gate.status, gate.error);

    const target = runTarget(sel);
    if (isBundleBuilding(orgId, target)) {
      return refused(reply, 409, `a build for ${target} is already running — watch it instead of starting another`);
    }

    reply.hijack();
    reply.raw.writeHead(200, sseHeaders());
    const send = (event: string, data: unknown) => {
      // The build must outrun the browser. A closed tab is not a reason to stop a
      // Cloud Build job that was already paid for, and the durable state is what lets
      // the owner reopen the page and see where it got to.
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* the client is gone; the build continues */
      }
    };
    try {
      const { states, complete } = await runBundleBuild(
        sel,
        target,
        { orgId, orgSlug: org.slug, orgName: org.name, userId: user.id, userEmail: user.email },
        ({ state }) => send('step', state),
      );
      send('done', { complete, target, states, builds: await listBundleBuilds(orgId) });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
  });
}
