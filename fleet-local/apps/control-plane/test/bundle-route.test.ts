import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

process.env.BUNDLE_ENABLED = 'true';
process.env.GCP_PROJECT_ID ??= 'fleet-demo';
process.env.GCP_REGION ??= 'us-central1';
process.env.BUNDLE_REPO ??= 'fleet-bundles';

const { bundleRoutes, bundleGate, bundleCatalog } = await import('../src/routes/bundles.ts');

async function app() {
  const server = Fastify();
  await server.register(cookie);
  await server.register(bundleRoutes);
  await server.ready();
  return server;
}

test('the URLs the SPA dials are the routes that are mounted', async () => {
  const server = await app();
  for (const [method, url] of [
    ['GET', '/api/orgs/org-1/bundles'],
    ['GET', '/api/orgs/org-1/bundles/claude:aaaaaaaaaaaa'],
    ['POST', '/api/orgs/org-1/bundles'],
  ] as const) {
    const res = await server.inject({ method, url, payload: { runtime: 'claude', plugins: ['graphify'] } });
    // Anonymous, so 401 — the point is that it is not 404, and that the refusal is
    // JSON: an event-stream head on a 401 would render as a build that never starts.
    assert.equal(res.statusCode, 401, `${method} ${url}`);
    assert.match(res.headers['content-type'] ?? '', /application\/json/);
    assert.ok(!String(res.headers['content-type']).includes('event-stream'));
  }
  await server.close();
});

test('every reason a run must not start is decided before the stream opens', () => {
  const sel = { runtime: 'claude', plugins: ['graphify'] };
  assert.equal(bundleGate(null, sel)?.status, 404);
  assert.equal(bundleGate({ status: 'offboarding' }, sel)?.status, 409);
  assert.equal(bundleGate({ status: 'deleted' }, sel)?.status, 409);
  assert.equal(bundleGate({ status: 'disabled' }, sel)?.status, 409);
  assert.equal(bundleGate({ status: 'active' }, { runtime: 'nope', plugins: ['graphify'] })?.status, 400);
  assert.equal(bundleGate({ status: 'active' }, sel)?.error, undefined, 'a valid selection on an active org is a run');
});

test('the catalog says what can be built and what a build would not run on', () => {
  const catalog = bundleCatalog();
  assert.ok(catalog.enabled);
  const byRuntime = Object.fromEntries(catalog.bases.map((b) => [b.runtime, b]));
  assert.equal(byRuntime.claude.harnessType, 'claude');
  assert.equal(byRuntime.claude.dispatchable, true);
  assert.equal(byRuntime.qoder.harnessType, 'byo');
  // Risk 2 in the plan: the table builds all ten, but only the runtimes kagent can
  // dispatch are runnable, and the wizard must say so rather than hide them.
  assert.equal(byRuntime.goose.dispatchable, false, 'goose builds but has no in-cluster dispatch path');
  assert.ok(byRuntime.claude.selectable.length > 0, 'claude carries plugin requirements today');
  assert.deepEqual(byRuntime.gemini.selectable, [], 'a runtime with no matrix column offers nothing');
  assert.ok(catalog.packs.some((p) => p.id === 'graphify'));
});
