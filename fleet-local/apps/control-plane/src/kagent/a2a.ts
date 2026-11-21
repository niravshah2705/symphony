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

export interface A2AMessage {
  messageId: string;
  role: 'ROLE_USER';
  parts: { text: string }[];
  contextId?: string;
  taskId?: string;
}

export function userMessage(text: string, contextId?: string, taskId?: string): A2AMessage {
  const msg: A2AMessage = { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }] };
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

export async function agentCard(namespace: string, name: string) {
  return fetchJson(`${agentUrl(namespace, name)}/.well-known/agent-card.json`, {
    headers: { 'A2A-Version': '1.0' },
  });
}