import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { assertMember } from '../db/users.ts';
import { findProjectById } from '../db/projects.ts';
import { createSession, getSession, type SessionRow } from '../db/sessions.ts';
import { findOrgById } from '../db/orgs.ts';
import { pumpTurn } from '../a2a/facade.ts';
import { modelAgentName, orgNamespace } from '../onboarding/names.ts';
import { a2aHeaders, makeTraceparent, streamMessage, userMessage } from './a2a.ts';

// The bespoke pre-A2A-facade chat relay, kept alive only until the SPA moves to
// the standard client (PR 3 deletes it). Everything protocol-level — reading the
// frames, classifying how a turn ended, settling the row for metering — now lives
// in a2a/facade.ts and a2a/contract.ts, so the two paths cannot drift apart.

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

async function resolveSession(
  orgId: string,
  projectId: string,
  userId: string,
  agentName: string,
  agentNamespace: string,
  model: string,
  sessionId?: string,
): Promise<SessionRow> {
  if (sessionId) {
    const existing = await getSession(sessionId);
    if (!existing || existing.org_id !== orgId || existing.project_id !== projectId) {
      throw httpError(404, 'session not found');
    }
    return existing;
  }
  return createSession({ orgId, projectId, userId, agentName, agentNamespace, model });
}

export async function streamChat(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { orgId: string; projectId: string; text: string; sessionId?: string; model?: string },
): Promise<void> {
  const user = request.fleetUser;
  if (!user) throw httpError(401, 'unauthenticated');
  await assertMember(input.orgId, user.id);

  const project = await findProjectById(input.projectId);
  if (!project || project.org_id !== input.orgId) throw httpError(404, 'project not found');
  if (!project.agent_name || !project.agent_namespace) throw httpError(409, 'project onboarding incomplete');

  // P6: a NEW session picks its agent from the model catalog (one agent per
  // model, rendered by the tenant release); an EXISTING session stays on the
  // agent it started with — the checkpointed actor belongs to that ModelConfig.
  const catalog = config.modelCatalog;
  const modelId = input.model ?? catalog.find((m) => m.default)?.id ?? catalog[0]?.id;
  if (!modelId) throw httpError(500, 'no models configured (FLEET_MODELS is empty)');
  const entry = catalog.find((m) => m.id === modelId);
  if (!entry) throw httpError(400, `unknown model "${modelId}" — pick one from /models`);
  const org = await findOrgById(input.orgId);
  if (!org) throw httpError(404, 'org not found');
  const agentName = modelAgentName(org.slug, entry.id);

  const session = await resolveSession(
    input.orgId,
    input.projectId,
    user.id,
    agentName,
    orgNamespace(org.slug),
    entry.id,
    input.sessionId,
  );
  const targetAgent = input.sessionId ? session.agent_name : agentName;
  const targetNamespace = input.sessionId ? session.agent_namespace : orgNamespace(org.slug);

  const bearer = request.cookies[config.sessionCookie];
  if (!bearer) throw httpError(401, 'no session token');

  const headers = a2aHeaders(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      userEmail: user.email,
      conversationId: session.kagent_session_id ?? session.id,
    },
    bearer,
    makeTraceparent(),
  );
  const message = userMessage(input.text, session.kagent_session_id ?? undefined);

  const upstream = await streamMessage(targetNamespace, targetAgent, headers, message);
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '');
    throw httpError(502, `kagent stream failed (${upstream.status}): ${body.slice(0, 300)}`);
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Hand the SPA our session id first so it can continue the conversation.
  reply.raw.write(
    `event: session\ndata: ${JSON.stringify({ sessionId: session.id, model: session.model ?? entry.id, agent: targetAgent })}\n\n`,
  );

  let aborted = false;
  request.raw.once('aborted', () => {
    aborted = true;
  });
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) aborted = true;
  });

  try {
    await pumpTurn({
      upstream,
      write: (chunk) => reply.raw.write(chunk),
      session,
      // The legacy SPA has no reasoning UI, so no synthetic artifacts here.
      thoughts: false,
      aborted: () => aborted,
      log: (msg) => request.log.warn(msg),
    });
  } finally {
    reply.raw.end();
  }
  if (aborted) await upstream.body.cancel().catch(() => undefined);
}
