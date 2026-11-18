'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { LIMITS } = require('@ai-fleet/shared/agent/local-intelligence');

const {
  createGlobalQuestionsRouter,
  MAX_INSTRUCTION_CHARS,
  listQuestions,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  coverageReport,
  aiAssist,
} = require('./global-questions');


/**
 * An in-memory stand-in for the org store override list. It mirrors store.js's
 * upsert-by-id semantics (revision bump, updatedAt owned by the store) so a route
 * bug shows up as a wrong record, not as a fake that agrees with itself.
 */
function makeStore(overrides = []) {
  const rows = overrides.map((row) => ({ ...row }));
  const store = {
    rows,
    listGlobalQuestions: () => rows.map((row) => ({ ...row })),
    upsertGlobalQuestion: (question) => {
      const index = rows.findIndex((row) => row.id === question.id);
      const now = '2026-11-01T00:00:00.000Z';
      const record = index >= 0
        ? { ...rows[index], ...question, createdAt: rows[index].createdAt || now, updatedAt: now, revision: (rows[index].revision || 1) + 1 }
        : { ...question, createdAt: now, updatedAt: now, revision: question.revision || 1 };
      if (index >= 0) rows[index] = record;
      else rows.push(record);
      return record;
    },
    removeGlobalQuestion: (id) => {
      const before = rows.length;
      const kept = rows.filter((row) => row.id !== id);
      rows.length = 0;
      rows.push(...kept);
      return kept.length !== before;
    },
    getSettings: () => ({}),
  };
  return store;
}

function makeRes() {
  const res = { statusCode: 200, payload: null, jsonCalled: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (value) => { res.payload = value; res.jsonCalled = true; return res; };
  return res;
}

function makeReq({ body = {}, params = {}, headers = {}, fleetContext } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { body, params, fleetContext, get: (name) => lower[String(name).toLowerCase()] || '' };
}

const DEFAULT_ID = 'gq_org_01';
const CUSTOM_ROW = {
  id: 'gq_custom_seed',
  category: 'person',
  subDimension: 'identity_role',
  order: 5,
  question: 'Who signs off the architecture?',
  whyItMatters: '',
  answerType: 'free_text',
  choices: [],
  active: true,
  origin: 'custom',
  revision: 1,
  updatedBy: '',
};

test('the planner global-questions router exposes exactly the bank, coverage and assist routes', () => {
  const routes = createGlobalQuestionsRouter()
    .stack.filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.deepEqual(routes, ['GET /', 'POST /', 'PUT /:id', 'DELETE /:id', 'POST /coverage', 'POST /ai-assist']);
});

test('GET returns the merged bank with the counts the panel header shows', () => {
  const res = makeRes();
  listQuestions(makeReq(), res, { store: makeStore([CUSTOM_ROW]) });

  assert.equal(res.payload.bankVersion, 1);
  assert.equal(res.payload.total, 81, '80 platform defaults plus one org-authored row');
  assert.equal(res.payload.active, 81);
  assert.equal(res.payload.questions[0].id, 'gq_org_01', 'ordered by category then order');
  assert.equal(res.payload.questions.filter((row) => row.origin === 'custom').length, 1);
});

test('POST creates a custom row and refuses to overwrite a platform default id', () => {
  const store = makeStore();
  const res = makeRes();
  createQuestion(
    makeReq({ body: { category: 'project_business', subDimension: 'budget', question: 'What is the annual budget?', answerType: 'number' }, headers: { 'x-ai-fleet-user-id': 'admin@acme.test' } }),
    res,
    { store },
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.question.origin, 'custom');
  assert.match(res.payload.question.id, /^gq_custom_/);
  assert.equal(res.payload.question.updatedBy, 'admin@acme.test', 'attribution comes from the gateway header');

  assert.throws(
    () => createQuestion(makeReq({ body: { id: DEFAULT_ID, category: 'person', subDimension: 'x', question: 'clobber?' } }), makeRes(), { store }),
    /platform default/,
  );
});

test('PUT edits a default as an override and rejects re-filing it into another category', () => {
  const store = makeStore();
  const res = makeRes();
  updateQuestion(makeReq({ params: { id: DEFAULT_ID }, body: { question: 'How many people, including contractors?' } }), res, { store });

  assert.equal(res.payload.question.id, DEFAULT_ID);
  assert.equal(res.payload.origin, 'customised');
  assert.equal(store.rows.length, 1, 'a default edit stores only the override, never a copy of the bank');
  assert.deepEqual(Object.keys(store.rows[0]).sort(), ['createdAt', 'id', 'question', 'revision', 'updatedAt', 'updatedBy']);

  assert.throws(
    () => updateQuestion(makeReq({ params: { id: DEFAULT_ID }, body: { category: 'person' } }), makeRes(), { store }),
    /keeps its category/,
  );
  assert.throws(() => updateQuestion(makeReq({ params: { id: 'gq_nope' }, body: { question: 'x' } }), makeRes(), { store }), /not found/i);
});

test('DELETE tombstones a default and hard-removes a custom row', () => {
  const store = makeStore([CUSTOM_ROW]);
  const tombstone = makeRes();
  deleteQuestion(makeReq({ params: { id: DEFAULT_ID } }), tombstone, { store });
  assert.equal(tombstone.payload.tombstoned, true);
  assert.equal(store.rows.some((row) => row.id === DEFAULT_ID && row.active === false), true);

  const removed = makeRes();
  deleteQuestion(makeReq({ params: { id: CUSTOM_ROW.id } }), removed, { store });
  assert.deepEqual(removed.payload, { removed: CUSTOM_ROW.id });
  assert.equal(store.rows.some((row) => row.id === CUSTOM_ROW.id), false);

  // The tombstoned default must still read back as inactive rather than resurrect.
  const res = makeRes();
  listQuestions(makeReq(), res, { store });
  assert.equal(res.payload.questions.find((row) => row.id === DEFAULT_ID).active, false);
  assert.equal(res.payload.active, res.payload.total - 1);
});

test('every bank mutation invalidates this org\'s cached coverage report', () => {
  // The cache key carries question IDS, so a renamed question would otherwise keep
  // the OLD text's score for the full TTL — and "re-check memory" is the very next
  // thing an admin does after saving.
  const cleared = [];
  const options = { store: makeStore([CUSTOM_ROW]), invalidateCoverage: (orgId) => cleared.push(orgId) };

  createQuestion(makeReq({ body: { category: 'person', subDimension: 'x', question: 'New?' }, fleetContext: { organizationId: 'org_a' } }), makeRes(), options);
  updateQuestion(makeReq({ params: { id: DEFAULT_ID }, body: { question: 'Edited?' }, fleetContext: { organizationId: 'org_b' } }), makeRes(), options);
  deleteQuestion(makeReq({ params: { id: DEFAULT_ID }, fleetContext: { organizationId: 'org_c' } }), makeRes(), options);
  // With no gateway-forwarded org the route cannot target a key, so it clears all.
  deleteQuestion(makeReq({ params: { id: CUSTOM_ROW.id } }), makeRes(), options);

  assert.deepEqual(cleared, ['org_a', 'org_b', 'org_c', undefined]);
});

test('a partial patch of a custom choice row cannot drop the choices it relies on', () => {
  const choiceRow = { ...CUSTOM_ROW, answerType: 'choice', choices: ['AWS', 'GCP', 'Neither'] };
  const store = makeStore([choiceRow]);
  assert.throws(
    () => updateQuestion(makeReq({ params: { id: CUSTOM_ROW.id }, body: { choices: ['Only one'] } }), makeRes(), { store }),
    /at least two choices/,
  );
  assert.equal(store.rows[0].choices.length, 3, 'the rejected patch did not reach the store');
});

test('POST coverage forwards refresh, ids and org context and returns the report as-is', async () => {
  let seen = null;
  const res = makeRes();
  await coverageReport(
    makeReq({ body: { refresh: true, questionIds: ['gq_org_01'] }, fleetContext: { organizationId: 'org_a' } }),
    res,
    { computeCoverage: async (args) => { seen = args; return { status: 'partial', results: [] }; } },
  );

  assert.equal(seen.refresh, true);
  assert.deepEqual(seen.questionIds, ['gq_org_01']);
  assert.deepEqual(seen.context, { organizationId: 'org_a' });
  assert.equal(res.payload.status, 'partial', 'a partial report is still HTTP 200');
});

test('ai-assist validates the mode, previews only, and re-validates every proposal', async () => {
  const res = makeRes();
  await aiAssist(
    makeReq({
      body: {
        mode: 'suggest',
        category: 'person',
        subDimension: 'risk_tolerance',
        instruction: 'Ask about how they handle risk',
      },
    }),
    res,
    {
      proposeQuestions: async () => ({
        proposals: [
          { question: 'How much risk will you accept on the first release?' },
          { question: '', answerType: 'choice', choices: [] },
          { question: 'Who owns the rollback decision?', answerType: 'choice', choices: ['One person', 'A committee'] },
        ],
        provenance: { model: 'llama3', local: true },
        warnings: [],
        notes: 'three drafted',
      }),
    },
  );

  assert.equal(res.payload.mode, 'suggest');
  assert.equal(res.payload.proposals.length, 2, 'the empty proposal was dropped');
  assert.equal(res.payload.warnings.length, 1);
  assert.match(res.payload.warnings[0], /dropped/);
  assert.equal(res.payload.proposals[0].category, 'person');
  assert.equal(res.payload.proposals[0].origin, 'custom');
  assert.deepEqual(res.payload.provenance, { model: 'llama3', local: true });

  await assert.rejects(
    () => aiAssist(makeReq({ body: { mode: 'nonsense', instruction: 'x' } }), makeRes(), {}),
    /mode must be one of/,
  );
  await assert.rejects(
    () => aiAssist(makeReq({ body: { mode: 'suggest', instruction: '   ' } }), makeRes(), {}),
    /instruction is required/,
  );
});

test('rewrite binds a proposal to the question being rewritten so the panel can save it', async () => {
  const res = makeRes();
  await aiAssist(
    makeReq({
      body: {
        mode: 'rewrite',
        category: 'organisation',
        subDimension: 'org_size',
        instruction: 'Make it shorter',
        current: { id: DEFAULT_ID, question: 'A long winded question about headcount?' },
      },
    }),
    res,
    { proposeQuestions: async () => ({ proposals: [{ question: 'How many people are in the organisation?' }], warnings: [] }) },
  );

  const [proposal] = res.payload.proposals;
  assert.equal(proposal.id, DEFAULT_ID, 'the panel can PUT this straight back onto the default row');
  assert.equal(proposal.origin, 'customised');
  assert.equal(proposal.category, 'organisation', 'the request category frames a row the model left ungrouped');
});

test('a full legal bank still fits inside the JSON body limit both services set', () => {
  // express.json({ limit: '1mb' }) is configured on the gateway and the planner, so
  // a batch import larger than that is rejected by the parser before it reaches a
  // handler. These caps are what keep a legitimate save inside that boundary; raise
  // one without the other and a real admin import starts failing with a bare 413.
  const BODY_LIMIT_BYTES = 1024 * 1024;
  const widestRow = {
    id: 'gq_custom_abcdefgh',
    category: 'project_business',
    subDimension: 'x'.repeat(60),
    question: 'q'.repeat(600),
    whyItMatters: 'w'.repeat(600),
    answerType: 'multi_choice',
    choices: Array.from({ length: 10 }, () => 'c'.repeat(120)),
    order: 1,
    active: true,
    origin: 'custom',
    revision: 1,
    updatedBy: 'u'.repeat(200),
  };
  const widestBody = JSON.stringify({ questions: Array.from({ length: 280 }, () => widestRow) });

  assert.ok(widestBody.length < BODY_LIMIT_BYTES, `a worst-case bank is ${widestBody.length} bytes`);
  assert.equal(MAX_INSTRUCTION_CHARS, LIMITS.inputChars, 'the route and the local model must agree on the prompt ceiling');
});
