// The BFF as an A2A server: a facade over the kagent controller. Any standard
// A2A client (REST bindings) speaks it — the live gate drives it with
// @assistant-ui/react-a2a, and the browser through src/agui, which re-spokes THIS
// facade's turn as AG-UI run events — so nothing about a conversation is a
// private protocol.
//
// Two rules shape everything below.
//
// 1. FORWARD, DON'T RESHAPE. The controller's frames are already valid A2A and
//    the client parses them; we only *read* them (translate.inspectFrame) to keep
//    our own books. The one frame we invent is the reasoning artifact, because
//    part metadata is dropped by the client and an artifact is the only channel
//    that survives with identity.
// 2. EVERY CONVERSATION HANDLE IS OURS. contextId and taskId are resolved
//    against sessions of THIS (org, project) before anything is dialed upstream:
//    task ids are not tenant-scoped at the controller, so this lookup is the
//    cross-tenant check, not a nicety.

import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ModelCatalogEntry } from '@fleet-local/shared';
import { config } from '../config.ts';
import { findOrgById } from '../db/orgs.ts';
import { findProjectById } from '../db/projects.ts';
import {
  beginTurn,
  createSession,
  findSessionByContext,
  findSessionByTask,
  findSessionByThread,
  listContextIds,
  pauseTurn,
  setKagentIds,
  settleTurn,
  type SessionRow,
} from '../db/sessions.ts';
import { modelAgentName, orgNamespace } from '../onboarding/names.ts';
import {
  a2aHeaders,
  agentCard,
  cancelTask,
  makeTraceparent,
  rpcEnvelope,
  streamMessage,
  subscribeTask,
  userMessage,
  type A2AMessage,
  type RpcResult,
} from '../kagent/a2a.ts';
import {
  A2ARequestError,
  assertTaskOwnership,
  classifyStreamEnd,
  truncate,
  type Settlement,
} from './contract.ts';
import {
  buildThoughtArtifact,
  inspectFrame,
  rewriteAgentCard,
  turnFromRestBody,
  type RestTurn,
  type WireFrame,
} from './translate.ts';

export interface FacadeContext {
  orgId: string;
  projectId: string;
  userId: string;
  email: string;
  /** The BFF's own session token, minted at the edge — never the browser's. */
  bearer: string;
  /** Absolute base of this project's facade, used to rewrite the agent card. */
  facadeBase: string;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface ProjectAgent {
  namespace: string;
  agent: string;
}

function upstreamError(message: string): A2ARequestError {
  return new A2ARequestError(502, truncate(message), { reason: 'upstream_unavailable' });
}

// The agent a project's NEW conversation dials is <org>-agent-<model>-worker for
// the catalog's default model (P6 renders one agent per model), so the card must
// describe THAT agent — advertising the legacy single `worker` would tell the
// client about skills the chat it starts cannot exercise. taskOwner() overrides
// this per task with the agent its session row actually ran, which is what keeps
// a conversation on the ModelConfig whose checkpoint it owns.
async function projectAgent(ctx: FacadeContext): Promise<ProjectAgent> {
  const project = await findProjectById(ctx.projectId);
  if (!project || project.org_id !== ctx.orgId) throw new A2ARequestError(404, 'project not found');
  const org = await findOrgById(ctx.orgId);
  if (!org) throw new A2ARequestError(404, 'org not found');
  if (!project.agent_name || !project.agent_namespace) {
    throw new A2ARequestError(409, 'project onboarding incomplete', { reason: 'onboarding_incomplete' });
  }
  return { namespace: orgNamespace(org.slug), agent: modelAgentName(org.slug, defaultEntry().id) };
}

function defaultEntry(catalog: readonly ModelCatalogEntry[] = config.modelCatalog): ModelCatalogEntry {
  const entry = catalog.find((m) => m.default === true) ?? catalog[0];
  if (!entry) throw new A2ARequestError(500, 'no models configured (FLEET_MODELS is empty)');
  return entry;
}

export function identityHeaders(ctx: FacadeContext, conversationId?: string): Record<string, string> {
  return a2aHeaders(
    { orgId: ctx.orgId, projectId: ctx.projectId, userEmail: ctx.email, conversationId },
    ctx.bearer,
    makeTraceparent(),
  );
}

// The agent card is the client's discovery step, and the controller's card
// advertises the in-cluster URL. Only the addresses are rewritten.
export async function facadeAgentCard(ctx: FacadeContext): Promise<Record<string, unknown>> {
  const { namespace, agent } = await projectAgent(ctx);
  let card: unknown;
  try {
    card = await agentCard(namespace, agent, identityHeaders(ctx));
  } catch (err) {
    throw upstreamError(`agent card unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return rewriteAgentCard(card, ctx.facadeBase) as Record<string, unknown>;
}

// Resolve (or start) the conversation a client turn belongs to.
export async function openTurn(ctx: FacadeContext, turn: RestTurn): Promise<{ session: SessionRow; message: A2AMessage; agent: ProjectAgent }> {
  if (turn.pushConfigRequested) {
    throw new A2ARequestError(501, 'this agent does not deliver updates by webhook — stream the response instead', {
      reason: 'push_notifications_unsupported',
    });
  }
  const project = await findProjectById(ctx.projectId);
  if (!project || project.org_id !== ctx.orgId) throw new A2ARequestError(404, 'project not found');
  const org = await findOrgById(ctx.orgId);
  if (!org) throw new A2ARequestError(404, 'org not found');
  const catalog = config.modelCatalog;

  // The model rides on message.metadata (the A2A Message has no other field for
  // it) and nothing else: there is no header fallback, so a choice cannot arrive
  // by two paths and disagree with itself.
  const requested = turn.modelId;
  let entry: ModelCatalogEntry | undefined;
  if (requested) {
    entry = catalog.find((m) => m.id === requested);
    if (!entry) throw new A2ARequestError(400, `unknown model "${requested}" — pick one from /models`, { reason: 'unknown_model' });
  } else {
    entry = defaultEntry(catalog);
  }

  // A resume carries the task id, which is the tighter handle of the two; fall
  // back to the conversation id for a fresh turn in an existing conversation.
  const found =
    (turn.message.taskId ? await findSessionByTask(ctx.orgId, ctx.projectId, turn.message.taskId) : undefined) ??
    (turn.message.contextId ? await findSessionByContext(ctx.orgId, ctx.projectId, turn.message.contextId) : undefined) ??
    (turn.threadId ? await findSessionByThread(ctx.orgId, ctx.projectId, turn.threadId) : undefined);

  if (found && turn.message.contextId && found.kagent_session_id && found.kagent_session_id !== turn.message.contextId) {
    throw new A2ARequestError(409, 'the task and the conversation id do not belong to the same conversation', {
      reason: 'context_task_mismatch',
    });
  }
  // Not found is not a new conversation: every conversation this facade knows was
  // created here, so an id we have no row for belongs to someone else (or to a
  // database that no longer exists). Starting it silently is how one project ends
  // up appending to another's context on a shared org-level agent. A thread
  // handle is exempt: the AG-UI client mints it, so an unknown one genuinely is a
  // new conversation, and the (org, project) scope of the lookups above is what
  // keeps it from reaching anyone else's row.
  if (!found && (turn.message.contextId || turn.message.taskId)) {
    throw new A2ARequestError(404, 'unknown conversation — start a new one without a context id', { reason: 'unknown_conversation' });
  }

  // P6: a NEW conversation picks its agent from the model; an EXISTING one stays
  // on the agent it started with, because that checkpointed actor belongs to that
  // ModelConfig.
  const agent: ProjectAgent = found
    ? { namespace: found.agent_namespace, agent: found.agent_name }
    : { namespace: orgNamespace(org.slug), agent: modelAgentName(org.slug, entry.id) };

  const session =
    found ??
    (await createSession({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      userId: ctx.userId,
      agentName: agent.agent,
      agentNamespace: agent.namespace,
      model: entry.id,
      threadId: turn.threadId,
    }));

  // Re-arm a settled or paused row so this turn is billable on its own merits.
  if (session.status !== 'running') await beginTurn(session.id);

  // A turn that paused on a human left its task resumable, and the AG-UI client
  // has no task id to send back: it knows only its thread. Naming the paused task
  // here is what makes the next message RESUME it instead of starting a second
  // task whose answer the first one never sees.
  const taskId = turn.message.taskId ?? (found?.status === 'awaiting_input' ? found.kagent_task_id ?? undefined : undefined);

  // Parts pass through as given: text is the turn's words, file is an inline
  // attachment (runinput.ts has already checked its type and size). A fresh
  // text-only turn lands on exactly the wire shape used before attachments.
  const message = userMessage(turn.message.parts, session.kagent_session_id ?? turn.message.contextId, taskId);
  if (turn.message.metadata) message.metadata = turn.message.metadata;
  if (turn.message.extensions) message.extensions = turn.message.extensions;
  return { session, message, agent };
}

export interface Pump {
  upstream: Response;
  /**
   * Relay a frame's bytes verbatim. Absent on the AG-UI leg, which re-emits the
   * turn as AG-UI events through `onFrame` instead of forwarding kagent's wire.
   */
  write?: (chunk: string) => void;
  session: SessionRow;
  /** Inject the synthetic reasoning artifact (only for the browser-facing facade). */
  thoughts: boolean;
  /** Called for every frame the pump could parse, before anything is relayed. */
  onFrame?: (frame: WireFrame) => void;
  aborted?: () => boolean;
  /**
   * Cleanup when the browser went away while the task was still live: the pump
   * owns the task handle, so this is where a disconnect becomes a CancelTask.
   * Without it kagent keeps burning compute replying to a reader that is gone.
   * A throw is logged, not surfaced — the run is already over for the client.
   */
  onCancel?: (taskId: string) => Promise<void>;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

// Read the controller's SSE stream, relay it verbatim, and settle the session row
// when it ends. The metered amount is how long THIS stream was open: agent
// compute happens while we are reading, and a pause on input-required closes the
// stream, so everything after that is the human's time and is never measured.
export async function pumpTurn(pump: Pump): Promise<Settlement> {
  const startedAt = Date.now();
  const { session } = pump;
  let contextId: string | undefined = session.kagent_session_id ?? undefined;
  let taskId: string | undefined = session.kagent_task_id ?? undefined;
  let bound = Boolean(session.kagent_session_id);
  let state: string | undefined;
  let failureMessage: string | undefined;
  let rpcError: string | undefined;
  let framesSeen = 0;
  let answered = false;
  let thoughtOpen = false;
  let readError: string | undefined;

  const observe = (data: string): void => {
    const frame = inspectFrame(data);
    if (!frame) return;
    framesSeen += 1;
    if (frame.contextId) contextId = frame.contextId;
    if (frame.taskId) taskId = frame.taskId;
    if (!bound && contextId) {
      bound = true;
      void setKagentIds(session.id, contextId, taskId).catch((err: Error) =>
        pump.log?.(`failed to bind context: ${err.message}`),
      );
    }
    if (frame.state) state = frame.state;
    if (frame.producesOutput) answered = true;
    if (frame.statusMessage) failureMessage = frame.statusMessage;
    if (frame.rpcError) rpcError = truncate(String(frame.rpcError.message ?? 'the agent returned an error'));
    pump.onFrame?.(frame);
    if (pump.thoughts && frame.thought && pump.write) {
      const artifact = buildThoughtArtifact({ text: frame.thought, taskId, contextId, append: thoughtOpen });
      if (artifact) {
        thoughtOpen = true;
        pump.write(`${artifact}\n\n`);
      }
    }
  };

  let buffer = '';
  try {
    for await (const chunk of Readable.fromWeb(pump.upstream.body as never)) {
      const text = (chunk as Buffer).toString('utf8');
      pump.write?.(text);
      // Only the unparsed tail is carried, so re-normalising it each round is
      // cheap and survives a CRLF pair split across chunks.
      buffer = `${buffer}${text}`.replace(/\r\n/g, '\n').replace(/^\n+/, '');
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data) observe(data);
      }
      if (pump.aborted?.()) break;
    }
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err);
  }

  const aborted = Boolean(pump.aborted?.());
  const settlement = classifyStreamEnd({
    state,
    failureMessage,
    aborted,
    readError: aborted ? undefined : readError,
    rpcError,
    framesSeen,
    answered,
  });
  // The browser left and the task never reached a terminal state: kagent would
  // otherwise keep streaming into nothing. A cancel the controller refuses (the
  // task settled in the race) is not this turn's problem — log and move on.
  if (settlement.outcome === 'client_abort' && taskId && pump.onCancel) {
    await pump.onCancel(taskId).catch((err: Error) => pump.log?.(`failed to cancel aborted task: ${err.message}`));
  }
  const seconds = (Date.now() - startedAt) / 1000;
  // A failed settle leaves the row 'running', which is not a lost billing:
  // meter_seconds is cumulative, so the next turn's settle bills this compute
  // too. Swallowing the write error therefore keeps the stream intact.
  try {
    if (settlement.outcome === 'awaiting_input') await pauseTurn(session.id, seconds, settlement.reason);
    else await settleTurn(session.id, seconds, settlement.outcome, settlement.reason);
  } catch (err) {
    pump.log?.(`failed to settle turn: ${err instanceof Error ? err.message : String(err)}`);
  }
  pump.log?.('a2a turn settled', { outcome: settlement.outcome, seconds, frames: framesSeen, task: taskId });
  return settlement;
}

export function sseHead(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

export function watchAbort(request: FastifyRequest, reply: FastifyReply): () => boolean {
  let aborted = false;
  request.raw.once('aborted', () => {
    aborted = true;
  });
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) aborted = true;
  });
  return () => aborted;
}

// POST …/message:stream — the chat path.
export async function facadeStream(
  ctx: FacadeContext,
  request: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
): Promise<void> {
  const { session, message, agent } = await openTurn(ctx, turnFromRestBody(body));
  const upstream = await streamMessage(agent.namespace, agent.agent, identityHeaders(ctx, session.kagent_session_id ?? session.id), message);
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    const settlement = classifyStreamEnd({ httpStatus: upstream.status, upstreamBody: text });
    await settleTurn(session.id, 0, settlement.outcome, settlement.reason);
    ctx.log?.('a2a stream refused', { status: upstream.status, reason: settlement.reason });
    throw new A2ARequestError(502, truncate(settlement.reason ?? 'kagent stream failed'), {
      reason: 'upstream_stream_failed',
      metadata: { http_status: String(upstream.status) },
    });
  }

  sseHead(reply);
  const aborted = watchAbort(request, reply);
  const headers = identityHeaders(ctx, session.kagent_session_id ?? session.id);
  try {
    await pumpTurn({
      upstream,
      write: (chunk) => reply.raw.write(chunk),
      session,
      thoughts: true,
      aborted: () => aborted(),
      onCancel: (taskId) => cancelTask(session.agent_namespace, session.agent_name, headers, taskId).then(() => undefined),
      log: ctx.log,
    });
  } finally {
    reply.raw.end();
  }
  if (aborted()) await upstream.body.cancel().catch(() => undefined);
}

// POST …/message:send — the blocking variant. Rare for a chat, but a standard
// A2A client must get a real Task back, and the turn still has to settle.
export async function facadeSend(ctx: FacadeContext, body: unknown): Promise<RpcResult> {
  const { session, message, agent } = await openTurn(ctx, turnFromRestBody(body));
  const startedAt = Date.now();
  const rpc = await rpcEnvelope(agent.namespace, agent.agent, identityHeaders(ctx, session.kagent_session_id ?? session.id), 'SendMessage', { message }, 120_000);
  const frame = inspectFrame(JSON.stringify(rpc.body));
  const settlement = classifyStreamEnd({
    state: frame?.state,
    failureMessage: frame?.statusMessage,
    rpcError: frame?.rpcError ? truncate(String(frame.rpcError.message ?? 'the agent returned an error')) : undefined,
    httpStatus: rpc.status >= 400 ? rpc.status : undefined,
    upstreamBody: rpc.status >= 400 ? JSON.stringify(rpc.body) : undefined,
    framesSeen: 1,
    answered: frame?.producesOutput === true,
  });
  const seconds = (Date.now() - startedAt) / 1000;
  if (settlement.outcome === 'awaiting_input') await pauseTurn(session.id, seconds, settlement.reason);
  else await settleTurn(session.id, seconds, settlement.outcome, settlement.reason);
  ctx.log?.('a2a send settled', { outcome: settlement.outcome, seconds, status: rpc.status });
  return rpc;
}

// The task-level calls all resolve the owning session first: that lookup IS the
// tenant check, and it is also how the facade knows which agent to dial.
async function taskOwner(ctx: FacadeContext, taskId: string): Promise<SessionRow> {
  const session = await findSessionByTask(ctx.orgId, ctx.projectId, taskId);
  if (!session) throw new A2ARequestError(404, 'task not found', { reason: 'task_not_found' });
  return session;
}

export async function facadeGetTask(ctx: FacadeContext, taskId: string): Promise<RpcResult> {
  const session = await taskOwner(ctx, taskId);
  const rpc = await rpcEnvelope(session.agent_namespace, session.agent_name, identityHeaders(ctx, session.kagent_session_id ?? session.id), 'GetTask', { id: taskId });
  const result = (rpc.body as { result?: { id?: string; contextId?: string } })?.result;
  const problem = assertTaskOwnership(result, await listContextIds(ctx.orgId, ctx.projectId));
  if (problem) {
    ctx.log?.('a2a gettask ownership refused', { taskId, problem });
    throw new A2ARequestError(404, 'task not found', { reason: 'task_not_found' });
  }
  return rpc;
}

export async function facadeCancel(ctx: FacadeContext, taskId: string): Promise<RpcResult> {
  const session = await taskOwner(ctx, taskId);
  const rpc = await cancelTask(session.agent_namespace, session.agent_name, identityHeaders(ctx, session.kagent_session_id ?? session.id), taskId);
  const frame = inspectFrame(JSON.stringify(rpc.body));
  const settlement = classifyStreamEnd({
    state: frame?.state,
    httpStatus: rpc.status >= 400 ? rpc.status : undefined,
    upstreamBody: rpc.status >= 400 ? JSON.stringify(rpc.body) : undefined,
    rpcError: frame?.rpcError ? truncate(String(frame.rpcError.message ?? 'cancel failed')) : undefined,
    framesSeen: 1,
  });
  // Cancelled work already happened, so it bills; a cancel the controller refused
  // does not settle the row, because the task is still running.
  if (settlement.outcome === 'cancelled') await settleTurn(session.id, 0, 'cancelled', settlement.reason);
  else if (settlement.outcome !== 'completed') ctx.log?.('a2a cancel not settled', { taskId, outcome: settlement.outcome, reason: settlement.reason });
  return rpc;
}

// SubscribeToTask is a real method on this controller (verified live), so it is
// relayed rather than answered 501. A late subscriber must not double-meter, so
// this pump does not settle: it only binds identity for the row it re-attaches to.
export async function facadeSubscribe(ctx: FacadeContext, taskId: string, reply: FastifyReply): Promise<void> {
  const session = await taskOwner(ctx, taskId);
  const upstream = await subscribeTask(session.agent_namespace, session.agent_name, identityHeaders(ctx, session.kagent_session_id ?? session.id), taskId);
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    throw new A2ARequestError(502, truncate(`kagent subscribe failed (${upstream.status}): ${text}`), { reason: 'upstream_unavailable' });
  }
  sseHead(reply);
  const write = (chunk: string): void => {
    reply.raw.write(chunk);
  };
  try {
    for await (const chunk of Readable.fromWeb(upstream.body as never)) {
      write((chunk as Buffer).toString('utf8'));
    }
  } finally {
    reply.raw.end();
  }
}
