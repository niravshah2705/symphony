import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.ts';
import { config } from '../config.ts';
import { assertMember } from '../db/users.ts';
import { findProjectById } from '../db/projects.ts';
import { getSession, settleTurn } from '../db/sessions.ts';
import { a2aHeaders, agentCard, makeTraceparent } from '../kagent/a2a.ts';
import type { ModelCatalogEntry } from '@fleet-local/shared';

// The picker's rows. An experimental entry is rendered in the tenant but not
// offered: selecting it would fail the turn instead of degrading the others, and
// the runtime is deliberately never sent to the browser.
export function chatModels(catalog: readonly ModelCatalogEntry[]) {
  return catalog
    .filter((m) => !m.experimental)
    .map((m) => ({ id: m.id, label: m.label, model: m.model, default: m.default === true }));
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // P6: the model picker's source of truth (catalog; BFF restarts on FLEET_MODELS).
  app.get('/api/orgs/:orgId/projects/:projectId/models', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    await assertMember(orgId, request.fleetUser!.id);
    const project = await findProjectById(projectId);
    if (!project || project.org_id !== orgId) return reply.code(404).send({ error: 'project not found' });
    return { models: chatModels(config.modelCatalog) };
  });

  app.get('/api/orgs/:orgId/projects/:projectId/agent-card', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    await assertMember(orgId, request.fleetUser!.id);
    const project = await findProjectById(projectId);
    if (!project || project.org_id !== orgId) return reply.code(404).send({ error: 'project not found' });
    if (!project.agent_name || !project.agent_namespace) return reply.code(409).send({ error: 'onboarding incomplete' });
    const bearer = request.cookies[config.sessionCookie];
    if (!bearer) return reply.code(401).send({ error: 'no session token' });
    return agentCard(
      project.agent_namespace,
      project.agent_name,
      a2aHeaders({ orgId, projectId, userEmail: request.fleetUser!.email }, bearer, makeTraceparent()),
    );
  });

  app.post('/api/orgs/:orgId/sessions/:sessionId/close', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId, sessionId } = request.params as { orgId: string; sessionId: string };
    await assertMember(orgId, request.fleetUser!.id);
    const session = await getSession(sessionId);
    if (!session || session.org_id !== orgId) return reply.code(404).send({ error: 'session not found' });
    // An explicit close is a user cancelling the conversation, so it settles as
    // 'cancelled' with no new measurement: whatever the stream already recorded
    // is what gets billed, and the guard in settleTurn keeps an already-closed
    // row (or a turn still streaming) from being rewritten.
    const closed = await settleTurn(sessionId, 0, 'cancelled', 'closed from the sessions list');
    return { session: closed ?? session };
  });
}