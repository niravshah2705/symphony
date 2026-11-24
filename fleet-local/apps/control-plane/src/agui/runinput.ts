// RunAgentInput in, the facade's internal turn out. This is the only place the
// AG-UI request body is read, and it produces the SAME `RestTurn` the A2A leg
// produces — so conversation resolution, model selection, ownership and metering
// stay in `openTurn`, and the two legs cannot drift into two different ideas of
// what a turn is.
//
// What the browser's client actually sends (verified against
// `@assistant-ui/react-ag-ui`'s buildRunInput): a threadId it minted itself, a
// runId fresh for every run, and the whole transcript. It never learns the A2A
// contextId, and kagent owns the history — so we read the thread handle, take the
// LAST user message as this turn's input, and forward nothing else.

import { randomUUID } from 'node:crypto';
import { contentHasMedia, contentToText } from '@ag-ui/core';
import { AGUI_MODEL_PROP } from '@fleet-local/shared';
import type { RestTurn } from '../a2a/translate.ts';
import { A2ARequestError } from '../a2a/contract.ts';

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// AG-UI lets the client answer an interrupt or abandon it. Abandoning maps to
// cancelling the A2A task, which is PR 4's HITL work; until then it is refused
// rather than silently re-running the turn as if it had been answered.
const RESUME_CANCELLED = 'resume_cancel_unsupported';
// A structured answer needs the tool-approval response part (again PR 4). Text
// is what the agent can act on today, so anything else is refused out loud.
const RESUME_PAYLOAD_UNSUPPORTED = 'resume_payload_unsupported';
const NON_TEXT_CONTENT = 'multimodal_content_unsupported';

export interface ParsedRun {
  /** Echoed on every run event, so the client matches them to this run. */
  threadId: string;
  runId: string;
}

function parseRunHeader(body: Obj): ParsedRun {
  const threadId = str(body.threadId);
  const runId = str(body.runId);
  // threadId is the conversation, so it must be unique per chat: the BFF cannot
  // tell a new conversation from a resumed one out of a transcript that always
  // contains both. `@assistant-ui/react-ag-ui` falls back to the literal "main"
  // when the agent has no thread id, which would merge every chat in a project
  // into one session — so the SPA mints one per conversation (see useFleetAgUi).
  if (!threadId) throw new A2ARequestError(400, 'threadId is required', { reason: 'missing_thread_id' });
  if (!runId) throw new A2ARequestError(400, 'runId is required', { reason: 'missing_run_id' });
  return { threadId, runId };
}

// The model travels on forwardedProps, which is where the SPA puts the choice it
// renders from /models. Nothing else carries it: a client that sends no prop gets
// the catalog default.
function modelIdOf(body: Obj): string | undefined {
  const props = body.forwardedProps;
  if (!isObj(props)) return undefined;
  return str(props[AGUI_MODEL_PROP]);
}

function lastUserMessage(messages: unknown): Obj | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (isObj(candidate) && str(candidate.role) === 'user') return candidate;
  }
  return undefined;
}

function textOfContent(content: unknown): string {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (!Array.isArray(content)) throw new A2ARequestError(400, 'message.content must be text or an array of parts', { reason: 'bad_content' });
  else {
    const parts = content as Parameters<typeof contentHasMedia>[0];
    if (contentHasMedia(parts)) throw new A2ARequestError(400, 'this agent accepts text input only', { reason: NON_TEXT_CONTENT });
    text = contentToText(parts);
  }
  // The same test for both spellings: an empty string and a part list with no
  // text in it are the same run, and kagent must not be dialed to answer nothing.
  if (text === '') throw new A2ARequestError(400, 'the last user message carries no text', { reason: 'empty_message' });
  return text;
}

// A resume answers the interrupt we ended a run with. Its id IS the paused A2A
// task, so it becomes the turn's taskId and resolves the conversation by task —
// the tighter handle — with the thread handle left as the fallback.
function resumeTurn(resume: unknown, run: ParsedRun): RestTurn {
  if (!Array.isArray(resume) || resume.length === 0) {
    throw new A2ARequestError(400, 'resume must be a non-empty array', { reason: 'empty_resume' });
  }
  if (resume.length > 1) {
    throw new A2ARequestError(400, 'this agent asks one question at a time', { reason: 'multiple_interrupts' });
  }
  const entry = resume[0];
  if (!isObj(entry)) throw new A2ARequestError(400, 'a resume entry must be an object', { reason: 'bad_resume' });
  const interruptId = str(entry.interruptId);
  if (!interruptId) throw new A2ARequestError(400, 'resume.interruptId is required', { reason: 'bad_resume' });
  if (str(entry.status) === 'cancelled') {
    throw new A2ARequestError(501, 'abandoning a question is not supported yet — answer it or cancel the run', {
      reason: RESUME_CANCELLED,
      metadata: { task_id: interruptId },
    });
  }
  const payload = entry.payload;
  if (typeof payload !== 'string' || payload === '') {
    throw new A2ARequestError(400, 'an answer must be the text to hand back to the agent', {
      reason: RESUME_PAYLOAD_UNSUPPORTED,
      metadata: { interrupt_id: interruptId },
    });
  }
  return {
    message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: payload }], taskId: interruptId },
    threadId: run.threadId,
    pushConfigRequested: false,
  };
}

export function turnFromRunAgentInput(body: unknown): { run: ParsedRun; turn: RestTurn } {
  if (!isObj(body)) throw new A2ARequestError(400, 'request body must be an object', { reason: 'bad_run_input' });
  const run = parseRunHeader(body);
  const modelId = modelIdOf(body);

  if (body.resume !== undefined) {
    const turn = resumeTurn(body.resume, run);
    if (modelId) turn.modelId = modelId;
    return { run, turn };
  }

  const message = lastUserMessage(body.messages);
  if (!message) throw new A2ARequestError(400, 'messages must include a user message', { reason: 'no_user_message' });
  const text = textOfContent(message.content);
  return {
    run,
    turn: {
      message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }] },
      modelId,
      threadId: run.threadId,
      pushConfigRequested: false,
    },
  };
}
