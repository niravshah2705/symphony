'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('./pattern-router');

test('resolveAgentPattern prefers explicit, then settings, then cloudrun', () => {
  assert.equal(router.resolveAgentPattern('substrate'), 'substrate');
  assert.equal(router.resolveAgentPattern('', { agentPattern: 'OpenShell' }), 'openshell');
  assert.equal(router.resolveAgentPattern(undefined, {}), 'cloudrun');
});

test('isPlanningStage matches plan workflows and stages only', () => {
  assert.equal(router.isPlanningStage({ stage: 'planning' }), true);
  assert.equal(router.isPlanningStage({ workflow: 'business-plan' }), true);
  assert.equal(router.isPlanningStage({ stage: 'coding', workflow: 'code-writer' }), false);
});

test('substrate + planning diverts to the substrate runner', async () => {
  const calls = [];
  const runner = require('./substrate-runner');
  const orig = runner.runPlanningOnSubstrate;
  runner.runPlanningOnSubstrate = async (opts) => { calls.push(opts); return { finalText: 'plan-json', messages: [] }; };
  try {
    const res = await router.dispatchPlanning({
      agentPattern: 'substrate', stage: 'planning', prompt: 'make a plan',
      organizationId: 'org-1', projectId: 'proj-1', settings: { guardrailSpec: { egress: { allowHosts: ['x'] } } },
    });
    assert.equal(res.finalText, 'plan-json');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].organizationId, 'org-1');
  } finally {
    runner.runPlanningOnSubstrate = orig;
  }
});

test('cloudrun falls through to executeAgentRuntime untouched', async () => {  const dispatch = require('./harnesses/dispatch');
  // executeAgentRuntime is built via a factory; assert the router does NOT call the
  // substrate path for cloudrun by ensuring runPlanningOnSubstrate is never reached.
  const runner = require('./substrate-runner');
  let touched = false;
  const orig = runner.runPlanningOnSubstrate;
  runner.runPlanningOnSubstrate = async () => { touched = true; return {}; };
  try {
    // With no registered runtime this will throw from the dispatcher, but only AFTER
    // proving the substrate branch was skipped.
    await router.dispatchPlanning({ agentPattern: 'cloudrun', stage: 'planning', runtime: 'deepagent', llm: {}, prompt: 'x' }).catch(() => {});
    assert.equal(touched, false);
  } finally {
    runner.runPlanningOnSubstrate = orig;
    void dispatch;
  }
});

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

// The substrate actor is a separate process, so the trace id has to be handed to
// it explicitly — and the caller knows it from a different place depending on how
// the run started (an HTTP request, a stage command, or a Cloud Run job env).
async function traceparentFor(options, env = {}) {
  const runner = require('./substrate-runner');
  const orig = runner.runPlanningOnSubstrate;
  const calls = [];
  const saved = { ...env };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  runner.runPlanningOnSubstrate = async (opts) => { calls.push(opts); return { finalText: 'p', messages: [] }; };
  try {
    await router.dispatchPlanning({
      agentPattern: 'substrate',
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
