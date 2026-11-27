// The AG-UI leg: the same A2A conversation with kagent, re-spoken as AG-UI run
// events for the browser. Northbound stays A2A (the controller, the task model,
// the metering window); only the browser-facing protocol changes.
//
// Three rules shape this file.
//
// 1. ONE TURN, ONE OWNER. A run is resolved and settled by the facade's
//    openTurn/pumpTurn, so a conversation costs the same and pauses the same way
//    whichever protocol it arrived on. This module only translates at the edge.
// 2. NOTHING MAY FOLLOW THE TERMINAL EVENT. The client's verifier rejects a run
//    that emits anything after RUN_FINISHED/RUN_ERROR, so the terminal event is
//    written last and the encoder refuses to emit twice.
// 3. REFUSE BEFORE THE HEAD, REPORT AFTER IT. An auth or ownership refusal is an
//    ordinary JSON error: no run ever began. Once RUN_STARTED is on the wire a
//    refusal has to become RUN_ERROR, because a client staring at a half-open
//    stream cannot tell "the server said no" from "the network went quiet".

import { EventEncoder } from '@ag-ui/encoder';
import type { Event as AgUiEvent } from '@ag-ui/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { cancelTask, streamMessage, type RpcResult } from '../kagent/a2a.ts';
import { settleTurn, type SessionRow } from '../db/sessions.ts';
import { classifyStreamEnd, type Settlement } from '../a2a/contract.ts';
import { identityHeaders, openTurn, pumpTurn, sseHead, watchAbort, type FacadeContext } from '../a2a/facade.ts';
import type { WireFrame } from '../a2a/translate.ts';
import { createTurnEncoder } from './encode.ts';
import { turnFromRunAgentInput } from './runinput.ts';

// An abandoned resume's CancelTask reply, re-spoken as the one-frame SSE the
// pump would have read from a live stream. Status stays 200 because the frame
// itself carries the verdict: kagent reports "task not found" as a JSON-RPC
// error member, which classifyStreamEnd turns into the run's reason.
function cancelStream(result: RpcResult): Response {
  return new Response(`data: ${JSON.stringify(result.body)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export async function aguiRun(
  ctx: FacadeContext,
  request: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
): Promise<void> {
  const { run, turn } = turnFromRunAgentInput(body);
  const { session, message, agent } = await openTurn(ctx, turn);

  // The thread handle is the client's own, so the events name what it sent; the
  // run id is this turn's, which is what makes the message ids unique per turn.
  const encoder = createTurnEncoder({ threadId: run.threadId, runId: run.runId });
  // SSE only, whatever the client asked for: the run head below declares
  // text/event-stream, and a protobuf client would be told so by a content type
  // it cannot read rather than by a silent downgrade of the bytes.
  const sse = new EventEncoder();
  const write = (events: AgUiEvent[]): void => {
    for (const event of events) reply.raw.write(sse.encodeSSE(event));
  };

  const headers = identityHeaders(ctx, session.kagent_session_id ?? session.id);
  // An abandoned question is a CancelTask, not a turn. The controller's reply to
  // the cancel is replayed as a one-frame stream, so settlement, the session row
  // and the encoder all witness an ordinary task that ended cancelled — rather
  // than a second bespoke closing path.
  const upstream = turn.cancelTaskId
    ? cancelStream(await cancelTask(agent.namespace, agent.agent, headers, turn.cancelTaskId))
    : await streamMessage(agent.namespace, agent.agent, headers, message);

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    const settlement = classifyStreamEnd({ httpStatus: upstream.status, upstreamBody: text });
    await settleRefused(ctx, session, settlement, upstream.status);
    // Refused before a single frame arrived. The run still opens and closes,
    // because the reason only reaches the transcript as an event — a bare 502
    // here is the dead end this protocol was chosen to remove.
    sseHead(reply);
    write(encoder.started());
    write(encoder.fail(settlement.reason ?? 'kagent stream failed', settlement.outcome));
    reply.raw.end();
    return;
  }

  sseHead(reply);
  write(encoder.started());
  const isAborted = watchAbort(request, reply);
  let last: { state?: string; taskId?: string; contextId?: string } = {};
  const onFrame = (frame: WireFrame): void => {
    if (frame.state) last.state = frame.state;
    if (frame.taskId) last.taskId = frame.taskId;
    if (frame.contextId) last.contextId = frame.contextId;
    write(encoder.frame(frame));
  };

  try {
    const settlement = await pumpTurn({
      upstream,
      session,
      thoughts: false,
      onFrame,
      aborted: () => isAborted(),
      // Stop (composer Cancel) aborts the fetch; the task must die with the
      // stream, or kagent keeps running a turn nobody is watching.
      onCancel: (taskId) => cancelTask(agent.namespace, agent.agent, headers, taskId).then(() => undefined),
      log: ctx.log,
    });
    // An abort means the reader is gone: the terminal event would go nowhere, and
    // pumpTurn has already settled the row, so there is nothing left to report.
    if (!isAborted()) write(encoder.end({ settlement, ...last }));
  } finally {
    reply.raw.end();
  }
  if (isAborted()) await upstream.body.cancel().catch(() => undefined);
}

// A turn the platform never started spent no agent compute, so it settles at
// zero — the same call the A2A leg makes, and a failed write is not a lost
// billing: meter_seconds is cumulative, so the next settle picks it up.
async function settleRefused(ctx: FacadeContext, session: SessionRow, settlement: Settlement, status: number): Promise<void> {
  try {
    await settleTurn(session.id, 0, settlement.outcome, settlement.reason);
  } catch (err) {
    ctx.log?.(`failed to settle refused turn: ${err instanceof Error ? err.message : String(err)}`);
  }
  ctx.log?.('agui stream refused', { status, reason: settlement.reason });
}
