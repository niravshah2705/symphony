'use strict';

/**
 * Harness barrel — requiring this module registers every built-in harness (in
 * canonical order) and re-exports the exact public surface the old
 * `runtimes.js` exposed, so `../runtimes` can be a thin shim over it and every
 * existing importer keeps working with zero call-site churn.
 *
 * Registration order defines runtimeCatalog() order — keep it stable:
 *   deepagent, codex-sdk, claude-agent-sdk, antigravity-sdk
 */

const registry = require('./registry');
const contract = require('./contract');
const { executeAgentRuntime } = require('./dispatch');

// Requiring each executor module runs its registry.register(...) side effect.
require('./deepagent');
const { executeCodex } = require('./codex');
const { executeClaude, claudePermissionGuard } = require('./claude');
require('./antigravity');
void executeCodex; void executeClaude; // referenced for clarity; registered via side effect

// Bootstrap is now complete. No later registration may make the live registry
// disagree with the legacy compatibility snapshots constructed below.
registry.seal();
const definitions = registry.list();

/**
 * Back-compat shape of the old frozen RUNTIMES map (id -> { id, label,
 * packageName }), derived from the live registry so it never drifts.
 */
const RUNTIMES = Object.freeze(Object.fromEntries(
  definitions.map((definition) => [definition.id, Object.freeze({
    id: definition.id,
    label: definition.label,
    packageName: definition.packageName,
  })])
));

/** Back-compat id -> friendly harness name map. */
const HARNESS_LABELS = Object.freeze(Object.fromEntries(
  definitions.map((definition) => [definition.id, definition.harnessName])
));

module.exports = {
  // Registry handle for new code (pluggable harnesses).
  registry,
  // --- Back-compat surface (identical to the old runtimes.js exports) --------
  RUNTIMES,
  HARNESS_LABELS,
  harnessLabel: registry.harnessLabel,
  WORKFLOW_PATTERNS: contract.WORKFLOW_PATTERNS,
  AgentRuntimeError: contract.AgentRuntimeError,
  normalizeAgentRuntime: registry.normalizeAgentRuntime,
  effectiveAgentRuntime: registry.effectiveAgentRuntime,
  normalizeWorkflowPattern: contract.normalizeWorkflowPattern,
  runtimeCatalog: registry.runtimeCatalog,
  workflowPatternCatalog: contract.workflowPatternCatalog,
  applyWorkflowPattern: contract.applyWorkflowPattern,
  normalizeUsage: contract.normalizeUsage,
  deepAgentUsage: contract.deepAgentUsage,
  plannerWebSearchAllowed: contract.plannerWebSearchAllowed,
  executeAgentRuntime,
  claudePermissionGuard,
  extractUsedResources: contract.extractUsedResources,
  usedResourceMetadata: contract.usedResourceMetadata,
};
