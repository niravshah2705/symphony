'use strict';

const { PIPELINE_STAGES, normalizeRequestedStages } = require('@ai-fleet/shared-core/pipeline/contracts');

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Deterministic router for the fixed control plane. Only requestedStages and
 * the durable completed-stage checkpoint influence routing; issue labels are
 * deliberately absent from this decision.
 */
function routeNextStage(state, { end = '__end__' } = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Pipeline graph state is required.');
  if (TERMINAL_STATUSES.has(state.runStatus)) return end;
  const requestedStages = normalizeRequestedStages(state.requestedStages);
  const completedStages = Array.isArray(state.completedStages) ? state.completedStages : [];
  if (completedStages.length > requestedStages.length) {
    throw new Error('Pipeline checkpoint does not match the requested stage sequence.');
  }
  for (let index = 0; index < completedStages.length; index += 1) {
    if (completedStages[index] !== requestedStages[index]) {
      throw new Error('Pipeline checkpoint does not match the requested stage sequence.');
    }
  }
  return requestedStages[completedStages.length] || end;
}

function loadLangGraph(injected) {
  // Lazy loading keeps contract/repository consumers free of LangGraph. The
  // orchestrator package declares it directly and never imports heavy shared.
  return injected || require('@langchain/langgraph');
}

function createPipelineGraph({ dispatchStage, checkpointer, langgraph } = {}) {
  if (typeof dispatchStage !== 'function') throw new TypeError('dispatchStage is required.');
  const api = loadLangGraph(langgraph);
  const { Annotation, StateGraph, START, END } = api;
  if (!Annotation || typeof Annotation.Root !== 'function' || typeof StateGraph !== 'function') {
    throw new TypeError('A compatible @langchain/langgraph implementation is required.');
  }

  const PipelineState = Annotation.Root({
    runId: Annotation(),
    requestedStages: Annotation(),
    completedStages: Annotation({ default: () => [] }),
    runStatus: Annotation(),
    checkpointRevision: Annotation(),
    dispatch: Annotation(),
  });

  const builder = new StateGraph(PipelineState);
  for (const stage of PIPELINE_STAGES) {
    builder.addNode(stage, async (state) => ({
      dispatch: await dispatchStage(state.runId, stage),
    }));
    builder.addEdge(stage, END);
  }
  builder.addConditionalEdges(
    START,
    (state) => routeNextStage(state, { end: END }),
    [...PIPELINE_STAGES, END],
  );
  return builder.compile(checkpointer ? { checkpointer } : undefined);
}

module.exports = { createPipelineGraph, routeNextStage };
