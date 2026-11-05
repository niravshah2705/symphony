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

test('cloudrun falls through to executeAgentRuntime untouched', async () => {
  const dispatch = require('./harnesses/dispatch');
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
