'use strict';

/**
 * Global discovery-question bank: the questions an architecture/discovery agent
 * should ask about an organisation, a person, and a project.
 *
 * This module is PURE — no I/O, no LLM, no store, no clock. It owns the bank
 * shape, the org overlay merge, input validation, and the deterministic coverage
 * score. Reading the store and running recall lives in coverage-service.js.
 *
 * Two invariants worth knowing before editing:
 *
 *  1. The 80 platform defaults are NOT copied into the store. The store holds
 *     only this org's overrides, and `mergeBank` layers them at read time, so
 *     shipping a new bank revision adds questions without a migration.
 *  2. A default question is deactivated with a tombstone (`active: false`), never
 *     deleted from the override list — a deleted row would let the next revision
 *     silently resurrect it.
 */

const DEFAULT_BANK = require('@ai-fleet/shared-core/global-questions-defaults.json');

const CATEGORIES = Object.freeze(['organisation', 'person', 'project_business']);
const ANSWER_TYPES = Object.freeze(['free_text', 'choice', 'multi_choice', 'number', 'boolean']);
const ORIGINS = Object.freeze(['default', 'customised', 'custom']);

const MAX_QUESTION_CHARS = 600;
const MAX_WHY_CHARS = 600;
const MAX_CHOICES = 10;
const MAX_CHOICE_CHARS = 120;
const MAX_CUSTOM_QUESTIONS = 200;
const MAX_ID_CHARS = 80;

// Question categories vs memory scopes do not line up: MEMORY_SCOPES is
// ['user','business','project','task','workspace'] (see agent/memory.js) and has
// no organisation/person concept. This frozen bridge is the deliberate mapping —
// a hit in an expected scope counts full credit, an off-scope hit is discounted
// rather than discarded, because discovery facts do land in adjacent scopes.
const EXPECTED_SCOPES = Object.freeze({
  organisation: Object.freeze(['business', 'workspace']),
  person: Object.freeze(['user']),
  project_business: Object.freeze(['business', 'project']),
});

// Weighted mean: business/technical fit drives the architecture most, so its
// gaps matter more than an equal gap in the softer categories.
const CATEGORY_WEIGHTS = Object.freeze({
  organisation: 1.0,
  person: 1.0,
  project_business: 1.25,
});

const STATUS_THRESHOLDS = Object.freeze({ covered: 70, partial: 30, gap: 1 });

class QuestionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'QuestionError';
    this.status = status;
  }
}

function trim(value, max, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) throw new QuestionError(`${label} must be at most ${max} characters.`);
  return text;
}

function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_CHARS && /^gq_[a-z0-9_]+$/i.test(id);
}

/** The shipped platform defaults, defensively ordered and frozen per call site. */
function defaultBank() {
  return DEFAULT_BANK.questions.map((row) => ({ ...row, origin: 'default', active: true }));
}

/**
 * Layer an org's overrides over the platform defaults.
 *
 * - A default id present in `overrides` becomes `origin: 'customised'`.
 * - `active: false` on such a row is the tombstone that hides the default.
 * - A non-default id is an org-authored `custom` row.
 * - Unknown ids in `overrides` that look like default ids but no longer exist in
 *   the bank are dropped, so a removed default does not linger forever.
 *
 * @param {Array} overrides org rows from the store
 * @returns {Array} merged questions ordered by category, then order, then id
 */
function mergeBank(overrides = []) {
  const rows = Array.isArray(overrides) ? overrides : [];
  const byId = new Map();
  for (const row of rows) {
    if (row && typeof row === 'object' && typeof row.id === 'string') byId.set(row.id, row);
  }
  const defaultIds = new Set(DEFAULT_BANK.questions.map((row) => row.id));

  const merged = DEFAULT_BANK.questions.map((template) => {
    const override = byId.get(template.id);
    if (!override) return { ...template, origin: 'default', active: true };
    const { id, origin, createdAt, ...patch } = override;
    return {
      ...template,
      ...patch,
      id: template.id,
      // A tombstone must not change the category/sub-dimension of a default row;
      // those drive grouping, and a stray patch would orphan the question.
      category: template.category,
      subDimension: template.subDimension,
      origin: 'customised',
      active: override.active === false ? false : override.active !== false,
    };
  });

  const custom = rows
    .filter((row) => row && typeof row.id === 'string' && !defaultIds.has(row.id))
    .map((row) => normalizeQuestion({ ...row, origin: 'custom' }));

  return [...merged, ...custom].sort(
    (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)),
  );
}

/** Validate + normalise one authored question. Throws QuestionError on bad input. */
function normalizeQuestion(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const category = CATEGORIES.includes(source.category) ? source.category : null;
  if (!category) throw new QuestionError(`category must be one of: ${CATEGORIES.join(', ')}.`);

  const subDimension = trim(source.subDimension, 60, 'subDimension');
  if (!subDimension) throw new QuestionError('subDimension is required.');

  const question = trim(source.question, MAX_QUESTION_CHARS, 'question');
  if (!question) throw new QuestionError('question is required.');

  const whyItMatters = trim(source.whyItMatters, MAX_WHY_CHARS, 'whyItMatters');

  const answerType = ANSWER_TYPES.includes(source.answerType) ? source.answerType : 'free_text';

  const rawChoices = Array.isArray(source.choices) ? source.choices : [];
  if (rawChoices.length > MAX_CHOICES) throw new QuestionError(`choices must have at most ${MAX_CHOICES} entries.`);
  const choices = rawChoices.map((choice, index) => {
    const text = trim(choice, MAX_CHOICE_CHARS, `choices[${index}]`);
    if (!text) throw new QuestionError(`choices[${index}] must not be empty.`);
    return text;
  });
  const needsChoices = answerType === 'choice' || answerType === 'multi_choice';
  if (needsChoices && choices.length < 2) {
    throw new QuestionError(`${answerType} questions need at least two choices.`);
  }
  if (!needsChoices && choices.length) {
    throw new QuestionError(`answerType "${answerType}" must not carry choices.`);
  }

  const order = Number.isFinite(Number(source.order)) ? Math.max(0, Math.round(Number(source.order))) : 0;
  const origin = ORIGINS.includes(source.origin) ? source.origin : 'custom';

  return {
    id: source.id && isValidId(source.id) ? source.id : `gq_custom_${randomId()}`,
    category,
    subDimension,
    order,
    question,
    whyItMatters,
    answerType,
    choices,
    active: source.active !== false,
    origin,
    revision: Number.isFinite(Number(source.revision)) ? Math.max(1, Math.round(Number(source.revision))) : 1,
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy.slice(0, 200) : '',
  };
}

/**
 * Validate a PATCH of an existing question. Only the listed editable fields are
 * carried; id/category/order identity comes from the row being patched, so an
 * admin cannot re-file a default question into another category by accident.
 */
function validateQuestionPatch(input = {}, existing = null) {
  const source = input && typeof input === 'object' ? input : {};
  const patch = {};

  if (source.question !== undefined) {
    const text = trim(source.question, MAX_QUESTION_CHARS, 'question');
    if (!text) throw new QuestionError('question must not be empty.');
    patch.question = text;
  }
  if (source.whyItMatters !== undefined) patch.whyItMatters = trim(source.whyItMatters, MAX_WHY_CHARS, 'whyItMatters');
  if (source.answerType !== undefined) {
    if (!ANSWER_TYPES.includes(source.answerType)) throw new QuestionError(`answerType must be one of: ${ANSWER_TYPES.join(', ')}.`);
    patch.answerType = source.answerType;
  }
  if (source.choices !== undefined) {
    const raw = Array.isArray(source.choices) ? source.choices : [];
    if (raw.length > MAX_CHOICES) throw new QuestionError(`choices must have at most ${MAX_CHOICES} entries.`);
    patch.choices = raw.map((choice, index) => {
      const text = trim(choice, MAX_CHOICE_CHARS, `choices[${index}]`);
      if (!text) throw new QuestionError(`choices[${index}] must not be empty.`);
      return text;
    });
  }
  if (source.subDimension !== undefined) patch.subDimension = trim(source.subDimension, 60, 'subDimension');
  if (source.order !== undefined) {
    if (!Number.isFinite(Number(source.order))) throw new QuestionError('order must be a number.');
    patch.order = Math.max(0, Math.round(Number(source.order)));
  }
  if (source.active !== undefined) patch.active = Boolean(source.active);

  // An answer type that requires options must still have them after the patch.
  const merged = { ...(existing || {}), ...patch };
  if ((merged.answerType === 'choice' || merged.answerType === 'multi_choice') && (merged.choices || []).length < 2) {
    throw new QuestionError(`${merged.answerType} questions need at least two choices.`);
  }
  if (merged.answerType !== 'choice' && merged.answerType !== 'multi_choice' && (merged.choices || []).length) {
    throw new QuestionError('only choice and multi_choice questions may carry choices.');
  }
  return patch;
}

/** Cap on org-authored rows, checked before a write so a bad import cannot grow unbounded. */
function assertWithinCustomLimit(overrides, incomingId) {
  const defaultIds = new Set(DEFAULT_BANK.questions.map((row) => row.id));
  const customCount = (overrides || []).filter((row) => row && !defaultIds.has(row.id)).length;
  const isCustom = !defaultIds.has(incomingId);
  if (isCustom && customCount >= MAX_CUSTOM_QUESTIONS) {
    throw new QuestionError(`This organisation has reached the ${MAX_CUSTOM_QUESTIONS} custom-question limit.`, 409);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Score one question against its recall hits.
 *
 * `best` is MULTIPLICATIVE, which is the whole point: a single weak hit can never
 * read as "covered", no matter how generous the other credits are.
 *
 * @param {object} question merged bank row
 * @param {Array<{memory: object, score: number}>} hits scored recall, highest first
 * @returns {object} { score, status, bestScore, hitCount, matchedScopes, evidence }
 */
function scoreQuestion(question, hits = []) {
  const rows = Array.isArray(hits) ? hits : [];
  const best = rows.length ? Number(rows[0].score) || 0 : 0;
  const hitCredit = clamp(rows.length / 3, 0, 1);

  const expected = EXPECTED_SCOPES[question.category] || [];
  const matchedScopes = [...new Set(rows.map((entry) => entry.memory && entry.memory.scope).filter(Boolean))];
  const scopeCredit = matchedScopes.some((scope) => expected.includes(scope)) ? 1 : 0.75;

  // A `choice` question answered only by prose is *nearly* covered, not fully:
  // the stored fact exists but not in the form the intake flow needs.
  let answerCredit = 1;
  const needsChoice = question.answerType === 'choice' || question.answerType === 'multi_choice';
  if (needsChoice && rows.length) {
    const haystack = normalizeText(rows.map((entry) => `${entry.memory?.title || ''} ${entry.memory?.text || ''}`).join(' '));
    const stated = (question.choices || []).some((choice) => haystack.includes(normalizeText(choice)));
    answerCredit = stated ? 1 : 0.8;
  }

  const score = Math.round(clamp(100 * best * (0.6 * hitCredit + 0.4 * scopeCredit) * answerCredit, 0, 100));

  return {
    score,
    status: statusForScore(score),
    bestScore: Number(best.toFixed(4)),
    hitCount: rows.length,
    matchedScopes,
    evidence: rows.slice(0, 3).map((entry) => ({
      memoryId: entry.memory?.id || null,
      scope: entry.memory?.scope || null,
      title: String(entry.memory?.title || 'Memory').slice(0, 160),
      score: Number((Number(entry.score) || 0).toFixed(4)),
    })),
  };
}

function statusForScore(score) {
  if (score >= STATUS_THRESHOLDS.covered) return 'covered';
  if (score >= STATUS_THRESHOLDS.partial) return 'partial';
  if (score >= STATUS_THRESHOLDS.gap) return 'gap';
  return 'unanswered';
}

/**
 * Aggregate per-question results into one overall percentage.
 *
 * Rows that were never looked at — `not_assessed` (memory off) and `not_evaluated`
 * (the run's budget expired first) — are EXCLUDED from the denominator rather than
 * counted as zero: "we did not look" must not be reported as "we know nothing".
 * `questionCount` stays the full bank so the UI can say "2 of 79 checked".
 */
function scoreCoverage(results = []) {
  const all = Array.isArray(results) ? results.filter(Boolean) : [];
  const rows = all.filter((row) => row.status !== 'not_assessed' && row.status !== 'not_evaluated');
  if (!rows.length) {
    return { score: null, status: 'not_assessed', questionCount: all.length, assessedCount: 0 };
  }
  let weightedSum = 0;
  let weightTotal = 0;
  const byCategory = {};
  for (const row of rows) {
    const weight = CATEGORY_WEIGHTS[row.category] || 1;
    weightedSum += (Number(row.score) || 0) * weight;
    weightTotal += weight;
    byCategory[row.category] = byCategory[row.category] || { score: 0, count: 0 };
    byCategory[row.category].score += Number(row.score) || 0;
    byCategory[row.category].count += 1;
  }
  for (const [category, bucket] of Object.entries(byCategory)) {
    byCategory[category] = { score: Math.round(bucket.score / bucket.count), count: bucket.count };
  }
  const score = Math.round(weightedSum / weightTotal);
  return { score, status: statusForScore(score), questionCount: all.length, assessedCount: rows.length, byCategory };
}

/**
 * The rows the coverage run must produce when memory cannot be consulted at all.
 * Distinct from a 0%: it means nobody looked.
 */
function notAssessedResults(questions, memoryState) {
  return questions.map((question) => ({
    id: question.id,
    category: question.category,
    subDimension: question.subDimension,
    question: question.question,
    score: null,
    status: 'not_assessed',
    memoryState,
    bestScore: 0,
    hitCount: 0,
    matchedScopes: [],
    evidence: [],
  }));
}

function randomId() {
  // Avoid pulling in node:crypto's randomUUID naming at the module edge so this
  // stays loadable in the same contexts as the rest of the agent utilities.
  return globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16)
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  CATEGORIES,
  ANSWER_TYPES,
  ORIGINS,
  EXPECTED_SCOPES,
  CATEGORY_WEIGHTS,
  MAX_QUESTION_CHARS,
  MAX_WHY_CHARS,
  MAX_CHOICES,
  MAX_CUSTOM_QUESTIONS,
  QuestionError,
  defaultBank,
  mergeBank,
  normalizeQuestion,
  validateQuestionPatch,
  assertWithinCustomLimit,
  scoreQuestion,
  scoreCoverage,
  statusForScore,
  notAssessedResults,
  bankVersion: () => DEFAULT_BANK.bankVersion,
  bankSize: () => DEFAULT_BANK.questions.length,
};
