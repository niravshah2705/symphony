import test from 'node:test';
import assert from 'node:assert/strict';
import { a2aHeaders, agentCard, makeTraceparent, userMessage, type FleetIdentity } from '../src/kagent/a2a.ts';
import { BAGGAGE_KEYS, FLEET_HEADERS, STRIPPED_CLIENT_HEADERS, decodeBaggage } from '@fleet-local/shared';

const id: FleetIdentity = {
  orgId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  userEmail: 'nirav@example.com',
  conversationId: 'sess-abc',
};

test('a2aHeaders stamps the A2A contract, identity and baggage', () => {
  const h = a2aHeaders(id, 'google-id-token', '00-trace-span-01');
  assert.equal(h['A2A-Version'], '1.0');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h.Authorization, 'Bearer google-id-token');
  assert.equal(h[FLEET_HEADERS.orgId], id.orgId);
  assert.equal(h[FLEET_HEADERS.projectId], id.projectId);
  assert.equal(h[FLEET_HEADERS.userId], id.userEmail);
  assert.equal(h.traceparent, '00-trace-span-01');
  const bag = decodeBaggage(h.baggage);
  assert.equal(bag[BAGGAGE_KEYS.orgId], id.orgId);
  assert.equal(bag[BAGGAGE_KEYS.projectId], id.projectId);
  assert.equal(bag[BAGGAGE_KEYS.userId], id.userEmail);
  assert.equal(bag[BAGGAGE_KEYS.conversationId], 'sess-abc');
});

test('a2aHeaders omits traceparent and conversation when absent', () => {
  const h = a2aHeaders({ ...id, conversationId: undefined }, 'tok');
  assert.equal(h.traceparent, undefined);
  const bag = decodeBaggage(h.baggage);
  assert.equal(bag[BAGGAGE_KEYS.conversationId], undefined);
  assert.equal(bag[BAGGAGE_KEYS.orgId], id.orgId);
});

test('makeTraceparent is a valid sampled W3C traceparent', () => {
  const tp = makeTraceparent();
  assert.match(tp, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.notEqual(makeTraceparent(), tp);
});

test('userMessage carries text and file parts, with optional context/task ids', () => {
  const m = userMessage([{ text: 'hello' }]);
  assert.equal(m.role, 'ROLE_USER');
  assert.equal(m.parts[0]?.text, 'hello');
  assert.ok(m.messageId);
  assert.equal(m.contextId, undefined);
  assert.equal(m.taskId, undefined);
  const cont = userMessage([{ text: 'look' }, { file: { bytes: 'aGk=', mimeType: 'text/plain', name: 'hi.txt' } }], 'ctx-1', 'task-1');
  assert.equal(cont.parts.length, 2);
  assert.equal(cont.parts[1]?.file?.bytes, 'aGk=');
  assert.equal(cont.contextId, 'ctx-1');
  assert.equal(cont.taskId, 'task-1');
});

test('edge strip list covers every spoofable identity/fleet header', () => {
  for (const name of [
    'x-auth-request-email',
    'x-auth-request-user',
    'x-auth-request-preferred-username',
    'x-forwarded-user',
    'x-forwarded-email',
    'x-fleet-org-id',
    'x-fleet-project-id',
    'x-fleet-user-id',
    'x-user-id',
    'x-agent-name',
  ]) {
    assert.ok(STRIPPED_CLIENT_HEADERS.includes(name as never), `missing strip: ${name}`);
  }
});

// The controller guards the card with the same auth as the RPC endpoint, so a
// bare GET answers 401 and the facade degrades to "agent card unavailable" —
// proven live by t31 gate 2. The headers are not optional on this call.
test('agentCard forwards identity headers and keeps the A2A-Version contract', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ name: 'mock worker' }), { status: 200 });
  }) as typeof fetch;
  try {
    const card = await agentCard('org-test', 'test-agent-mock-worker', a2aHeaders(id, 'tok'));
    assert.deepEqual(card, { name: 'mock worker' });
  } finally {
    globalThis.fetch = real;
  }
  const seen = calls[0];
  assert.ok(seen, 'no upstream call made');
  assert.ok(seen.url.endsWith('/agents/org-test/test-agent-mock-worker/.well-known/agent-card.json'), seen.url);
  assert.equal(seen.headers['A2A-Version'], '1.0');
  assert.equal(seen.headers.Authorization, 'Bearer tok');
  assert.equal(seen.headers[FLEET_HEADERS.orgId], id.orgId);
});