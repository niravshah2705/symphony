// Translation between what the browser's A2A client sends/expects and what
// kagent's controller speaks. The controller serves JSON-RPC with proto enum
// states; the client sends REST-style bodies and unwraps either envelope itself
// (A2AClient normalizeKeys maps TASK_STATE_X -> x, ROLE_X -> x). So the rule
// here is: forward frames verbatim, and *read* them tolerantly for our own
// bookkeeping. Inventing a rewrite is how a passing stream gets broken.

import { randomUUID } from 'node:crypto';
import {
  MODEL_METADATA_KEY,
  REASONING_ARTIFACT_ID,
  REASONING_ARTIFACT_NAME,
  isThoughtPart,
  parseHitlPayload,
  parseStructuredOutputPart,
  parseToolActivityPart,
  type StructuredOutput,
  type ToolActivity,
} from '@fleet-local/shared';
import type { A2AMessage } from '../kagent/a2a.ts';
import { A2ARequestError, normalizeState } from './contract.ts';

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function textsOf(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(isObj)
    .map((part) => str(part.text) ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

// Reasoning is a text part with kagent's thought marker; the answer is any other
// text part. Both can appear in the same frame, so collect them separately.
function thoughtsOf(...candidates: unknown[]): string {
  const found: string[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (isObj(item) && Array.isArray(item.parts)) found.push(thoughtsOf(item.parts));
        else if (isThoughtPart(item)) found.push(str((item as Obj).text) ?? '');
      }
    }
  }
  return found.filter((text) => text !== '').join('');
}

// The answer, i.e. every text part NOT marked as thought. "The task completed"
// and "the task completed and said something" are different facts, and the mock
// worker proves the gap is real: it settles a turn with no artifacts at all,
// which is what the UI renders as an empty bubble. Recording the difference is
// how the session row can explain it.
function answersOf(...candidates: unknown[]): string {
  const found: string[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (!isObj(item)) continue;
      if (Array.isArray(item.parts)) found.push(answersOf(item.parts));
      else if (!isThoughtPart(item)) found.push(str(item.text) ?? '');
    }
  }
  return found.filter((text) => text !== '').join('');
}

export type FrameView = 'task' | 'status-update' | 'artifact-update' | 'message' | 'rpc-error' | 'unknown';

// Tool calls ride the same containers thoughts do: artifact lists and bare part
// lists, recursed through `parts`. Anything that is not a tagged data part is
// skipped, so a text or file artifact simply contributes nothing here.
function toolsOf(...candidates: unknown[]): ToolActivity[] {
  const found: ToolActivity[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (!isObj(item)) continue;
      if (Array.isArray(item.parts)) {
        found.push(...toolsOf(item.parts));
        continue;
      }
      const activity = parseToolActivityPart(item);
      if (activity) found.push(activity);
    }
  }
  return found;
}

// True if the list carries at least one agent-produced part. Both an artifact
// list and a bare part list arrive here, and an artifact-update frame wraps
// exactly one artifact — so a container with no parts must not count as output.
function carriesParts(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  return list.some((item) => {
    if (!isObj(item)) return false;
    if (Array.isArray(item.parts)) return item.parts.length > 0;
    return ['text', 'raw', 'url', 'data', 'file'].some((kind) => item[kind] !== undefined);
  });
}

// One agent-produced file as it rides the wire: inline bytes or a URI reference.
// The AG-UI encoder re-speaks this as a CUSTOM event the SPA renders directly.
export interface WireFile {
  bytes?: string;
  uri?: string;
  mimeType?: string;
  name?: string;
}

// An A2A FilePart in either JSON spelling: the REST binding's discriminated
// `{kind:"file", file:{…}}`, and the proto-JSON oneof with the file fields flat
// on the part. Read tolerantly like every other frame field.
function readFilePart(part: Obj): WireFile | undefined {
  const file = isObj(part.file) ? part.file : str(part.kind) === 'file' ? part : undefined;
  if (!file) return undefined;
  const bytes = str(file.bytes);
  const uri = str(file.uri) ?? str(file.url);
  if (bytes === undefined && uri === undefined) return undefined;
  const out: WireFile = {};
  if (bytes !== undefined) out.bytes = bytes;
  if (uri !== undefined) out.uri = uri;
  const mimeType = str(file.mimeType) ?? str(file.mime_type);
  if (mimeType) out.mimeType = mimeType;
  const name = str(file.name);
  if (name) out.name = name;
  return out;
}

// The structured terminal result (go/api/a2a/structured_output.go). A run carries
// at most one, but the final task frame replays it, so the LAST read wins and the
// encoder dedupes by content.
function structuredOf(...candidates: unknown[]): StructuredOutput | undefined {
  let found: StructuredOutput | undefined;
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (!isObj(item)) continue;
      if (Array.isArray(item.parts)) {
        found = structuredOf(item.parts) ?? found;
        continue;
      }
      const structured = parseStructuredOutputPart(item);
      if (structured) found = structured;
    }
  }
  return found;
}

function filesOf(...candidates: unknown[]): WireFile[] {
  const found: WireFile[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (!isObj(item)) continue;
      if (Array.isArray(item.parts)) {
        found.push(...filesOf(item.parts));
        continue;
      }
      const file = readFilePart(item);
      if (file) found.push(file);
    }
  }
  return found;
}

export interface WireFrame {
  view: FrameView;
  contextId?: string;
  taskId?: string;
  /** Canonical internal spelling, see contract.normalizeState. */
  state?: string;
  /** status.message text — for a failed task this IS the failure reason. */
  statusMessage?: string;
  /** Text of the parts marked as model reasoning in this frame. */
  thought?: string;
  /** Text of the answer parts in this frame (artifacts / a message reply). */
  answer?: string;
  /**
   * This frame carried at least one agent-produced part. Text is only what WE
   * can read: a coding agent answering with a raw/url part produces output
   * without producing answer text, and must not be reported as an empty turn.
   */
  producesOutput?: boolean;
  /**
   * Tool invocations carried by this frame's data parts (kagent's function_call
   * / function_response convention). The AG-UI encoder turns these into the
   * TOOL_CALL_* sequence; stdout-only harnesses never produce them.
   */
  toolCalls?: ToolActivity[];
  /**
   * Files produced by the agent (A2A FileParts: inline bytes or a URI). The AG-UI
   * encoder re-speaks these as CUSTOM artifacts the SPA renders as thumbnails
   * or links; a text-only harness never produces them.
   */
  files?: WireFile[];
  /**
   * The run's structured terminal result, when the harness enforced an output
   * schema. The AG-UI encoder turns this into the generative-UI artifact.
   */
  structured?: StructuredOutput;
  /**
   * The typed HITL payload on this frame's status/message metadata, if any
   * (tool-approval or ask-user request). Read for the interrupt in encode.ts.
   */
  hitl?: Record<string, unknown>;
  rpcError?: { code?: unknown; message?: unknown };
}

const REST_KEYS: Record<string, FrameView> = {
  task: 'task',
  message: 'message',
  statusUpdate: 'status-update',
  status_update: 'status-update',
  artifactUpdate: 'artifact-update',
  artifact_update: 'artifact-update',
};

const KIND_KEYS: Record<string, FrameView> = {
  task: 'task',
  message: 'message',
  'status-update': 'status-update',
  statusUpdate: 'status-update',
  'artifact-update': 'artifact-update',
  artifactUpdate: 'artifact-update',
};

// Both envelope shapes the A2A bindings emit, plus the JSON-RPC wrapper.
function locateFrame(payload: unknown): { view: FrameView; node: Obj } | undefined {
  if (!isObj(payload)) return undefined;
  for (const [key, view] of Object.entries(REST_KEYS)) {
    if (key in payload && isObj(payload[key])) return { view, node: payload[key] as Obj };
  }
  const kind = str(payload.kind);
  const view = kind ? KIND_KEYS[kind] : undefined;
  if (view) {
    const { kind: _kind, ...rest } = payload;
    return { view, node: rest };
  }
  return undefined;
}

export function inspectFrame(raw: string): WireFrame | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (isObj(payload) && 'jsonrpc' in payload) {
    if (isObj(payload.error)) {
      return { view: 'rpc-error', rpcError: { code: payload.error.code, message: payload.error.message } };
    }
    payload = payload.result;
  }
  const located = locateFrame(payload);
  if (!located) return undefined;
  const { view, node } = located;
  const frame: WireFrame = { view };

  const contextId = str(node.contextId) ?? (isObj(payload) ? str(payload.contextId) : undefined);
  if (contextId) frame.contextId = contextId;
  const taskId = view === 'task' ? str(node.id) : str(node.taskId);
  if (taskId) frame.taskId = taskId;

  const status = isObj(node.status) ? node.status : undefined;
  if (status) {
    const state = normalizeState(str(status.state));
    if (state) frame.state = state;
    if (isObj(status.message)) {
      const text = textsOf(status.message.parts);
      if (text) frame.statusMessage = text;
    }
  }

  const artifacts = view === 'task' ? node.artifacts : view === 'artifact-update' ? [node.artifact] : undefined;
  const parts = view === 'message' ? node.parts : undefined;
  const statusParts = status && isObj(status.message) ? status.message.parts : undefined;
  const thought = thoughtsOf(artifacts ?? [], parts ?? [], statusParts ?? []);
  if (thought) frame.thought = thought;
  // An agent may answer through an artifact, a bare Message reply, or the status
  // message of the task — all three count as "the turn produced output".
  const answer = answersOf(artifacts ?? [], parts ?? [], statusParts ?? []);
  if (answer) frame.answer = answer;
  if (carriesParts(artifacts) || carriesParts(parts) || carriesParts(statusParts)) frame.producesOutput = true;
  const tools = toolsOf(artifacts ?? [], parts ?? [], statusParts ?? []);
  if (tools.length > 0) frame.toolCalls = tools;
  const files = filesOf(artifacts ?? [], parts ?? [], statusParts ?? []);
  if (files.length > 0) frame.files = files;
  const structured = structuredOf(artifacts ?? [], parts ?? [], statusParts ?? []);
  if (structured) frame.structured = structured;
  // A harness asking for approval puts its typed payload on the message that
  // carries the input-required status (go/api/a2a/hitl.go AttachHITL), so the
  // metadata lives on status.message — with the message view as the fallback
  // spelling some bindings use.
  const statusMessage = status && isObj(status.message) ? status.message : undefined;
  const hitl = parseHitlPayload(statusMessage?.metadata) ?? parseHitlPayload(node.metadata);
  if (hitl) frame.hitl = hitl;
  return frame;
}

// The synthetic frame that carries reasoning to the UI. assistant-ui keeps
// artifact identity, so all thought text for a task accumulates under one
// artifactId; the client's own append handling does the rest.
export function buildThoughtArtifact(input: {
  text: string;
  taskId?: string;
  contextId?: string;
  append: boolean;
}): string | undefined {
  if (!input.taskId || !input.contextId || input.text === '') return undefined;
  return JSON.stringify({
    artifactUpdate: {
      taskId: input.taskId,
      contextId: input.contextId,
      append: input.append,
      lastChunk: false,
      artifact: {
        artifactId: REASONING_ARTIFACT_ID,
        name: REASONING_ARTIFACT_NAME,
        parts: [{ text: input.text }],
      },
    },
  });
}

export interface RestTurn {
  message: A2AMessage;
  /** The chat model the SPA asked for; consumed here, never forwarded upstream. */
  modelId?: string;
  /** The AG-UI client's own conversation handle; never set on the A2A leg. */
  threadId?: string;
  /**
   * The resume abandoned the question rather than answered it (AG-UI resume
   * status "cancelled"): the BFF cancels this task instead of streaming a turn.
   */
  cancelTaskId?: string;
  pushConfigRequested: boolean;
}

// A2A lets a client request webhook delivery of task updates. The BFF has no
// public callback URL and no verifier, so that is refused rather than accepted
// and silently dropped.
export function turnFromRestBody(body: unknown): RestTurn {
  if (!isObj(body)) throw new A2ARequestError(400, 'request body must be an object');
  const raw = body.message;
  if (!isObj(raw)) throw new A2ARequestError(400, 'message is required');

  const role = str(raw.role);
  if (role && role !== 'ROLE_USER' && role !== 'user') {
    throw new A2ARequestError(400, `unsupported message role "${role}" — only a user message can be sent`);
  }
  if (!Array.isArray(raw.parts) || raw.parts.length === 0) {
    throw new A2ARequestError(400, 'message.parts must be a non-empty array');
  }
  const parts: { text: string }[] = [];
  for (const part of raw.parts) {
    if (!isObj(part)) throw new A2ARequestError(400, 'each message part must be an object');
    const kind = str(part.kind);
    if (kind && kind !== 'text') throw new A2ARequestError(400, `unsupported part kind "${kind}"`);
    const text = str(part.text);
    if (text === undefined) throw new A2ARequestError(400, 'a text part needs a text field');
    parts.push({ text });
  }

  let modelId: string | undefined;
  let metadata = isObj(raw.metadata) ? raw.metadata : undefined;
  if (metadata && typeof metadata[MODEL_METADATA_KEY] === 'string') {
    modelId = metadata[MODEL_METADATA_KEY] as string;
    const { [MODEL_METADATA_KEY]: _stripped, ...rest } = metadata;
    metadata = Object.keys(rest).length ? rest : undefined;
  }

  const message: A2AMessage = { messageId: str(raw.messageId) ?? randomUUID(), role: 'ROLE_USER', parts };
  const contextId = str(raw.contextId) ?? str(raw.context_id);
  if (contextId) message.contextId = contextId;
  // Resume: the client re-sends with the same taskId when a task paused on
  // input-required, which is how an approval or a question gets answered.
  const taskId = str(raw.taskId) ?? str(raw.task_id);
  if (taskId) message.taskId = taskId;
  if (metadata) message.metadata = metadata;

  const configuration = body.configuration;
  const pushConfigRequested =
    isObj(configuration) && ('taskPushNotificationConfig' in configuration || 'pushNotificationConfig' in configuration);

  return { message, modelId, pushConfigRequested };
}

export type TaskAction = 'get' | 'cancel' | 'subscribe' | 'push-config' | 'unsupported';

// `tasks/{id}:cancel` puts a colon inside a path segment, which find-my-way
// cannot express as a :param pattern — so the route is a wildcard and the tail
// is split here, where it can be tested.
export function parseTaskSubpath(tail: string): { taskId: string; action: TaskAction; configId?: string } {
  const path = (tail.split('?')[0] ?? '').replace(/^\/+/, '');
  const segments = path.split('/');
  const head = segments[0] ?? '';
  const rest = segments.slice(1);
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  if (!head) return { taskId: '', action: 'unsupported' };
  if (head.endsWith(':cancel')) return { taskId: decode(head.slice(0, -':cancel'.length)), action: 'cancel' };
  if (head.endsWith(':subscribe')) return { taskId: decode(head.slice(0, -':subscribe'.length)), action: 'subscribe' };
  const taskId = decode(head);
  if (rest.length === 0) return { taskId, action: 'get' };
  if (rest[0] === 'pushNotificationConfigs') {
    return { taskId, action: 'push-config', configId: rest[1] ? decode(rest[1]) : undefined };
  }
  return { taskId, action: 'unsupported' };
}

// The facade mounts ONE wildcard per project because `tasks/{id}:cancel` puts a
// colon inside a path segment, which find-my-way cannot express as a :param
// pattern. So the routing decision lives here, where it can be tested: given the
// wildcard tail, what is being called?
export type FacadeCall =
  | { kind: 'agent-card' }
  | { kind: 'stream' }
  | { kind: 'send' }
  | { kind: 'extended-card' }
  | { kind: 'task'; taskId: string; action: TaskAction; configId?: string }
  | { kind: 'unknown'; path: string };

export function routeFacadePath(tail: string): FacadeCall {
  const path = (tail.split('?')[0] ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (path === '.well-known/agent-card.json') return { kind: 'agent-card' };
  if (path === '.well-known/extended-agent-card.json') return { kind: 'extended-card' };
  if (path === 'message:stream') return { kind: 'stream' };
  if (path === 'message:send') return { kind: 'send' };
  if (path.startsWith('tasks/') || path === 'tasks') {
    const { taskId, action, configId } = parseTaskSubpath(path.slice('tasks'.length));
    return { kind: 'task', taskId, action, configId };
  }
  return { kind: 'unknown', path };
}

// The controller advertises itself; a browser must never be told to dial
// kagent-controller.kagent.svc. Only the URLs change — name, capabilities and
// skills stay byte-identical, because the client rejects a card that loses its
// name or its string-typed skill tags.
export function rewriteAgentCard(card: unknown, facadeBase: string): Obj {
  if (!isObj(card)) throw new A2ARequestError(502, 'agent card is not a JSON object');
  if (typeof card.name !== 'string' || card.name === '') throw new A2ARequestError(502, 'agent card carries no name');
  const out: Obj = { ...card };
  if (typeof out.url === 'string') out.url = facadeBase;
  for (const key of ['supportedInterfaces', 'additionalInterfaces'] as const) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.map((iface) => (isObj(iface) ? { ...iface, url: facadeBase } : iface));
  }
  return out;
}
