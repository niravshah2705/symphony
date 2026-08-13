'use strict';

function fakeLangGraph() {
  const START = '__start__';
  const END = '__end__';
  function Annotation() { return {}; }
  Annotation.Root = (spec) => ({ spec });
  class StateGraph {
    constructor(state) {
      this.state = state;
      this.nodes = new Map();
      this.edges = [];
      this.conditional = null;
      this.compileOptions = null;
    }
    addNode(name, handler) { this.nodes.set(name, handler); return this; }
    addEdge(source, target) { this.edges.push([source, target]); return this; }
    addConditionalEdges(source, router, targets) {
      this.conditional = { source, router, targets };
      return this;
    }
    compile(options) {
      this.compileOptions = options;
      return {
        builder: this,
        invoke: async (state) => {
          const target = this.conditional.router(state);
          if (target === END) return state;
          return { ...state, ...await this.nodes.get(target)(state) };
        },
      };
    }
  }
  return { Annotation, StateGraph, START, END };
}

module.exports = { fakeLangGraph };
