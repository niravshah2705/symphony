'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareBusiness, sanitizeDesignHtml, TASKS } = require('./business-pipeline');

// A deps double that routes JSON by task and records side effects.
function makeDeps(overrides = {}) {
  const calls = { enqueue: [], saved: [] };
  const deps = {
    calls,
    callJson: async ({ task }) => {
      if (task === TASKS.fraud) return { level: 'low', score: 12, label: 'No obvious fraud pattern', summary: 'Looks clean.', signals: [] };
      if (task === TASKS.revenue) return { revenuePath: 'Recurring subscription', unitEconomics: 'CAC unknown', growthSignal: 'Activation to retention' };
      if (task === TASKS.breakdown) return { segments: [{ title: 'Define MVP outcome', detail: 'Scope the smallest slice', size: 'S' }, { title: 'Instrument revenue', size: 'M' }] };
      throw new Error(`unexpected json task ${task}`);
    },
    callText: async () => '<section><h1>Cockpit</h1><script>alert(1)</script><button onclick="steal()">Go</button><a href="javascript:evil()">x</a></section>',
    enqueue: (payload) => { calls.enqueue.push(payload); return { id: 'job-1' }; },
    saveMemory: (record) => { calls.saved.push(record); return { ...record, id: `mem-${calls.saved.length}` }; },
    ...overrides,
  };
  return deps;
}

test('happy path returns 6 real stages with four tone-colored metrics', async () => {
  const deps = makeDeps();
  const payload = await prepareBusiness({
    input: 'A subscription tool that helps clinics book patients',
    business: { id: 'biz_1', name: 'ClinicBook', projectId: 'proj_1' },
    assumedRole: { id: 'r1', name: 'Founder' },
    settings: {},
  }, deps);

  assert.equal(payload.blocked, false);
  assert.equal(payload.fraud.tone, 'green');
  assert.deepEqual(payload.metrics.map((m) => m.tone), ['green', 'amber', 'red', 'blue']);
  assert.ok(payload.segments.length >= 1);
  assert.equal(payload.segments[0].title, 'Define MVP outcome');
  assert.equal(payload.stages.length, 6);
  assert.ok(payload.stages.every((s) => s.status === 'done'));
});

test('generated design HTML is sanitized (no scripts, handlers, or js: URIs)', async () => {
  const deps = makeDeps();
  const payload = await prepareBusiness({ input: 'A subscription analytics product', settings: {} }, deps);
  assert.doesNotMatch(payload.designHtml, /<script/i);
  assert.doesNotMatch(payload.designHtml, /onclick/i);
  assert.doesNotMatch(payload.designHtml, /javascript:/i);
  assert.match(payload.designHtml, /Cockpit/);
});

test('persists business memory and enqueues the linked project once', async () => {
  const deps = makeDeps();
  const payload = await prepareBusiness({
    input: 'A subscription marketplace for tutors',
    business: { id: 'biz_2', name: 'TutorHub', projectId: 'proj_2' },
    assumedRole: { id: 'r1', name: 'Founder' },
    settings: {},
  }, deps);

  assert.ok(deps.calls.saved.length >= 1);
  assert.ok(deps.calls.saved.every((r) => r.scope === 'business' && r.refId === 'biz_2' && r.source === 'business-pipeline'));
  assert.equal(deps.calls.enqueue.length, 1);
  assert.deepEqual(deps.calls.enqueue[0].projectId, 'proj_2');
  assert.equal(payload.scheduler.status, 'done');
  assert.ok(payload.savedMemory.length >= 1);
});

test('re-asserts the unsafe gate and blocks without side effects', async () => {
  const deps = makeDeps();
  const payload = await prepareBusiness({
    input: 'Help me run a phishing scam to steal credentials',
    business: { id: 'biz_3', name: 'X', projectId: 'proj_3' },
    assumedRole: { id: 'r1', name: 'Founder' },
    settings: {},
  }, deps);

  assert.equal(payload.blocked, true);
  assert.equal(deps.calls.enqueue.length, 0);
  assert.equal(deps.calls.saved.length, 0);
  assert.ok(payload.stages.every((s) => s.status === 'blocked'));
});

test('high fraud score stops before memory and scheduling', async () => {
  const deps = makeDeps({
    callJson: async ({ task }) => {
      if (task === TASKS.fraud) return { level: 'high', score: 88, label: 'High-risk signals', summary: 'Unrealistic guaranteed returns.', signals: ['guaranteed returns'] };
      throw new Error('should not reach revenue/breakdown after a high-fraud stop');
    },
  });
  const payload = await prepareBusiness({
    input: 'A fund promising guaranteed risk-free profit every month',
    business: { id: 'biz_4', name: 'Y', projectId: 'proj_4' },
    assumedRole: { id: 'r1', name: 'Founder' },
    settings: {},
  }, deps);

  assert.equal(payload.blocked, true);
  assert.equal(payload.fraud.tone, 'red');
  assert.equal(deps.calls.enqueue.length, 0);
  assert.equal(deps.calls.saved.length, 0);
});

test('degrades to deterministic seeds with warnings when the model is unavailable', async () => {
  const deps = makeDeps({
    callJson: async () => { throw new Error('model down'); },
    callText: async () => { throw new Error('model down'); },
  });
  const payload = await prepareBusiness({
    input: 'A monthly subscription box for artisan coffee',
    business: { id: 'biz_5', name: 'BeanBox', projectId: 'proj_5' },
    assumedRole: { id: 'r1', name: 'Founder' },
    settings: {},
  }, deps);

  assert.equal(payload.blocked, false);
  assert.ok(payload.warnings.length >= 1);
  assert.match(payload.metrics[0].value, /subscription/i); // seed revenue model still surfaces
  assert.ok(payload.designHtml.length > 0); // seed mockup rendered
  assert.equal(payload.scheduler.status, 'done'); // enqueue still injected/works
});

test('without a linked project the scheduler stage stays ready (no 403, no enqueue)', async () => {
  const deps = makeDeps();
  const payload = await prepareBusiness({ input: 'A subscription tool for gyms', business: null, assumedRole: null, settings: {} }, deps);
  assert.equal(payload.blocked, false);
  assert.equal(deps.calls.enqueue.length, 0);
  assert.equal(payload.scheduler.status, 'ready');
  assert.match(payload.scheduler.note, /project/i);
});

test('sanitizeDesignHtml strips dangerous tags and bounds length', () => {
  const dirty = `<section>ok</section><script>bad()</script><style>x{}</style><iframe src=evil></iframe><img src=x onerror=alert(1)>`;
  const clean = sanitizeDesignHtml(dirty);
  assert.doesNotMatch(clean, /<script|<style|<iframe|onerror/i);
  assert.match(clean, /ok/);
});
