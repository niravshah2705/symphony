'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('./pattern-router');

test('dispatchPlanning always routes to the substrate runner', async () => {
  const calls = [];
  const runner = require('./substrate-runner');
  const orig = runner.runPlanningOnSubstrate;
  runner.runPlanningOnSubstrate = async (opts) => { calls.push(opts); return { finalText: 'plan-json', messages: [] }; };
  try {
    const res = await router.dispatchPlanning({
      stage: 'planning', prompt: 'make a plan',
      organizationId: 'org-1', projectId: 'proj-1', settings: { guardrailSpec: { egress: { allowHosts: ['x'] } } },
    });
    assert.equal(res.finalText, 'plan-json');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].organizationId, 'org-1');
  } finally {
    runner.runPlanningOnSubstrate = orig;
  }
});

test('the retired cloudrun pattern is ignored and still dispatches to substrate', async () => {
  const runner = require('./substrate-runner');
  const calls = [];
  const orig = runner.runPlanningOnSubstrate;
  runner.runPlanningOnSubstrate = async (opts) => { calls.push(opts); return { finalText: 'p', messages: [] }; };
  try {
    await router.dispatchPlanning({ agentPattern: 'cloudrun', stage: 'planning', prompt: 'x', organizationId: 'org-1' });
    assert.equal(calls.length, 1);
  } finally {
    runner.runPlanningOnSubstrate = orig;
  }
});

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

// The substrate actor is a separate process, so the trace id has to be handed to
// it explicitly — and the caller knows it from a different place depending on how
// the run started (an HTTP request, a stage command, or a job env).
async function traceparentFor(options, env = {}) {
  const runner = require('./substrate-runner');
  const orig = runner.runPlanningOnSubstrate;
  const calls = [];
  const saved = { ...env };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  runner.runPlanningOnSubstrate = async (opts) => { calls.push(opts); return { finalText: 'p', messages: [] }; };
  try {
    await router.dispatchPlanning({
      stage: 'planning',
      prompt: 'x',
      organizationId: 'org-1',
      ...options,
    });
    return calls[0].traceContext.traceparent;
  } finally {
    runner.runPlanningOnSubstrate = orig;
    for (const key of Object.keys(saved)) delete process.env[key];
  }
}

test('substrate dispatch carries the traceparent from the caller, the ctx, or the job env', async () => {
  assert.equal(await traceparentFor({ traceparent: TP }), TP);
  assert.equal(await traceparentFor({ ctx: { traceparent: TP } }), TP);
  assert.equal(await traceparentFor({}, { TRACEPARENT_INBOUND: TP }), TP);
  // An explicit value beats an ambient one: the caller knows whose request this is.
  assert.equal(await traceparentFor(
    { traceparent: TP, ctx: { traceparent: '00-11111111111111111111111111111111-00f067aa0ba902b7-01' } },
    { TRACEPARENT_INBOUND: '00-22222222222222222222222222222222-00f067aa0ba902b7-01' },
  ), TP);
});

test('substrate dispatch sends no traceparent rather than a malformed one', async () => {
  assert.equal(await traceparentFor({ traceparent: 'attacker-controlled' }), null);
  assert.equal(await traceparentFor({ traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' }), null);
  assert.equal(await traceparentFor({}, { TRACEPARENT_INBOUND: 'junk' }), null);
  assert.equal(await traceparentFor({}), null);
});
