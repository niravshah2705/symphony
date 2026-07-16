'use strict';

const PATTERNS = Object.freeze([
  Object.freeze({
    id: 'sequential',
    label: 'Sequential',
    description: 'Guide one runtime session through focused steps in a fixed order.',
    summary: 'Guide one runtime session through focused steps in a fixed order.',
    bestFor: 'Predictable work with clear dependencies between stages.',
    steps: Object.freeze(['Understand', 'Act', 'Verify']),
    config: Object.freeze({ field: 'steps', minimum: 2, maximum: 12 }),
  }),
  Object.freeze({
    id: 'parallel',
    label: 'Parallel / fan-out',
    description: 'Guide capable runtimes to split independent investigation, keep writes serialized, and synthesize the result.',
    summary: 'Guide capable runtimes to split independent investigation and synthesize the result.',
    bestFor: 'Research or review work that can be investigated independently inside one runtime session.',
    steps: Object.freeze(['Split', 'Investigate', 'Synthesize']),
    config: Object.freeze({ field: 'branches', minimum: 2, maximum: 8, optional: ['join'] }),
  }),
  Object.freeze({
    id: 'evaluator',
    label: 'Evaluator / retry',
    description: 'Guide one runtime session to produce a candidate, evaluate it, and repair concrete gaps.',
    summary: 'Guide one runtime session to evaluate its own candidate and repair concrete gaps.',
    bestFor: 'Outputs that benefit from an explicit quality pass before validation.',
    steps: Object.freeze(['Generate', 'Evaluate', 'Repair']),
    config: Object.freeze({ required: ['worker', 'evaluator'], maxAttempts: Object.freeze({ minimum: 1, maximum: 5, default: 3 }) }),
  }),
  Object.freeze({
    id: 'supervisor',
    label: 'Supervisor / handoff',
    description: 'Guide capable runtimes to delegate bounded specialist work, review it, and integrate verified results.',
    summary: 'Guide capable runtimes to delegate, review, and integrate bounded specialist work.',
    bestFor: 'Requests that span specialties and benefit from explicit review inside one runtime session.',
    steps: Object.freeze(['Route', 'Review', 'Integrate']),
    config: Object.freeze({ required: ['supervisor', 'specialists'], specialists: Object.freeze({ minimum: 2, maximum: 8 }), maxHandoffs: Object.freeze({ minimum: 1, maximum: 20, default: 6 }) }),
  }),
]);

const IDS = new Set(PATTERNS.map((pattern) => pattern.id));
const ALIASES = Object.freeze({
  'parallel-fan-out': 'parallel',
  'parallel/fan-out': 'parallel',
  'evaluator-retry': 'evaluator',
  'evaluator/retry': 'evaluator',
  'supervisor-handoff': 'supervisor',
  'supervisor/handoff': 'supervisor',
});

function catalog() {
  return PATTERNS.map((pattern) => JSON.parse(JSON.stringify(pattern)));
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function patternId(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return IDS.has(candidate) ? candidate : ALIASES[candidate] || '';
}

function cleanAgent(value, field, errors) {
  if (typeof value !== 'string') {
    errors.push(`${field} must be a short agent or step identifier.`);
    return '';
  }
  const result = value.trim();
  if (!result || result.length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(result)) {
    errors.push(`${field} must be 1–80 characters using letters, numbers, spaces, dot, dash, or underscore.`);
    return '';
  }
  return result;
}

function cleanList(value, field, minimum, maximum, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be a list with ${minimum}–${maximum} entries.`);
    return [];
  }
  if (value.length < minimum || value.length > maximum) {
    errors.push(`${field} must contain ${minimum}–${maximum} entries.`);
  }
  const cleaned = value.slice(0, maximum).map((item, index) => cleanAgent(item, `${field}[${index}]`, errors));
  const usable = cleaned.filter(Boolean);
  if (new Set(usable.map((item) => item.toLowerCase())).size !== usable.length) {
    errors.push(`${field} entries must be unique.`);
  }
  return usable;
}

function boundedConfigInteger(value, field, minimum, maximum, fallback, errors) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    errors.push(`${field} must be an integer from ${minimum} to ${maximum}.`);
    return fallback;
  }
  return number;
}

/**
 * Validate and normalize one supported workflow definition. Only declarative
 * names and bounded counters are accepted; executable code and tool arguments
 * are intentionally outside this catalog.
 */
function validateWorkflowPattern(input) {
  if (!plainObject(input)) {
    return { valid: false, errors: ['A workflow definition object is required.'], workflow: null };
  }
  const id = patternId(input.patternId || input.pattern || input.id);
  if (!id) {
    return { valid: false, errors: ['Choose a supported workflow pattern.'], workflow: null };
  }
  const config = plainObject(input.config) ? input.config : input;
  const errors = [];
  let normalized;

  if (id === 'sequential') {
    normalized = { steps: cleanList(config.steps, 'steps', 2, 12, errors) };
  } else if (id === 'parallel') {
    normalized = { branches: cleanList(config.branches, 'branches', 2, 8, errors) };
    if (config.join !== undefined && config.join !== null && config.join !== '') {
      normalized.join = cleanAgent(config.join, 'join', errors);
    }
  } else if (id === 'evaluator') {
    normalized = {
      worker: cleanAgent(config.worker, 'worker', errors),
      evaluator: cleanAgent(config.evaluator, 'evaluator', errors),
      maxAttempts: boundedConfigInteger(config.maxAttempts, 'maxAttempts', 1, 5, 3, errors),
    };
    if (normalized.worker && normalized.evaluator && normalized.worker.toLowerCase() === normalized.evaluator.toLowerCase()) {
      errors.push('worker and evaluator must be different agents.');
    }
  } else {
    normalized = {
      supervisor: cleanAgent(config.supervisor, 'supervisor', errors),
      specialists: cleanList(config.specialists, 'specialists', 2, 8, errors),
      maxHandoffs: boundedConfigInteger(config.maxHandoffs, 'maxHandoffs', 1, 20, 6, errors),
    };
    if (normalized.supervisor && normalized.specialists.some(
      (specialist) => specialist.toLowerCase() === normalized.supervisor.toLowerCase()
    )) {
      errors.push('supervisor must not also appear in specialists.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    workflow: errors.length ? null : { patternId: id, config: normalized },
  };
}

module.exports = {
  PATTERNS,
  catalog,
  patternId,
  validateWorkflowPattern,
};
