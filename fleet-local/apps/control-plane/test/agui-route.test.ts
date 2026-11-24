import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { aguiRoutes } from '../src/routes/agui.ts';
import { aguiRunPath } from '@fleet-local/shared';

// A browser cannot tell a route that was never registered from a server that
// crashed, and both look like "the assistant is broken". These two checks cost
// one Fastify instance and no cluster: the URL the SPA builds is the URL the
// control plane answers, and an anonymous run is refused as JSON before a stream
// opens.
test('the run URL the SPA builds is the route that is mounted', async () => {
  const app = Fastify();
  await app.register(cookie);
  await app.register(aguiRoutes);
  await app.ready();
  const url = aguiRunPath('https://app.fleet.dev', 'org-1', 'proj-1');
  assert.match(url, /^https:\/\//, 'an absolute URL, because the SPA dials it across the edge');
  const local = url.replace('https://app.fleet.dev', '');
  const res = await app.inject({ method: 'POST', url: local, payload: { threadId: 't', runId: 'r', messages: [] } });
  // Anonymous, so the refusal is 401 — the point is that it is NOT 404: the path
  // exists and the body is the JSON shape the AG-UI client surfaces.
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['content-type'] ?? '', /application\/json/);
  const body = res.json() as { error?: { message?: string; code?: number; reason?: string } };
  assert.equal(body.error?.message, 'unauthenticated');
  assert.equal(body.error?.reason, 'unauthenticated');
  await app.close();
});

test('a body the endpoint cannot read is refused before the conversation is touched', async () => {
  const app = Fastify();
  await app.register(cookie);
  await app.register(aguiRoutes);
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/api/agui/orgs/org-1/projects/proj-1/agent',
    headers: { 'content-type': 'application/octet-stream' },
    body: 'bytes',
  });
  // 415 from Fastify, ahead of auth and of openTurn: a run that cannot be parsed
  // must never re-arm a session row, because that would bill a turn nobody sent.
  assert.equal(res.statusCode, 415);
  assert.ok(!String(res.headers['content-type']).includes('event-stream'), 'no run opened');
  await app.close();
});
