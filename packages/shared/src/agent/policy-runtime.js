'use strict';

const {
  enforceModel,
  hasDomain,
  PolicyDeniedError,
  isPolicyDeniedError,
} = require('./settings-policy');
const { publicCatalog } = require('./model-presets');

/**
 * Enforce a resolved models policy without changing provider credentials or
 * transport settings. A denied catalog model is replaced only by an allowed
 * preset from the same provider. Once models are governed, unknown/custom
 * models and policies with no viable same-provider option fail closed.
 */
function enforceLlmModel(llm, effectivePolicy, catalog = publicCatalog()) {
  if (!hasDomain(effectivePolicy, 'models')) return llm;
  if (!llm || !llm.provider || !llm.model) throw new PolicyDeniedError('model');
  const presets = Array.isArray(catalog) ? catalog : (catalog && catalog.presets) || [];
  const current = presets.find((preset) => preset.provider === llm.provider && preset.model === llm.model);
  if (!current) throw new PolicyDeniedError('model', llm.model);

  const candidates = presets
    .filter((preset) => preset.provider === llm.provider)
    .map((preset) => preset.id);
  const allowedId = enforceModel(current.id, effectivePolicy, { candidates });
  if (allowedId === current.id) return llm;

  const replacement = presets.find((preset) => preset.id === allowedId);
  if (!replacement || replacement.provider !== llm.provider) {
    throw new PolicyDeniedError('model', llm.model);
  }
  return { ...llm, model: replacement.model };
}

/**
 * Per-pipeline-stage harness-override pref key. A scope may set ONE default
 * harness (`agentRuntime`, "the org's one harness does everything") and,
 * optionally, a per-stage override. Keyed by the workflow/stage name each
 * service runs under: planner→planning, coder→coding, tester→testing,
 * deployer→deployment. Keep in sync with the settings service PREF_KEYS
 * (services/settings/app/models/policy.py).
 */
const STAGE_HARNESS_PREF = Object.freeze({
  planning: 'planHarness',
  coding: 'codeHarness',
  testing: 'testHarness',
  deployment: 'deployHarness',
});

/**
 * Pick the harness id for a pipeline stage by precedence:
 *   explicit per-request selection → per-stage pref → scope default
 *   (`agentRuntime`) → provided default → 'deepagent'.
 *
 * This is a PURE picker: it does NOT normalize or enforce. Governance stays at
 * the single existing enforcement point — `effectiveAgentRuntime`/`enforceHarness`
 * inside `executeAgentRuntime` (and the gateway preflight, which asks the
 * settings service). Returns a trimmed id string.
 */
function resolveHarnessForStage(stage, { requestSelection, prefs = {}, defaultHarness } = {}) {
  const source = prefs || {};
  const stageKey = STAGE_HARNESS_PREF[stage];
  const trimmed = (value) => {
    const id = typeof value === 'string' ? value.trim() : '';
    return id || null;
  };
  return (
    trimmed(requestSelection) ||
    (stageKey && trimmed(source[stageKey])) ||
    trimmed(source.agentRuntime) ||
    trimmed(defaultHarness) ||
    'deepagent'
  );
}

/**
 * Apply the non-secret operational preferences that affect an already-resolved
 * planner/coder run. Values arrive from the settings service as strings.
 * Missing preferences preserve the process-local defaults.
 */
function applyOperationalPrefs(keys, prefs, step = () => {}) {
  const source = prefs || {};
  const next = { ...(keys || {}) };
  if (source.agentRuntime && source.agentRuntime !== next.agentRuntime) {
    step(`Agent runtime "${source.agentRuntime}" applied from organization settings.`);
    next.agentRuntime = source.agentRuntime;
  }
  // Carry per-stage harness overrides through onto the run keys so each stage's
  // dispatch can pass them to resolveHarnessForStage. Absent keys are untouched,
  // so a run with no per-stage override behaves exactly as before (agentRuntime).
  for (const stageKey of Object.values(STAGE_HARNESS_PREF)) {
    if (source[stageKey] && source[stageKey] !== next[stageKey]) {
      step(`Stage harness "${source[stageKey]}" applied from organization settings (${stageKey}).`);
      next[stageKey] = source[stageKey];
    }
  }
  if (source.workflowPattern && source.workflowPattern !== next.workflowPattern) {
    step(`Workflow pattern "${source.workflowPattern}" applied from organization settings.`);
    next.workflowPattern = source.workflowPattern;
  }
  if (source.langsmithTracing === 'true' || source.langsmithTracing === 'false') {
    next.langsmithTracing = source.langsmithTracing === 'true';
  }
  return next;
}

module.exports = {
  enforceLlmModel,
  applyOperationalPrefs,
  resolveHarnessForStage,
  STAGE_HARNESS_PREF,
  PolicyDeniedError,
  isPolicyDeniedError,
};
