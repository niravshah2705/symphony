import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/plugin.ts';
import { assertMember, orgsForUser } from '../db/users.ts';
import { ensureOrg, findOrgById, findOrgBySlug, setOrgStatus, addMember } from '../db/orgs.ts';
import { listProjects } from '../db/projects.ts';
import { listSessions } from '../db/sessions.ts';
import { loadOffboardStates, loadStates } from '../db/onboarding.ts';
import { runOrgOnboarding } from '../onboarding/run.ts';
import { isOffboarding, runOrgOffboarding } from '../offboarding/run.ts';
import { assertRfc1123Slug } from '../onboarding/names.ts';
import { assertOwner, canTransition, type OrgStatus } from '../lifecycle.ts';
import { reconcile } from '../costs/reconcile.ts';
import { defaultWindow } from '../costs/flexprice.ts';
import { langfuse } from '../clients/langfuse.ts';

function sseHeaders(): Record<string, string> {
  return { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
}

async function orgContext(request: FastifyRequest, orgId: string) {
  const user = request.fleetUser!;
  await assertMember(orgId, user.id);
  const org = await findOrgById(orgId);
  if (!org) {
    const err = new Error('organisation not found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  return { user, org };
}

function refused(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/orgs', { preHandler: requireAuth }, async (request) => {
    return { orgs: await orgsForUser(request.fleetUser!.id) };
  });

  app.post('/api/orgs', { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as { slug?: string; name?: string };
    if (!body.slug || !body.name) return refused(reply, 400, 'slug and name are required');
    assertRfc1123Slug(body.slug);
    // ensureOrg upserts by unique slug, so an off org would otherwise hand a brand
    // new owner the dead org's row id — its projects, sessions, snapshot root and
    // possibly its stale atespace policy.
    const existing = await findOrgBySlug(body.slug);
    if (existing && (existing.status === 'offboarding' || existing.status === 'deleted')) {
      return refused(reply, 409, `slug "${body.slug}" is reserved by a removed organisation`);
    }
    const org = await ensureOrg(body.slug, body.name);
    await addMember(org.id, request.fleetUser!.id, 'owner');
    return reply.code(201).send({ org });
  });

  // Disable / re-enable. A pure status write: no infrastructure is touched, which is
  // what makes the way back need no re-onboarding.
  app.patch('/api/orgs/:orgId/status', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const { user, org } = await orgContext(request, orgId);
    await assertOwner(orgId, user.id);
    const body = (request.body ?? {}) as { status?: OrgStatus };
    if (body.status !== 'active' && body.status !== 'disabled') {
      return refused(reply, 400, 'status must be "active" or "disabled"');
    }
    if (!canTransition(org.status, body.status)) {
      return refused(reply, 409, `an organisation that is ${org.status} cannot become ${body.status}`);
    }
    const updated = await setOrgStatus(orgId, [org.status], body.status);
    if (!updated) return refused(reply, 409, 'the organisation changed underneath this request — reload');
    return { org: updated };
  });

  app.get('/api/orgs/:orgId/onboard', { preHandler: requireAuth }, async (request) => {
    const { orgId } = request.params as { orgId: string };
    await orgContext(request, orgId);
    return { states: await loadStates(orgId) };
  });

  // Live onboarding: stream each step transition, then a terminal done/error event.
  app.post('/api/orgs/:orgId/onboard', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const { user, org } = await orgContext(request, orgId);
    if (org.status === 'offboarding') {
      return refused(reply, 409, 'this organisation is being removed; onboarding is closed');
    }
    reply.hijack();
    reply.raw.writeHead(200, sseHeaders());
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const { states, complete } = await runOrgOnboarding(
        { orgId, orgSlug: org.slug, orgName: org.name, userId: user.id, userEmail: user.email },
        ({ state }) => send('step', state),
      );
      send('done', { complete, states });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
  });

  app.get('/api/orgs/:orgId/offboard', { preHandler: requireAuth }, async (request) => {
    const { orgId } = request.params as { orgId: string };
    const { org } = await orgContext(request, orgId);
    return { status: org.status, states: await loadOffboardStates(orgId) };
  });

  // Live offboarding, streamed exactly like onboarding: one event per step
  // transition, then done/error. Durable state makes a re-POST a resume.
  app.post('/api/orgs/:orgId/offboard', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const { user, org } = await orgContext(request, orgId);
    await assertOwner(orgId, user.id);

    // The status flip happens BEFORE the stream head, so a client that connects,
    // receives nothing and dies still leaves an org the agent gate refuses.
    if (org.status === 'active' || org.status === 'disabled') {
      if (!(await setOrgStatus(orgId, [org.status], 'offboarding'))) {
        return refused(reply, 409, 'the organisation changed underneath this request — reload');
      }
    } else if (org.status === 'deleted') {
      return refused(reply, 410, 'this organisation is already deleted');
    } else if (isOffboarding(orgId)) {
      return refused(reply, 409, 'an offboarding run is already in progress for this organisation');
    }

    reply.hijack();
    reply.raw.writeHead(200, sseHeaders());
    const send = (event: string, data: unknown) => {
      // The machine must outrun the browser. A closed tab is not a reason to leave a
      // namespace, a worker pool or a virtual key behind, so a dead socket is dropped
      // silently rather than thrown into the run.
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* the client is gone; the teardown continues */
      }
    };
    try {
      const { states, complete } = await runOrgOffboarding(
        { orgId, orgSlug: org.slug, orgName: org.name, userId: user.id, userEmail: user.email },
        ({ state }) => send('step', state),
      );
      // An incomplete run leaves the org in offboarding: still gated, still visible
      // to its owner, and the next POST resumes at the first step that did not finish.
      send('done', { complete, states });
    } catch (err) {
      send('error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
  });

  app.get('/api/orgs/:orgId/projects', { preHandler: requireAuth }, async (request) => {
    const { orgId } = request.params as { orgId: string };
    await orgContext(request, orgId);
    return { projects: await listProjects(orgId) };
  });

  app.get('/api/orgs/:orgId/sessions', { preHandler: requireAuth }, async (request) => {
    const { orgId } = request.params as { orgId: string };
    await orgContext(request, orgId);
    const { projectId } = request.query as { projectId?: string };
    return { sessions: await listSessions(orgId, projectId) };
  });

  app.get('/api/orgs/:orgId/costs', { preHandler: requireAuth }, async (request) => {
    const { orgId } = request.params as { orgId: string };
    await orgContext(request, orgId);
    const { days } = request.query as { days?: string };
    const window = defaultWindow(days ? Number(days) : 30);
    const projects = await listProjects(orgId);
    const states = await loadStates(orgId);
    const walletId = states.flexprice?.result?.walletId as string | undefined;
    return reconcile(orgId, projects.map((p) => p.id), { window, walletId });
  });

  app.get('/api/orgs/:orgId/traces', { preHandler: requireAuth }, async (request) => {
    const { orgId } = request.params as { orgId: string };
    const { user } = await orgContext(request, orgId);
    const { sessionId } = request.query as { sessionId?: string };
    const res = await langfuse.traces({ sessionId, userId: user.email });
    return { traces: res.data ?? [] };
  });
}