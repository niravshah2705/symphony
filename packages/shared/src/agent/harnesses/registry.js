'use strict';

/**
 * Pluggable harness registry — replaces the frozen RUNTIMES/EXECUTORS tables in
 * the old runtimes.js. Each harness module self-registers a HarnessDefinition:
 *
 *   {
 *     id,                 // canonical runtime id (e.g. 'codex-sdk')
 *     label,              // operator-facing label (e.g. 'Codex SDK')
 *     harnessName,        // short trace/UI name (e.g. 'codex')
 *     packageName,        // npm package the executor lazy-loads (diagnostics)
 *     requiresProvider,   // provider the LLM slot must match, or null (neutral)
 *     capabilities,       // { coding, planning, streaming, subagents } (advisory)
 *     stages,             // pipeline stages this harness may run (default: all)
 *     createExecutor(deps) -> async (options, prompt) => result
 *   }
 *
 * Registration order is preserved (Map insertion order) so runtimeCatalog()
 * yields the built-ins in a stable, canonical sequence.
 *
 * Requires ./contract (AgentRuntimeError) and ../settings-policy (enforceHarness).
 * MUST NOT be required by ./contract (that would cycle).
 */

const { AgentRuntimeError } = require('./contract');
const { enforceHarness } = require('../settings-policy');

/** id -> frozen HarnessDefinition. Mutable so harness modules can register. */
const REGISTRY = new Map();

function register(definition) {
  if (!definition || typeof definition !== 'object' || !definition.id) {
    throw new Error('A harness definition requires an id.');
  }
  if (typeof definition.createExecutor !== 'function') {
    throw new Error(`Harness "${definition.id}" must supply a createExecutor factory.`);
  }
  REGISTRY.set(definition.id, Object.freeze({ ...definition }));
  return definition.id;
}

function get(id) {
  return REGISTRY.get(id) || null;
}

function has(id) {
  return REGISTRY.has(id);
}

function list() {
  return [...REGISTRY.values()];
}

function ids() {
  return [...REGISTRY.keys()];
}

/** [{ id, label }] in registration order — the Settings/harness catalog. */
function runtimeCatalog() {
  return list().map(({ id, label }) => ({ id, label }));
}

/**
 * Short, operator-facing "harness" name for a runtime id (the value surfaced on
 * LangSmith traces as the `harness:` tag and in the Settings UI). Falls back to
 * the id itself for an unregistered value.
 */
function harnessLabel(runtime) {
  const definition = REGISTRY.get(runtime);
  return (definition && definition.harnessName) || runtime;
}

function normalizeAgentRuntime(value, { strict = false } = {}) {
  const id = String(value || 'deepagent').trim().toLowerCase();
  if (REGISTRY.has(id)) return id;
  if (strict) {
    throw new AgentRuntimeError(
      `Agent runtime must be one of: ${ids().join(', ')}.`,
      'invalid_agent_runtime',
      400
    );
  }
  return 'deepagent';
}

/**
 * A global SDK preference must not break roles routed to another provider
 * (notably XS/local coder tasks), and the unattended coding workflow requires
 * the private Linear + scoped repository-broker tools that official SDK
 * subprocesses never receive — so keep coding on the prepared DeepAgent path.
 * Then apply settings-service ENFORCEMENT: if the resolved harness is excluded
 * by the caller's effective policy, `enforceHarness` fails closed (absent
 * policy → unchanged / allow-all).
 */
function effectiveAgentRuntime(value, llm, { strict = false, workflow = '', effectivePolicy = null } = {}) {
  const runtime = normalizeAgentRuntime(value, { strict });
  const provider = llm && llm.provider;
  const definition = REGISTRY.get(runtime);
  let resolved = runtime;
  if (workflow === 'coding' && runtime !== 'deepagent') {
    resolved = 'deepagent';
  } else if (definition && definition.requiresProvider && definition.requiresProvider !== provider) {
    resolved = 'deepagent';
  }
  return enforceHarness(resolved, effectivePolicy);
}

module.exports = {
  register,
  get,
  has,
  list,
  ids,
  runtimeCatalog,
  harnessLabel,
  normalizeAgentRuntime,
  effectiveAgentRuntime,
};
