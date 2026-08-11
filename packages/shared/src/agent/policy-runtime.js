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
  PolicyDeniedError,
  isPolicyDeniedError,
};
