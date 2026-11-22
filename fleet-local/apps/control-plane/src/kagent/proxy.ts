import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { assertMember } from '../db/users.ts';
import { findProjectById } from '../db/projects.ts';
import { createSession, getSession, markTerminal, setKagentIds, type SessionRow } from '../db/sessions.ts';
import { findOrgById } from '../db/orgs.ts';
import { modelAgentName, orgNamespace } from '../onboarding/names.ts';
import { a2aHeaders, makeTraceparent, streamMessage, userMessage } from './a2a.ts';

const TERMINAL = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELLED',
  'TASK_STATE_REJECTED',
]);

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

// Resolve (or create) the BFF session row that owns this chat turn. The SPA tracks
// the BFF session id; the kagent contextId is stored on it for continuation.
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

interface ParsedEvent {
  contextId?: string;
  taskId?: string;
  state?: string;
}

// Pull identity/state out of one A2A SSE data payload (task / statusUpdate /
// artifactUpdate variants all carry contextId; terminal state lives on status).
function parseEvent(data: string): ParsedEvent | undefined {
  let env: { result?: Record<string, unknown> };
  try {
    env = JSON.parse(data);
  } catch {
    return undefined;
  }
  const result = env.result;
  if (!result) return undefined;
  const task = result.task as { id?: string; contextId?: string; status?: { state?: string } } | undefined;
  const statusUpdate = result.statusUpdate as { taskId?: string; contextId?: string; status?: { state?: string } } | undefined;
  const artifactUpdate = result.artifactUpdate as { taskId?: string; contextId?: string } | undefined;
  const node = task ?? statusUpdate ?? artifactUpdate;
  if (!node) return undefined;
  return {
    contextId: node.contextId,
    taskId: task?.id ?? statusUpdate?.taskId ?? artifactUpdate?.taskId,
    state: task?.status?.state ?? statusUpdate?.status?.state,
  };
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
  const modelId = input.model ?? catalog.find((m) => m.default)?.id ?? catalog[0]!.id;
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

  let buffer = '';
  let identified = false;
  const handleEvent = (parsed: ParsedEvent) => {
    if (!identified && parsed.contextId) {
      identified = true;
      void setKagentIds(session.id, parsed.contextId, parsed.taskId);
    }
    if (parsed.state && TERMINAL.has(parsed.state)) {
      void markTerminal(session.id);
    }
  };

  try {
    for await (const chunk of Readable.fromWeb(upstream.body as never)) {
      const text = (chunk as Buffer).toString('utf8');
      reply.raw.write(chunk);
      buffer += text;
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (dataLine) {
          const parsed = parseEvent(dataLine);
          if (parsed) handleEvent(parsed);
        }
      }
    }
  } catch {
    // Client disconnect or upstream drop: close out the turn so it can be metered.
    void markTerminal(session.id);
  } finally {
    reply.raw.end();
  }
}