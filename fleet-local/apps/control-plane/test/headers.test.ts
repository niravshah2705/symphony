import test from 'node:test';
import assert from 'node:assert/strict';
import { a2aHeaders, makeTraceparent, userMessage, type FleetIdentity } from '../src/kagent/a2a.ts';
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

test('userMessage carries text and optional context/task ids', () => {
  const m = userMessage('hello');
  assert.equal(m.role, 'ROLE_USER');
  assert.equal(m.parts[0]?.text, 'hello');
  assert.ok(m.messageId);
  assert.equal(m.contextId, undefined);
  assert.equal(m.taskId, undefined);
  const cont = userMessage('again', 'ctx-1', 'task-1');
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