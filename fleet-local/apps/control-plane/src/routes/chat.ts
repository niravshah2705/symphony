import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.ts';
import { config } from '../config.ts';
import { assertMember } from '../db/users.ts';
import { findProjectById } from '../db/projects.ts';
import { getSession, markTerminal } from '../db/sessions.ts';
import { streamChat } from '../kagent/proxy.ts';
import { agentCard } from '../kagent/a2a.ts';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/orgs/:orgId/projects/:projectId/chat', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    const body = (request.body ?? {}) as { text?: string; sessionId?: string; model?: string };
    if (!body.text) return reply.code(400).send({ error: 'text is required' });
    await streamChat(request, reply, { orgId, projectId, text: body.text, sessionId: body.sessionId, model: body.model });
  });

  // P6: the model picker's source of truth (catalog; BFF restarts on FLEET_MODELS).
  app.get('/api/orgs/:orgId/projects/:projectId/models', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    await assertMember(orgId, request.fleetUser!.id);
    const project = await findProjectById(projectId);
    if (!project || project.org_id !== orgId) return reply.code(404).send({ error: 'project not found' });
    return {
      models: config.modelCatalog.map((m) => ({ id: m.id, label: m.label, model: m.model, default: m.default === true })),
    };
  });

  app.get('/api/orgs/:orgId/projects/:projectId/agent-card', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    await assertMember(orgId, request.fleetUser!.id);
    const project = await findProjectById(projectId);
    if (!project || project.org_id !== orgId) return reply.code(404).send({ error: 'project not found' });
    if (!project.agent_name || !project.agent_namespace) return reply.code(409).send({ error: 'onboarding incomplete' });
    return agentCard(project.agent_namespace, project.agent_name);
  });

  app.post('/api/orgs/:orgId/sessions/:sessionId/close', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId, sessionId } = request.params as { orgId: string; sessionId: string };
    await assertMember(orgId, request.fleetUser!.id);
    const session = await getSession(sessionId);
    if (!session || session.org_id !== orgId) return reply.code(404).send({ error: 'session not found' });
    const closed = await markTerminal(sessionId);
    return { session: closed ?? session };
  });
}