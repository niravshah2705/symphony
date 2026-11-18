'use strict';

/**
 * Global discovery questions: the org's intake bank and how much of it our agent
 * memory already answers.
 *
 * Storage follows the platform-default + per-org-overlay contract in
 * agent/global-questions.js — the store keeps only this org's overrides, so a new
 * bank revision needs no migration and a removed default stays removed because we
 * persist its `active: false` tombstone rather than dropping the row.
 *
 * `/ai-assist` is PREVIEW-ONLY and never writes, mirroring the settings-command
 * `{apply:false}` contract: the admin reviews proposals and saves the ones they want.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const defaultStore = require('@ai-fleet/shared/store');
const { asyncHandler } = require('@ai-fleet/shared/util');
const {
  QuestionError,
  assertWithinCustomLimit,
  bankVersion,
  defaultBank,
  mergeBank,
  normalizeQuestion,
  validateQuestionPatch,
} = require('@ai-fleet/shared/agent/global-questions');
const coverageService = require('@ai-fleet/shared/agent/coverage-service');
const localIntelligence = require('@ai-fleet/shared/agent/local-intelligence');

const AI_ASSIST_MODES = ['suggest', 'rewrite', 'import'];
const MAX_PROPOSALS = 40;
const MAX_INSTRUCTION_CHARS = 8000;

const DEFAULT_IDS = new Set(defaultBank().map((row) => row.id));

function deps(options = {}) {
  return {
    store: options.store || defaultStore,
    computeCoverage: options.computeCoverage || coverageService.computeCoverage,
    invalidateCoverage: options.invalidateCoverage || coverageService.invalidateCoverageCache,
    proposeQuestions: options.proposeQuestions || localIntelligence.proposeQuestions,
  };
}

/** The gateway forwards the verified caller, so a client cannot forge attribution. */
function actor(req) {
  return String((req.get && req.get('x-ai-fleet-user-id')) || '').slice(0, 200);
}

/**
 * A bank edit invalidates this org's cached coverage report. The cache key carries
 * question IDS, so a renamed question would otherwise keep the OLD text's score for
 * the full 10-minute TTL — and the admin's very next action is "re-check memory".
 */
function invalidateCoverageForOrg(req, options = {}) {
  const organizationId = req.fleetContext && req.fleetContext.organizationId;
  // Without a gateway-forwarded org there is no key to target — the store context is
  // resolved per request — so clear the whole cache rather than guess and leave stale.
  deps(options).invalidateCoverage(organizationId);
}

function body(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

/** This org's merged bank keyed by id — the only view an edit can target. */
function bankById(store) {
  const map = new Map();
  for (const row of mergeBank(store.listGlobalQuestions())) map.set(row.id, row);
  return map;
}

function listQuestions(_req, res, options = {}) {
  const questions = mergeBank(deps(options).store.listGlobalQuestions());
  res.json({
    questions,
    bankVersion: bankVersion(),
    total: questions.length,
    active: questions.filter((row) => row.active !== false).length,
  });
}

function createQuestion(req, res, options = {}) {
  const { store } = deps(options);
  const source = body(req);
  const id = source.id ? String(source.id) : `gq_custom_${randomUUID().slice(0, 8)}`;
  if (DEFAULT_IDS.has(id)) {
    throw new QuestionError('That id belongs to a platform default question; use PUT to customise it.', 409);
  }
  assertWithinCustomLimit(store.listGlobalQuestions(), id);

  const question = normalizeQuestion({ ...source, id, origin: 'custom', updatedBy: actor(req) });
  const record = store.upsertGlobalQuestion(question);
  invalidateCoverageForOrg(req, options);
  res.status(201).json({ question: record });
}

function updateQuestion(req, res, options = {}) {
  const { store } = deps(options);
  const source = body(req);
  const id = String(req.params.id || '');
  const existing = bankById(store).get(id);
  if (!existing) throw new QuestionError('Question not found.', 404);

  // mergeBank re-forces a default's category and sub-dimension, so a patch that
  // tried to re-file one would silently no-op. Reject it loudly instead.
  if (DEFAULT_IDS.has(id) && (source.category !== undefined || source.subDimension !== undefined)) {
    throw new QuestionError('A platform default question keeps its category and sub-dimension; edit its text, answer type and choices instead.');
  }

  const patch = validateQuestionPatch(source, existing);
  assertWithinCustomLimit(store.listGlobalQuestions(), id);
  const record = store.upsertGlobalQuestion({ id, ...patch, updatedBy: actor(req) });
  invalidateCoverageForOrg(req, options);
  res.json({ question: record, origin: record.origin || (DEFAULT_IDS.has(id) ? 'customised' : 'custom') });
}

function deleteQuestion(req, res, options = {}) {
  const { store } = deps(options);
  const id = String(req.params.id || '');
  if (!bankById(store).has(id)) throw new QuestionError('Question not found.', 404);

  if (DEFAULT_IDS.has(id)) {
    // A tombstone, not a removal: dropping the override row would let the next bank
    // revision resurrect a question this org deliberately switched off.
    const record = store.upsertGlobalQuestion({ id, active: false, updatedBy: actor(req) });
    invalidateCoverageForOrg(req, options);
    return res.json({ question: record, tombstoned: true });
  }
  store.removeGlobalQuestion(id);
  invalidateCoverageForOrg(req, options);
  res.json({ removed: id });
}

async function coverageReport(req, res, options = {}) {
  const source = body(req);
  const report = await deps(options).computeCoverage({
    refresh: source.refresh === true,
    questionIds: source.questionIds,
    context: req.fleetContext || undefined,
  });
  // A `partial` report is still a successful assessment of the questions it did
  // reach, so it is returned as 200 — the body carries the status.
  res.json(report);
}

async function aiAssist(req, res, options = {}) {
  const source = body(req);
  const mode = AI_ASSIST_MODES.includes(source.mode) ? source.mode : null;
  if (!mode) throw new QuestionError(`mode must be one of: ${AI_ASSIST_MODES.join(', ')}.`);
  const instruction = typeof source.instruction === 'string' ? source.instruction.trim() : '';
  if (!instruction) throw new QuestionError('instruction is required.');
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new QuestionError(`instruction must be at most ${MAX_INSTRUCTION_CHARS} characters.`);
  }

  const { store } = deps(options);
  const result = await deps(options).proposeQuestions({
    mode,
    instruction,
    category: source.category,
    subDimension: source.subDimension,
    current: source.current,
    settings: store.getSettings ? store.getSettings() : {},
  });

  // A proposal that fails the same validator as a manual save can never reach the
  // store, so an unusable model row is reported rather than silently dropped.
  const rewriteId = mode === 'rewrite' && source.current && source.current.id ? String(source.current.id) : '';
  const proposals = [];
  const warnings = [...(result.warnings || [])];
  for (const proposal of (result.proposals || []).slice(0, MAX_PROPOSALS)) {
    try {
      proposals.push(normalizeQuestion({
        // The request's category frames the whole assist call, so a model row that
        // omits it stays groupable instead of being thrown away.
        category: source.category,
        subDimension: source.subDimension,
        ...proposal,
        ...(rewriteId ? { id: rewriteId } : {}),
        origin: rewriteId ? 'customised' : 'custom',
        active: true,
      }));
    } catch (error) {
      warnings.push(`Proposal ${proposals.length + 1} was dropped: ${error.message}`);
    }
  }

  res.json({ mode, proposals, provenance: result.provenance, notes: result.notes, warnings });
}

function createGlobalQuestionsRouter(options = {}) {
  const router = express.Router();

  router.get('/', asyncHandler((_req, res) => listQuestions(_req, res, options)));
  router.post('/', asyncHandler((req, res) => createQuestion(req, res, options)));
  router.put('/:id', asyncHandler((req, res) => updateQuestion(req, res, options)));
  router.delete('/:id', asyncHandler((req, res) => deleteQuestion(req, res, options)));
  router.post('/coverage', asyncHandler((req, res) => coverageReport(req, res, options)));
  router.post('/ai-assist', asyncHandler((req, res) => aiAssist(req, res, options)));

  return router;
}

const router = createGlobalQuestionsRouter();

module.exports = router;
module.exports.createGlobalQuestionsRouter = createGlobalQuestionsRouter;
module.exports.MAX_INSTRUCTION_CHARS = MAX_INSTRUCTION_CHARS;
module.exports.listQuestions = listQuestions;
module.exports.createQuestion = createQuestion;
module.exports.updateQuestion = updateQuestion;
module.exports.deleteQuestion = deleteQuestion;
module.exports.coverageReport = coverageReport;
module.exports.aiAssist = aiAssist;
