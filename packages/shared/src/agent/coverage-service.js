'use strict';

/**
 * Coverage: does our agent memory already answer each global discovery question?
 *
 * Shape of a run (one request, not 80 requests):
 *   1. load the org's memory pool ONCE and keep it in memory
 *   2. embed every question text in ONE batched call (degrades to lexical-only)
 *   3. score every question by blended recall (the deterministic judge)
 *   4. optionally ask laya to ORDER the scopes that recall already matched
 *
 * Step 4 is annotation only. laya's `/route` is Jaccard token overlap and its
 * `/predict` returns a constant, so neither is allowed to move a score — the
 * response therefore carries `layaApplied` + `layaReason` and the UI must show
 * them, because on a deployment without LAYA_INFERENCE_URL the honest answer is
 * "recall scored this alone".
 */

const { CONFIG } = require('@ai-fleet/shared-core/config');
const { currentWorkspaceContext } = require('@ai-fleet/shared-core/store/workspace-context');

const {
  mergeBank,
  scoreQuestion,
  scoreCoverage,
  notAssessedResults,
  bankVersion,
} = require('./global-questions');

// The bank ceiling, not the shipped default count: 80 platform questions plus the
// 200 org-authored rows global-questions.js allows. A run larger than this is a
// malformed request, and the recall pass is O(questions) against one pool.
const MAX_QUESTIONS_PER_RUN = 280;
const RECALL_LIMIT = 5;
const CONCURRENCY = 8;
// A bank-wide pass budgets seconds, not the 150 ms per-turn router SLA: 80 calls
// at 150 ms each would be slower than the recall itself.
const LAYA_BUDGET_MS = 2000;
const RUN_BUDGET_MS = 20000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_TEXT_EMBED_CHARS = 500;

// Scope descriptions are what laya's token overlap actually reads, so they are
// short and domain-worded rather than generic.
const SCOPE_HINTS = Object.freeze({
  user: 'facts about the individual: role, goals, constraints, preferences, expertise',
  business: 'facts about the organisation and the business: domain, model, budget, compliance, strategy',
  project: 'facts about the project and its technical design: platform, cloud, apps, integrations',
  task: 'facts about a specific task or work item',
  workspace: 'facts about the shared workspace, tooling, and repository',
});

const cache = new Map();

function memoryMiddleware() {
  return require('./memory-middleware');
}

function memoryStore() {
  return require('./memory-store');
}

/**
 * Whether memory can be consulted at all, and how precisely.
 *   'disabled'  MEMORY_ENABLED off and no per-org setting → nothing is assessed
 *   'vector'    Postgres active → blended semantic + lexical recall
 *   'lexical'   file/Firestore fallback → term overlap only (under-reports)
 *   'unconfigured' the store itself could not be read
 */
async function resolveMemoryState({ context, deps }) {
  const store = deps.memoryStore || memoryStore();
  const enabled = typeof deps.isMemoryEnabled === 'function'
    ? deps.isMemoryEnabled()
    : memoryMiddleware().isEnabled();
  if (!enabled) return { enabled: false, state: 'disabled' };
  const postgres = typeof deps.isPostgresActive === 'function'
    ? deps.isPostgresActive()
    : store.isPostgresActive(process.env);
  return { enabled: true, state: postgres ? 'vector' : 'lexical' };
}

/** One batched embedding call for every question; null vectors mean lexical-only. */
async function embedQuestions(questions, deps) {
  const texts = questions.map((question) => String(question.question).slice(0, MAX_TEXT_EMBED_CHARS));
  try {
    const embed = deps.embed || (async (values) => {
      const { embedTexts } = require('@ai-fleet/shared-core/attachments/embed');
      return embedTexts(values, { workspaceContext: currentWorkspaceContext() });
    });
    const vectors = await embed(texts);
    if (!Array.isArray(vectors)) return null;
    return vectors.map((vector) => (Array.isArray(vector) && vector.length ? vector : null));
  } catch (_) {
    return null; // a missing/unreachable embedder is a lexical-only run, not an error
  }
}

/**
 * Ask laya to rank the scopes recall already matched, under ONE wall-clock budget
 * shared across the whole bank. Returns the id→ordered-scopes map plus the
 * applied/reason verdict the response must carry.
 */
async function rankScopesWithLaya(work, deps) {
  // CONFIG.SERVICES.layaUrl (NOT CONFIG.layaUrl, which is undefined — the
  // skill-router client reads the wrong path and silently lands on its loopback
  // default). Deliberately no fallback here: an empty base means laya is not
  // deployed on this stack, and we report that instead of attempting a loopback
  // connection that can only fail.
  const baseUrl = String(deps.layaUrl === undefined ? CONFIG.SERVICES?.layaUrl : deps.layaUrl).trim();
  const routerEnabled = deps.routerEnabled === undefined
    ? Boolean(CONFIG.SERVICES?.skillRouter?.enabled)
    : Boolean(deps.routerEnabled);
  if (!routerEnabled) return { applied: false, reason: 'disabled', ranks: new Map() };
  if (!baseUrl) return { applied: false, reason: 'not_configured', ranks: new Map() };

  const candidates = (scopes) => scopes.map((scope) => ({ id: scope, name: scope, description: SCOPE_HINTS[scope] || scope }));
  const deadline = Date.now() + LAYA_BUDGET_MS;
  const route = deps.layaRoute || (require('./skill-router/laya-client').routeWithLaya);
  const ranks = new Map();
  let applied = false;
  let timedOut = false;

  for (const item of work) {
    if (!item.matchedScopes.length) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { timedOut = true; break; }
    try {
      const selected = await route(item.question, candidates(item.matchedScopes), {
        baseUrl,
        topK: item.matchedScopes.length,
        timeoutMs: Math.max(50, Math.min(remaining, 1000)),
      });
      if (Array.isArray(selected) && selected.length) {
        ranks.set(item.id, selected);
        applied = true;
      }
    } catch (_) {
      // Fail open: an unreachable laya leaves recall's own ordering intact.
    }
  }

  const reason = applied ? null : timedOut ? 'timeout' : 'unreachable';
  return { applied, reason, ranks };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function pump() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, pump));
  return results;
}

function cacheKey({ context, questions, memoryState }) {
  const orgKey = context && context.organizationId ? context.organizationId : 'legacy';
  // bankVersion and the active question set are part of the key; the memory count
  // is not, because counting it would require the very store read we are skipping.
  return `${orgKey}|v${bankVersion()}|${memoryState}|${questions.length}|${questions.map((question) => question.id).join(',')}`;
}

/**
 * Compute the coverage report for the active organisation.
 *
 * @param {object} [options]
 * @param {Array}  [options.questions] merged bank rows (defaults to store + bank)
 * @param {Array}  [options.questionIds] restrict the pass to these ids (subset of the bank)
 * @param {boolean}[options.refresh] bypass the cached report
 * @param {object} [options.context] workspace context (defaults to current)
 * @returns {Promise<object>} { overall, memoryState, layaApplied, layaReason, results, ... }
 */
async function computeCoverage(options = {}) {
  const deps = options.deps || {};
  const context = options.context || currentWorkspaceContext() || {};

  let questions = Array.isArray(options.questions) ? options.questions : null;
  if (!questions) {
    const store = deps.store || require('@ai-fleet/shared-core/store');
    questions = mergeBank(store.listGlobalQuestions ? store.listGlobalQuestions() : []);
  }
  questions = questions.filter((question) => question && question.active !== false);
  // A refresh of specific rows (one category, one dropdown entry) must not pay for
  // the whole bank; unknown ids simply match nothing.
  if (Array.isArray(options.questionIds) && options.questionIds.length) {
    const wanted = new Set(options.questionIds.map((id) => String(id)));
    questions = questions.filter((question) => wanted.has(String(question.id)));
  }
  questions = questions.slice(0, MAX_QUESTIONS_PER_RUN);

  const memory = await resolveMemoryState({ context, deps });
  if (!memory.enabled) {
    const results = notAssessedResults(questions, memory.state);
    return {
      overall: scoreCoverage(results),
      memoryState: memory.state,
      layaApplied: false,
      layaReason: 'not_attempted',
      bankVersion: bankVersion(),
      computedAt: new Date().toISOString(),
      status: 'not_assessed',
      results,
    };
  }

  const store = deps.memoryStore || memoryStore();

  // Checked before touching the store: a cache hit must cost zero I/O, which is
  // the whole reason the chat rail can afford to open this tab at all.
  const key = cacheKey({ context, questions, memoryState: memory.state });
  const cached = cache.get(key);
  if (cached && !options.refresh && Date.now() < cached.expiresAt) {
    return { ...cached.value, cached: true };
  }

  const pool = options.memories || (await store.load({ context }));
  if (!Array.isArray(pool)) {
    const results = notAssessedResults(questions, 'unconfigured');
    return {
      overall: scoreCoverage(results),
      memoryState: 'unconfigured',
      layaApplied: false,
      layaReason: 'not_attempted',
      bankVersion: bankVersion(),
      computedAt: new Date().toISOString(),
      status: 'not_assessed',
      results,
    };
  }

  const vectors = memory.state === 'vector' ? await embedQuestions(questions, deps) : null;
  // An injectable clock so the budget is testable without sleeping; production
  // never passes deps.now and gets the wall clock.
  const now = deps.now || (() => Date.now());
  const runBudgetMs = Number.isFinite(deps.runBudgetMs) ? deps.runBudgetMs : RUN_BUDGET_MS;
  const deadline = now() + runBudgetMs;
  const loadVector = deps.loadVector || (memory.state === 'vector' ? (memory_) => memory_ && memory_.embedding : () => null);

  const evaluated = [];
  const results = await mapWithConcurrency(questions, CONCURRENCY, async (question, index) => {
    // Once the budget is spent, the remaining rows are reported as not evaluated —
    // not scored as gaps. A slow memory must never read as "we know nothing".
    if (now() > deadline) {
      return {
        id: question.id,
        category: question.category,
        subDimension: question.subDimension,
        question: question.question,
        score: null,
        status: 'not_evaluated',
        bestScore: 0,
        hitCount: 0,
        matchedScopes: [],
        evidence: [],
      };
    }
    const hits = await store.recallScored({
      query: question.question,
      queryVector: vectors ? vectors[index] : null,
      context,
      limit: RECALL_LIMIT,
      memories: pool,
      loadVector,
    });
    const scored = scoreQuestion(question, hits);
    evaluated.push({ id: question.id, question: question.question, matchedScopes: scored.matchedScopes });
    return { id: question.id, category: question.category, subDimension: question.subDimension, question: question.question, ...scored };
  });

  const laya = await rankScopesWithLaya(evaluated, deps);
  if (laya.applied) {
    for (const row of results) {
      const ranked = laya.ranks.get(row.id);
      if (ranked && ranked.length) row.matchedScopes = [...ranked, ...(row.matchedScopes || []).filter((scope) => !ranked.includes(scope))];
      row.laya = { applied: Boolean(ranked && ranked.length), reason: null };
    }
  } else {
    for (const row of results) row.laya = { applied: false, reason: laya.reason };
  }

  const partial = results.some((row) => row.status === 'not_evaluated');
  const value = {
    overall: scoreCoverage(results),
    memoryState: memory.state,
    memoryCount: pool.length,
    layaApplied: laya.applied,
    layaReason: laya.reason,
    bankVersion: bankVersion(),
    computedAt: new Date().toISOString(),
    status: partial ? 'partial' : 'complete',
    cacheExpiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    results,
  };
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Drop cached reports — call after any bank mutation, because the cache key carries
 * question IDS and a rename would otherwise serve the old text's score for the full
 * TTL. Pass an organizationId to clear just that tenant; clearing all is the safe
 * fallback and only costs one recompute per other org's next read.
 */
function invalidateCoverageCache(organizationId) {
  if (!organizationId) {
    cache.clear();
    return 0;
  }
  const prefix = `${organizationId}|`;
  let dropped = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

module.exports = {
  computeCoverage,
  invalidateCoverageCache,
  resolveMemoryState,
  MAX_QUESTIONS_PER_RUN,
  LAYA_BUDGET_MS,
  RUN_BUDGET_MS,
  CACHE_TTL_MS,
  SCOPE_HINTS,
};
