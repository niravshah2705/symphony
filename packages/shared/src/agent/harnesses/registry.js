'use strict';

/**
 * Pluggable harness registry. Every operational harness is described by one
 * complete, immutable HarnessDefinition:
 *
 *   {
 *     id,                 // canonical lowercase runtime id
 *     label,              // operator-facing label
 *     harnessName,        // short trace/UI name
 *     packageName,        // backing SDK/package diagnostic
 *     requiresProvider,   // required LLM provider, or null
 *     availability,       // "available" for an executable definition
 *     capabilities,       // stage ids plus optional streaming/subagents
 *     stages,             // technically executable pipeline stages
 *     brokeredStages,     // stages executable when private broker tools apply
 *     createExecutor(deps) -> async (options, prompt) => result
 *   }
 *
 * The singleton is sealed by ./index after built-in bootstrap. That boundary is
 * important: the legacy RUNTIMES/HARNESS_LABELS snapshots and runtimeCatalog()
 * must always describe the same fixed set of executable harnesses.
 */

const { AgentRuntimeError } = require('./contract');
const { enforceHarness } = require('../settings-policy');

const STAGES = Object.freeze(['planning', 'coding', 'testing', 'deployment']);
const CAPABILITIES = Object.freeze([...STAGES, 'streaming', 'subagents']);
const AVAILABILITY = Object.freeze(['available', 'experimental', 'unavailable']);
const DEFAULT_BROKERED_STAGES = Object.freeze(['coding', 'deployment']);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

// Keep the SDK-heavy registry metadata identical to the SDK-free catalog used
// by gateway/settings preflight.
const HARNESS_CATALOG = require('@ai-fleet/shared-core/agent/harness-catalog.json');

function schemaError(message) {
  const error = new TypeError(`Invalid harness definition: ${message}`);
  error.code = 'invalid_harness_definition';
  return error;
}

function requiredString(definition, key, { pattern } = {}) {
  if (!Object.prototype.hasOwnProperty.call(definition, key)) {
    throw schemaError(`"${key}" is required.`);
  }
  const value = definition[key];
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw schemaError(`"${key}" must be a non-empty, trimmed string.`);
  }
  if (pattern && !pattern.test(value)) {
    throw schemaError(`"${key}" must use its canonical lowercase form.`);
  }
  return value;
}

function enumList(definition, key, allowed, { nonEmpty = false, subsetOf = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(definition, key) || !Array.isArray(definition[key])) {
    throw schemaError(`"${key}" must be an array.`);
  }
  const values = definition[key];
  if (nonEmpty && values.length === 0) throw schemaError(`"${key}" must not be empty.`);
  if (new Set(values).size !== values.length) throw schemaError(`"${key}" must not contain duplicates.`);
  for (const value of values) {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw schemaError(`"${key}" contains unsupported value "${String(value)}".`);
    }
    if (subsetOf && !subsetOf.includes(value)) {
      throw schemaError(`"${key}" value "${value}" must also be present in "stages".`);
    }
  }
  return Object.freeze([...values]);
}

/** Validate and clone a definition so callers cannot mutate registered state. */
function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw schemaError('a definition object is required.');
  }

  const id = requiredString(definition, 'id', { pattern: ID_RE });
  const label = requiredString(definition, 'label');
  const harnessName = requiredString(definition, 'harnessName', { pattern: NAME_RE });
  const packageName = requiredString(definition, 'packageName');
  if (!Object.prototype.hasOwnProperty.call(definition, 'requiresProvider')) {
    throw schemaError('"requiresProvider" is required (use null for provider-neutral harnesses).');
  }
  const requiresProvider = definition.requiresProvider;
  if (requiresProvider !== null && (
    typeof requiresProvider !== 'string'
    || !requiresProvider
    || requiresProvider !== requiresProvider.trim()
    || !NAME_RE.test(requiresProvider)
  )) {
    throw schemaError('"requiresProvider" must be null or a canonical lowercase provider id.');
  }

  const availability = requiredString(definition, 'availability', { pattern: NAME_RE });
  if (!AVAILABILITY.includes(availability)) {
    throw schemaError(`"availability" must be one of: ${AVAILABILITY.join(', ')}.`);
  }
  if (availability !== 'available') {
    throw schemaError(`harness "${id}" is ${availability} and cannot be registered for execution.`);
  }

  const stages = enumList(definition, 'stages', STAGES, { nonEmpty: true });
  const capabilities = enumList(definition, 'capabilities', CAPABILITIES, { nonEmpty: true });
  for (const stage of stages) {
    if (!capabilities.includes(stage)) {
      throw schemaError(`stage "${stage}" must also be present in "capabilities".`);
    }
  }
  for (const capability of capabilities) {
    if (STAGES.includes(capability) && !stages.includes(capability)) {
      throw schemaError(`stage capability "${capability}" must also be present in "stages".`);
    }
  }
  const brokeredStages = enumList(definition, 'brokeredStages', STAGES, { subsetOf: stages });
  if (typeof definition.createExecutor !== 'function') {
    throw schemaError(`harness "${id}" must supply a createExecutor factory.`);
  }

  return Object.freeze({
    id,
    label,
    harnessName,
    packageName,
    requiresProvider,
    availability,
    capabilities,
    stages,
    brokeredStages,
    createExecutor: definition.createExecutor,
  });
}

/**
 * Combine one available entry from the shared metadata catalog with its local
 * executor factory. Experimental catalog entries deliberately have no runtime
 * registration until an implementation graduates to "available".
 */
function builtinDefinition(id, createExecutor) {
  const catalog = HARNESS_CATALOG && Array.isArray(HARNESS_CATALOG.harnesses)
    ? HARNESS_CATALOG.harnesses
    : [];
  const metadata = catalog.find((entry) => entry && entry.id === id);
  if (!metadata) throw schemaError(`built-in harness "${id}" is missing from the shared catalog.`);
  return { ...metadata, createExecutor };
}

function createHarnessRegistry() {
  /** id -> frozen HarnessDefinition; insertion order is catalog order. */
  const definitions = new Map();
  let sealed = false;

  function register(input) {
    if (sealed) {
      const error = new Error('Harness registry is sealed; definitions must be registered during bootstrap.');
      error.code = 'harness_registry_sealed';
      throw error;
    }
    const definition = validateDefinition(input);
    if (definitions.has(definition.id)) {
      const error = new Error(`Harness "${definition.id}" is already registered.`);
      error.code = 'duplicate_harness_definition';
      throw error;
    }
    definitions.set(definition.id, definition);
    return definition.id;
  }

  function get(id) {
    return definitions.get(id) || null;
  }

  function has(id) {
    return definitions.has(id);
  }

  function list() {
    return Object.freeze([...definitions.values()]);
  }

  function ids() {
    return Object.freeze([...definitions.keys()]);
  }

  /** [{ id, label }] in registration order — the Settings/harness catalog. */
  function runtimeCatalog() {
    return Object.freeze(list().map(({ id, label }) => Object.freeze({ id, label })));
  }

  function seal() {
    sealed = true;
    return api;
  }

  function isSealed() {
    return sealed;
  }

  /** Friendly trace/UI harness name; unknown ids retain the legacy passthrough. */
  function harnessLabel(runtime) {
    const definition = definitions.get(runtime);
    return (definition && definition.harnessName) || runtime;
  }

  function normalizeAgentRuntime(value, { strict = false } = {}) {
    const id = String(value || 'deepagent').trim().toLowerCase();
    if (definitions.has(id)) return id;
    if (strict) {
      throw new AgentRuntimeError(
        `Agent runtime must be one of: ${ids().join(', ')}.`,
        'invalid_agent_runtime',
        400
      );
    }
    return definitions.has('deepagent') ? 'deepagent' : (ids()[0] || 'deepagent');
  }

  function resolveStage(workflow, explicitStage) {
    if (explicitStage !== undefined && explicitStage !== null && explicitStage !== '') {
      const stage = String(explicitStage).trim().toLowerCase();
      if (!STAGES.includes(stage)) {
        throw new AgentRuntimeError(
          `Agent stage must be one of: ${STAGES.join(', ')}.`,
          'invalid_agent_stage',
          400
        );
      }
      return stage;
    }
    // Workflows outside the fixed business pipeline remain runnable. Only a
    // canonical pipeline workflow name activates stage capability enforcement.
    const inferred = String(workflow || '').trim().toLowerCase();
    return STAGES.includes(inferred) ? inferred : null;
  }

  function stageNeedsBroker(stage, brokered) {
    if (!stage) return false;
    if (brokered === true || brokered === false) return brokered;
    return DEFAULT_BROKERED_STAGES.includes(stage);
  }

  /** Resolve provider/stage constraints and return the reason for any fallback. */
  function resolveAgentRuntime(value, llm, {
    strict = false,
    workflow = '',
    stage: explicitStage,
    brokered,
    effectivePolicy = null,
  } = {}) {
    const requestedRuntime = normalizeAgentRuntime(value, { strict });
    const definition = definitions.get(requestedRuntime);
    const provider = llm && llm.provider;
    const stage = resolveStage(workflow, explicitStage);
    const brokerRequired = stageNeedsBroker(stage, brokered);
    let runtime = requestedRuntime;
    let fallbackReason = null;

    if (definition && definition.requiresProvider && definition.requiresProvider !== provider) {
      runtime = 'deepagent';
      fallbackReason = 'provider_mismatch';
    } else if (definition && stage && !definition.stages.includes(stage)) {
      runtime = 'deepagent';
      fallbackReason = 'stage_unsupported';
    } else if (definition && brokerRequired && !definition.brokeredStages.includes(stage)) {
      runtime = 'deepagent';
      // Keep the legacy coding trace annotation stable; other stages use the
      // generalized reason introduced with stage-aware dispatch.
      fallbackReason = stage === 'coding' ? 'workflow_requires_broker' : 'stage_requires_broker';
    }

    runtime = enforceHarness(runtime, effectivePolicy);
    return Object.freeze({
      requestedRuntime,
      runtime,
      stage,
      brokered: brokerRequired,
      fallbackReason: requestedRuntime === runtime ? null : fallbackReason,
    });
  }

  function effectiveAgentRuntime(value, llm, options = {}) {
    return resolveAgentRuntime(value, llm, options).runtime;
  }

  const api = {
    register,
    get,
    has,
    list,
    ids,
    runtimeCatalog,
    seal,
    isSealed,
    harnessLabel,
    normalizeAgentRuntime,
    resolveAgentRuntime,
    effectiveAgentRuntime,
  };
  return Object.freeze(api);
}

const registry = createHarnessRegistry();

module.exports = Object.freeze({
  ...registry,
  STAGES,
  CAPABILITIES,
  AVAILABILITY,
  DEFAULT_BROKERED_STAGES,
  validateDefinition,
  builtinDefinition,
  createHarnessRegistry,
});
