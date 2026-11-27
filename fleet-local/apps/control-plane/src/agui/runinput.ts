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
import { AGUI_MODEL_PROP, HITL_EXTENSION_URI, HITL_TYPE_ASK_USER_RESPONSE, HITL_TYPE_TOOL_APPROVAL_RESPONSE } from '@fleet-local/shared';
import type { RestTurn } from '../a2a/translate.ts';
import type { HitlAskUserResponse, HitlToolApprovalResponse } from '@fleet-local/shared';
import type { A2APart } from '../kagent/a2a.ts';
import { A2ARequestError } from '../a2a/contract.ts';

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// A structured answer must be one of kagent's HITL response payloads (see
// go/api/a2a/hitl.go); anything else is refused out loud, never forwarded.
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

// Attachments v1: an image/document part with inline bytes or a URL becomes an
// A2A FilePart — the controller stores it with the task and the harness adapter
// decides whether its model can see it (claude/codex accept vision input; a
// stdout harness ignores what it cannot render). A provider file id is refused:
// resolving one needs the provider's own storage, which the proxy-less local
// stack has no credential for.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/csv',
]);

function fileFromMediaPart(part: Obj): NonNullable<A2APart['file']> {
  const source = isObj(part.source) ? part.source : undefined;
  const kind = source ? str(source.type) : undefined;
  const value = source ? str(source.value) : undefined;
  if (!source || !kind || !value) {
    throw new A2ARequestError(400, 'an attachment part needs a source with a value', { reason: 'attachment_source_missing' });
  }
  const metadata = isObj(part.metadata) ? part.metadata : undefined;
  const name = metadata ? str(metadata.filename) : undefined;
  const mimeType = str(source.mimeType) ?? 'application/octet-stream';
  if (kind === 'url') return { uri: value, mimeType, ...(name ? { name } : {}) };
  if (kind === 'data') {
    if (!ALLOWED_ATTACHMENT_MIME.has(mimeType)) {
      throw new A2ARequestError(400, `attachment type "${mimeType}" is not supported`, { reason: 'attachment_type_unsupported' });
    }
    // base64 grows the payload by 4/3; gate on the decoded size, not the wire size.
    if (Math.floor((value.length * 3) / 4) > MAX_ATTACHMENT_BYTES) {
      throw new A2ARequestError(413, 'an attachment is larger than 5 MB', { reason: 'attachment_too_large' });
    }
    return { bytes: value, mimeType, ...(name ? { name } : {}) };
  }
  throw new A2ARequestError(400, 'attachments must carry their bytes inline or as a URL', { reason: 'attachment_reference_unsupported' });
}

function contentParts(content: unknown): A2APart[] {
  if (typeof content === 'string') {
    if (content === '') throw new A2ARequestError(400, 'the last user message carries no text', { reason: 'empty_message' });
    return [{ text: content }];
  }
  if (!Array.isArray(content)) {
    throw new A2ARequestError(400, 'message.content must be text or an array of parts', { reason: 'bad_content' });
  }
  const parts: A2APart[] = [];
  for (const raw of content) {
    if (!isObj(raw)) throw new A2ARequestError(400, 'each content part must be an object', { reason: 'bad_content' });
    const type = str(raw.type);
    if (type === 'text') {
      const text = str(raw.text);
      if (text) parts.push({ text });
      continue;
    }
    if (type === 'image' || type === 'audio' || type === 'video' || type === 'document') {
      parts.push({ file: fileFromMediaPart(raw) });
      continue;
    }
    throw new A2ARequestError(400, `unsupported content part type "${type ?? 'unknown'}"`, { reason: NON_TEXT_CONTENT });
  }
  // The same rule as the old text-only path, widened: a turn must hand the agent
  // something, and empty text beside an attachment is not that something alone.
  if (parts.length === 0) throw new A2ARequestError(400, 'the last user message carries nothing to send', { reason: 'empty_message' });
  return parts;
}

// A resume answers the interrupt we ended a run with. Its id IS the paused A2A
// task, so it becomes the turn's taskId and resolves the conversation by task —
// the tighter handle — with the thread handle left as the fallback.
//
// Three payload shapes are accepted:
//  - a string  → the ordinary text answer, forwarded as message text;
//  - a tool_approval_response / ask_user_response (kagent's HITL types, mirroring
//    go/api/a2a/hitl.go) → forwarded as declared-extension metadata, with a plain
//    text summary alongside so the task transcript stays readable;
//  - status "cancelled" → nobody answered: the paused task is cancelled instead
//    of a turn being streamed.
// Shape validation here is deliberately structural, not semantic: kagent checks
// that the decisions match the pending request exactly (one per tool id, answer
// counts per question), and re-implementing that here would be a second copy to
// drift. A malformed payload fails at the controller with its own clear error.
function structuredResume(payload: Obj): { metadataPayload: Obj; summary: string } | undefined {
  if (payload.type === HITL_TYPE_TOOL_APPROVAL_RESPONSE && Array.isArray(payload.approvals)) {
    const approvals = payload.approvals.filter(isObj) as unknown as HitlToolApprovalResponse['approvals'];
    if (approvals.length !== payload.approvals.length || approvals.length === 0) return undefined;
    for (const approval of approvals) {
      if (typeof approval.id !== 'string' || approval.id === '' || typeof approval.approved !== 'boolean') return undefined;
      if (approval.approved && approval.rejection_reason) return undefined;
    }
    const approved = approvals.filter((a) => a.approved).length;
    const rejected = approvals.length - approved;
    const summary = rejected === 0 ? `Approved ${approved} tool call(s)` : `Approved ${approved}, rejected ${rejected} tool call(s)`;
    return { metadataPayload: payload, summary };
  }
  if (payload.type === HITL_TYPE_ASK_USER_RESPONSE && typeof payload.id === 'string' && Array.isArray(payload.answers)) {
    const answers = payload.answers.filter(isObj) as unknown as HitlAskUserResponse['answers'];
    if (answers.length !== payload.answers.length || answers.length === 0) return undefined;
    if (!answers.every((answer) => Array.isArray(answer.answer) && answer.answer.length > 0 && answer.answer.every((value) => typeof value === 'string'))) {
      return undefined;
    }
    const summary = answers.map((answer) => answer.answer.join(', ')).join(' | ');
    return { metadataPayload: payload, summary };
  }
  return undefined;
}

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
    // The message is never sent — server.ts answers this turn with CancelTask —
    // but the task handle rides on it so openTurn resolves the paused session.
    return {
      message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [], taskId: interruptId },
      cancelTaskId: interruptId,
      threadId: run.threadId,
      pushConfigRequested: false,
    };
  }
  const payload = entry.payload;
  if (typeof payload === 'string') {
    if (payload === '') {
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
  const structured = isObj(payload) ? structuredResume(payload) : undefined;
  if (!structured) {
    throw new A2ARequestError(400, 'an answer must be text or a kagent HITL response payload (tool_approval_response / ask_user_response)', {
      reason: RESUME_PAYLOAD_UNSUPPORTED,
      metadata: { interrupt_id: interruptId },
    });
  }
  return {
    message: {
      messageId: randomUUID(),
      role: 'ROLE_USER',
      parts: [{ text: structured.summary }],
      taskId: interruptId,
      metadata: { [HITL_EXTENSION_URI]: structured.metadataPayload },
      extensions: [HITL_EXTENSION_URI],
    },
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
  const parts = contentParts(message.content);
  return {
    run,
    turn: {
      message: { messageId: randomUUID(), role: 'ROLE_USER', parts },
      modelId,
      threadId: run.threadId,
      pushConfigRequested: false,
    },
  };
}
