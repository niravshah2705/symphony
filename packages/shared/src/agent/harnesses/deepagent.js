'use strict';

/**
 * DeepAgent harness — the provider-neutral LangGraph/`deepagents` execution
 * path. The live agent is built by the framework (framework.js buildAgent) and
 * handed in as `options.deepAgentInvoke`; this executor invokes it and maps the
 * result onto the shared contract.
 */

const registry = require('./registry');
const { AgentRuntimeError, deepAgentUsage, deepAgentCost } = require('./contract');

async function executeDeepAgent(options, prompt) {
  if (typeof options.deepAgentInvoke !== 'function') {
    throw new AgentRuntimeError('DeepAgent runtime was selected without a prepared agent.', 'runtime_not_prepared', 500);
  }
  const result = await options.deepAgentInvoke(prompt, options.invokeConfig || {});
  const messages = (result && result.messages) || [];
  return {
    runtime: 'deepagent',
    provider: options.llm && options.llm.provider,
    model: options.llm && options.llm.model,
    workflowPattern: options.workflowPattern,
    result,
    messages,
    finalText: options.lastText ? options.lastText(result) : '',
    usage: deepAgentUsage(messages),
    costUsd: deepAgentCost(messages),
    sessionId: null,
  };
}

registry.register({
  id: 'deepagent',
  label: 'DeepAgent',
  harnessName: 'deepagent',
  packageName: 'deepagents',
  requiresProvider: null,
  capabilities: { coding: true, planning: true, streaming: true, subagents: true },
  createExecutor: () => executeDeepAgent,
});

module.exports = { executeDeepAgent };
