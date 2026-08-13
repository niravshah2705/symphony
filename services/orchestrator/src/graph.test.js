'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPipelineGraph, routeNextStage } = require('./graph');
const { fakeLangGraph } = require('./fake-langgraph.test-helper');

test('routeNextStage follows only the explicit ordered subset and ignores labels', () => {
  assert.equal(routeNextStage({
    requestedStages: ['plan', 'code', 'test', 'deploy'],
    completedStages: ['plan'],
    runStatus: 'queued',
    labels: ['code', 'skip-deploy'],
  }, { end: '__end__' }), 'code');
  assert.equal(routeNextStage({
    requestedStages: ['plan'],
    completedStages: ['plan'],
    runStatus: 'queued',
    labels: ['deploy'],
  }, { end: '__end__' }), '__end__');
  assert.equal(routeNextStage({
    requestedStages: ['plan', 'code'],
    completedStages: ['plan'],
    runStatus: 'cancelled',
  }, { end: '__end__' }), '__end__');
});

test('routeNextStage refuses a checkpoint that is not a prefix of requestedStages', () => {
  assert.throws(() => routeNextStage({
    requestedStages: ['plan', 'code', 'test'],
    completedStages: ['plan', 'test'],
    runStatus: 'queued',
  }), /checkpoint does not match/);
});

test('the compiled graph has fixed plan/code/test/deploy nodes and conditionally dispatches one stage', async () => {
  const api = fakeLangGraph();
  const dispatched = [];
  const checkpointer = { name: 'durable-checkpointer' };
  const graph = createPipelineGraph({
    langgraph: api,
    checkpointer,
    dispatchStage: async (runId, stage) => {
      dispatched.push({ runId, stage });
      return { commandId: `${runId}:${stage}:1` };
    },
  });

  assert.deepEqual([...graph.builder.nodes.keys()], ['plan', 'code', 'test', 'deploy']);
  assert.equal(graph.builder.conditional.source, api.START);
  assert.deepEqual(graph.builder.conditional.targets, ['plan', 'code', 'test', 'deploy', api.END]);
  assert.deepEqual(graph.builder.compileOptions, { checkpointer });

  const state = await graph.invoke({
    runId: 'run-1',
    requestedStages: ['plan', 'code', 'test'],
    completedStages: ['plan', 'code'],
    runStatus: 'queued',
  });
  assert.deepEqual(dispatched, [{ runId: 'run-1', stage: 'test' }]);
  assert.equal(state.dispatch.commandId, 'run-1:test:1');
});
