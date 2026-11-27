import { randomUUID } from 'node:crypto';
import { BAGGAGE_KEYS, FLEET_HEADERS, encodeBaggage } from '@fleet-local/shared';
import { config } from '../config.ts';
import { fetchJson } from '../clients/http.ts';

// kagent serves A2A over HTTP JSON-RPC at POST /agents/{namespace}/{name} with the
// PascalCase gRPC method names (SendMessage / SendStreamingMessage / GetTask /
// ListTasks) and the mandatory A2A-Version: 1.0 header. contextId is the Session.

export interface FleetIdentity {
  orgId: string;
  projectId: string;
  userEmail: string;
  conversationId?: string;
}

// The A2A Part oneof, in the JSON form the controller accepts. Text is what a
// turn says; file is what it hands over (base64 `bytes` or a `uri` reference),
// per go's a2a Part (Text/Raw/Data/URL — FilePart carries the url/bytes pair).
export interface A2APart {
  text?: string;
  file?: { bytes?: string; uri?: string; name?: string; mimeType?: string };
}

export interface A2AMessage {
  messageId: string;
  role: 'ROLE_USER';
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  // A message answering an extension payload (kagent's HITL approval/ask-user
  // responses) must DECLARE the extension, or the controller never parses the
  // metadata and rejects the resume (go/api/a2a/hitl.go ParseToolApprovalResponse).
  extensions?: string[];
}

export function userMessage(parts: A2APart[], contextId?: string, taskId?: string): A2AMessage {
  const msg: A2AMessage = { messageId: randomUUID(), role: 'ROLE_USER', parts };
  if (contextId) msg.contextId = contextId;
  if (taskId) msg.taskId = taskId;
  return msg;
}

// Stamp the canonical UUIDs into both baggage (survives into the actor when
// OTEL_PROPAGATORS=tracecontext,baggage) and x-fleet-* headers (static fallback).
export function a2aHeaders(id: FleetIdentity, bearer: string, traceparent?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'A2A-Version': '1.0',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bearer}`,
    [FLEET_HEADERS.orgId]: id.orgId,
    [FLEET_HEADERS.projectId]: id.projectId,
    [FLEET_HEADERS.userId]: id.userEmail,
    baggage: encodeBaggage({
      [BAGGAGE_KEYS.orgId]: id.orgId,
      [BAGGAGE_KEYS.projectId]: id.projectId,
      [BAGGAGE_KEYS.userId]: id.userEmail,
      [BAGGAGE_KEYS.conversationId]: id.conversationId,
    }),
  };
  if (traceparent) headers.traceparent = traceparent;
  return headers;
}

export function makeTraceparent(): string {
  const traceId = randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

const agentUrl = (namespace: string, name: string) => `${config.kagentControllerUrl}/agents/${namespace}/${name}`;

function envelope(method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 1, method, params };
}

export interface A2ATask {
  id: string;
  contextId: string;
  status?: { state?: string };
  artifacts?: { artifactId: string; parts?: { text?: string }[] }[];
  metadata?: Record<string, unknown>;
}

export async function sendMessage(namespace: string, name: string, headers: Record<string, string>, message: A2AMessage) {
  const res = await fetchJson<{ result?: { task?: A2ATask }; error?: unknown }>(agentUrl(namespace, name), {
    method: 'POST',
    headers,
    body: envelope('SendMessage', { message }),
    timeoutMs: 120000,
  });
  if (res.error) throw new Error(`a2a SendMessage error: ${JSON.stringify(res.error)}`);
  return res.result?.task;
}

// Long-running: no client timeout. Returns the raw response so the caller pipes
// the SSE body straight through to the browser.
export function streamMessage(namespace: string, name: string, headers: Record<string, string>, message: A2AMessage): Promise<Response> {
  return fetch(agentUrl(namespace, name), {
    method: 'POST',
    headers: { ...headers, Accept: 'text/event-stream' },
    body: JSON.stringify(envelope('SendStreamingMessage', { message })),
  });
}

export async function getTask(namespace: string, name: string, headers: Record<string, string>, taskId: string) {
  const res = await fetchJson<{ result?: A2ATask; error?: unknown }>(agentUrl(namespace, name), {
    method: 'POST',
    headers,
    body: envelope('GetTask', { id: taskId }),
  });
  return res.result;
}

export async function listTasks(namespace: string, name: string, headers: Record<string, string>, contextId?: string) {
  const params: Record<string, unknown> = { pageSize: 50, includeArtifacts: false };
  if (contextId) params.contextId = contextId;
  const res = await fetchJson<{ result?: { tasks?: A2ATask[] }; error?: unknown }>(agentUrl(namespace, name), {
    method: 'POST',
    headers,
    body: envelope('ListTasks', params),
  });
  return res.result?.tasks ?? [];
}

// The controller guards the card with the SAME auth as the RPC endpoint (a bare
// GET answers 401), so identity headers are not optional here.
export async function agentCard(namespace: string, name: string, headers: Record<string, string> = {}) {
  return fetchJson(`${agentUrl(namespace, name)}/.well-known/agent-card.json`, {
    headers: { 'A2A-Version': '1.0', ...headers },
  });
}

export interface RpcResult {
  status: number;
  body: unknown;
}

// The A2A facade forwards the controller's JSON-RPC envelope VERBATIM: the
// browser client unwraps {jsonrpc,result} and drops a flat `kind` itself, so
// re-shaping here would only add a way to get it wrong. Note that kagent reports
// an application failure as HTTP 200 with an `error` member (e.g. -32001 "task
// not found"), which is why the status code alone can never be the verdict.
export async function rpcEnvelope(
  namespace: string,
  name: string,
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<RpcResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(agentUrl(namespace, name), {
      method: 'POST',
      headers: { ...headers, Accept: 'application/json' },
      body: JSON.stringify(envelope(method, params)),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { jsonrpc: '2.0', error: { code: -32603, message: `non-JSON upstream response: ${text.slice(0, 200)}` } };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Method names are the proto RPC names (PascalCase), confirmed against the live
// controller: tasks/cancel answers METHOD_NOT_FOUND, CancelTask answers
// TASK_NOT_FOUND. SubscribeToTask is a real streaming method.
export function cancelTask(namespace: string, name: string, headers: Record<string, string>, taskId: string): Promise<RpcResult> {
  return rpcEnvelope(namespace, name, headers, 'CancelTask', { id: taskId });
}

// Long-running like streamMessage: no client timeout, body piped through as SSE.
export function subscribeTask(namespace: string, name: string, headers: Record<string, string>, taskId: string): Promise<Response> {
  return fetch(agentUrl(namespace, name), {
    method: 'POST',
    headers: { ...headers, Accept: 'text/event-stream' },
    body: JSON.stringify(envelope('SubscribeToTask', { id: taskId })),
  });
}