import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/plugin.ts';
import { assertMember, orgsForUser } from '../db/users.ts';
import { ensureOrg, findOrgById, addMember } from '../db/orgs.ts';
import { listProjects } from '../db/projects.ts';
import { listSessions } from '../db/sessions.ts';
import { loadStates } from '../db/onboarding.ts';
import { runOrgOnboarding } from '../onboarding/run.ts';
import { assertRfc1123Slug } from '../onboarding/names.ts';
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

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/orgs', { preHandler: requireAuth }, async (request) => {
    return { orgs: await orgsForUser(request.fleetUser!.id) };
  });

  app.post('/api/orgs', { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body ?? {}) as { slug?: string; name?: string };
    if (!body.slug || !body.name) return reply.code(400).send({ error: 'slug and name are required' });
    assertRfc1123Slug(body.slug);
    const org = await ensureOrg(body.slug, body.name);
    await addMember(org.id, request.fleetUser!.id, 'owner');
    return reply.code(201).send({ org });
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