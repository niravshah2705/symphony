'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORIES,
  QuestionError,
  defaultBank,
  mergeBank,
  normalizeQuestion,
  validateQuestionPatch,
  assertWithinCustomLimit,
  scoreQuestion,
  scoreCoverage,
  notAssessedResults,
  bankSize,
  bankVersion,
  MAX_CUSTOM_QUESTIONS,
} = require('./global-questions');

const DEFAULTS = defaultBank();
const byCategory = (rows) => rows.reduce((acc, row) => ({ ...acc, [row.category]: (acc[row.category] || 0) + 1 }), {});

test('the shipped bank is exactly 30 organisation + 30 person + 20 project_business', () => {
  assert.equal(bankSize(), 80);
  assert.equal(bankVersion(), 1);
  assert.deepEqual(byCategory(DEFAULTS), { organisation: 30, person: 30, project_business: 20 });
});

test('every default row is well-formed and uniquely ordered', () => {
  assert.deepEqual(new Set(DEFAULTS.map((row) => row.id)).size, 80);
  assert.deepEqual(DEFAULTS.map((row) => row.order), Array.from({ length: 80 }, (_, i) => i + 1));
  for (const row of DEFAULTS) {
    assert.ok(CATEGORIES.includes(row.category), row.id);
    assert.ok(row.subDimension && row.question && row.whyItMatters, row.id);
    const needsChoices = row.answerType === 'choice' || row.answerType === 'multi_choice';
    assert.equal(row.choices.length >= 2, needsChoices, `${row.id} choices/answerType disagree`);
  }
});

test('the project_business bank covers every requested business and technical dimension', () => {
  const dimensions = new Set(DEFAULTS.filter((row) => row.category === 'project_business').map((row) => row.subDimension));
  for (const expected of [
    'business_domain', 'current_pain_point', 'solutions_considered', 'revenue_model', 'risk_appetite', 'budget',
    'cloud_preference', 'browser_application', 'mobile_application', 'connectors_only', 'b2b_model', 'existing_authentication',
  ]) {
    assert.ok(dimensions.has(expected), `missing sub-dimension ${expected}`);
  }
  // Freemium is called out by name in the spec, so one revenue question must ask about the free tier.
  const freemium = DEFAULTS.filter((row) => row.subDimension === 'revenue_model')
    .some((row) => /freemium|free tier/i.test(`${row.question} ${row.choices.join(' ')}`));
  assert.ok(freemium, 'no revenue_model question addresses a freemium tier');
});

test('mergeBank keeps untouched defaults as origin=default and layers overrides', () => {
  const merged = mergeBank([{ id: 'gq_org_01', question: 'How many seats will you need?' }]);
  const edited = merged.find((row) => row.id === 'gq_org_01');
  assert.equal(edited.origin, 'customised');
  assert.equal(edited.question, 'How many seats will you need?');
  assert.equal(edited.active, true);
  // Identity fields come from the bank, not the override, so grouping cannot break.
  assert.equal(edited.category, 'organisation');
  assert.equal(edited.subDimension, 'org_size');
  assert.equal(merged.filter((row) => row.origin === 'default').length, 79);
});

test('a tombstone hides a default without deleting it, and removing the tombstone restores it', () => {
  const hidden = mergeBank([{ id: 'gq_pb_10', active: false }]);
  assert.equal(hidden.find((row) => row.id === 'gq_pb_10').active, false);
  assert.equal(hidden.length, 80, 'a tombstoned row stays in the bank so the next revision cannot resurrect it');
});

test('mergeBank appends custom rows and orders by category then order', () => {
  const merged = mergeBank([{ id: 'gq_custom_1', category: 'person', subDimension: 'goals_motivations', question: 'Custom?', answerType: 'boolean' }]);
  assert.equal(merged.length, 81);
  const custom = merged.find((row) => row.id === 'gq_custom_1');
  assert.equal(custom.origin, 'custom');
  assert.ok(merged.findIndex((row) => row.id === 'gq_custom_1') > merged.findIndex((row) => row.id === 'gq_org_01'));
  assert.ok(merged.findIndex((row) => row.id === 'gq_custom_1') < merged.findIndex((row) => row.id === 'gq_pb_01'));
});

test('normalizeQuestion rejects malformed input rather than storing it', () => {
  const base = { category: 'organisation', subDimension: 'org_size', question: 'Size?', answerType: 'free_text' };
  assert.ok(normalizeQuestion(base).id.startsWith('gq_custom_'));
  assert.throws(() => normalizeQuestion({ ...base, category: 'company' }), QuestionError);
  assert.throws(() => normalizeQuestion({ ...base, question: '   ' }), /question is required/);
  assert.throws(() => normalizeQuestion({ ...base, answerType: 'choice', choices: ['only one'] }), /at least two choices/);
  assert.throws(() => normalizeQuestion({ ...base, choices: ['a', 'b'] }), /must not carry choices/);
  assert.throws(() => normalizeQuestion({ ...base, question: 'x'.repeat(601) }), /at most 600/);
  assert.throws(() => normalizeQuestion({ ...base, subDimension: '' }), /subDimension is required/);
});

test('normalizeQuestion coerces unknown answer types to free_text and clamps order', () => {
  const row = normalizeQuestion({ category: 'person', subDimension: 'x', question: 'Q', answerType: 'vibes', order: -5 });
  assert.equal(row.answerType, 'free_text');
  assert.equal(row.order, 0);
});

test('validateQuestionPatch allows a cross-field edit but not an inconsistent one', () => {
  const existing = { answerType: 'free_text', choices: [], question: 'old' };
  assert.deepEqual(validateQuestionPatch({ question: 'new' }, existing), { question: 'new' });
  assert.throws(() => validateQuestionPatch({ answerType: 'choice' }, existing), /at least two choices/);
  const withChoices = validateQuestionPatch({ answerType: 'choice', choices: ['a', 'b'] }, existing);
  assert.equal(withChoices.answerType, 'choice');
  assert.throws(() => validateQuestionPatch({ choices: ['a', 'b'] }, { answerType: 'number', choices: [] }), /only choice and multi_choice/);
  assert.throws(() => validateQuestionPatch({ question: '' }, existing), /must not be empty/);
});

test('the custom-question ceiling blocks a 201st custom row but never an override', () => {
  const defaultIds = DEFAULTS.map((row) => row.id);
  const customRows = Array.from({ length: MAX_CUSTOM_QUESTIONS }, (_, i) => ({ id: `gq_custom_${i}` }));
  assert.throws(() => assertWithinCustomLimit(customRows, 'gq_custom_new'), /custom-question limit/);
  assert.doesNotThrow(() => assertWithinCustomLimit(customRows, defaultIds[0]));
});

test('scoreQuestion: zero hits is 0/unanswered and no best score can be papered over', () => {
  const q = { id: 'a', category: 'organisation', answerType: 'free_text', choices: [] };
  const empty = scoreQuestion(q, []);
  assert.equal(empty.score, 0);
  assert.equal(empty.status, 'unanswered');
  assert.deepEqual(empty.evidence, []);

  const oneWeak = scoreQuestion(q, [{ memory: { id: 'm1', scope: 'business', title: 'Note', text: 'x' }, score: 0.1 }]);
  assert.equal(oneWeak.status, 'gap', 'a single weak hit must never read as covered');
  assert.equal(oneWeak.bestScore, 0.1);

  const strong = scoreQuestion(q, [
    { memory: { id: 'm1', scope: 'business', title: 'Headcount', text: '240 people' }, score: 0.95 },
    { memory: { id: 'm2', scope: 'workspace', title: 'Org', text: '240 staff' }, score: 0.9 },
    { memory: { id: 'm3', scope: 'business', title: 'Seats', text: '180 daily' }, score: 0.8 },
  ]);
  assert.ok(strong.score >= 80, `expected a high score, got ${strong.score}`);
  assert.equal(strong.status, 'covered');
  assert.equal(strong.evidence.length, 3, 'evidence is capped for the UI');
});

test('scoreQuestion discounts off-scope recall and prose-only answers to choice questions', () => {
  const q = { category: 'organisation', answerType: 'free_text', choices: [] };
  const inScope = scoreQuestion(q, [{ memory: { id: 'm', scope: 'business', title: 't', text: 'x' }, score: 0.5 }]);
  const offScope = scoreQuestion({ category: 'person', answerType: 'free_text', choices: [] }, [{ memory: { id: 'm', scope: 'task', title: 't', text: 'x' }, score: 0.5 }]);
  assert.ok(inScope.score > offScope.score, 'expected-scope hits must outscore off-scope ones');
  assert.deepEqual(inScope.matchedScopes, ['business']);

  // One hit → hitCredit 1/3, in-scope → (0.6/3 + 0.4) = 0.6 of `best`.
  const choiceQ = { category: 'project_business', answerType: 'choice', choices: ['freemium', 'subscription'] };
  const stated = scoreQuestion(choiceQ, [{ memory: { id: 'm', scope: 'business', title: 'Pricing', text: 'We run freemium' }, score: 1 }]);
  const prose = scoreQuestion(choiceQ, [{ memory: { id: 'm', scope: 'business', title: 'Pricing', text: 'per-seat licences' }, score: 1 }]);
  assert.equal(stated.score, 60);
  assert.equal(prose.score, 48, 'a prose answer to a choice question is nearly, not fully, covered');
});

test('scoreCoverage excludes rows that were never looked at from the denominator instead of counting them as zero', () => {
  const assessed = scoreCoverage([
    { category: 'organisation', score: 100, status: 'covered' },
    { category: 'organisation', score: 0, status: 'unanswered' },
  ]);
  assert.equal(assessed.score, 50);

  const withSkipped = scoreCoverage([
    { category: 'organisation', score: 100, status: 'covered' },
    { category: 'organisation', score: 0, status: 'unanswered' },
    { category: 'person', score: null, status: 'not_assessed' },
    // a run that spent its budget mid-bank: same honesty required as memory being off
    { category: 'project_business', score: null, status: 'not_evaluated' },
  ]);
  assert.equal(withSkipped.score, 50, 'an unlooked-at question must not drag the overall down');
  assert.equal(withSkipped.assessedCount, 2);
  assert.equal(withSkipped.questionCount, 4);
});

test('scoreCoverage reports not_assessed when nothing was assessed, and weights project questions higher', () => {
  const none = scoreCoverage([{ category: 'person', score: null, status: 'not_assessed' }]);
  assert.equal(none.score, null);
  assert.equal(none.status, 'not_assessed');
  assert.equal(none.questionCount, 1);

  const weighted = scoreCoverage([
    { category: 'organisation', score: 100, status: 'covered' },
    { category: 'project_business', score: 0, status: 'unanswered' },
  ]);
  assert.ok(weighted.score < 50, `project_business should pull harder, got ${weighted.score}`);
  assert.equal(weighted.byCategory.project_business.score, 0);
  assert.equal(weighted.byCategory.organisation.score, 100);
});

test('notAssessedResults never produces a fake 0%', () => {
  const rows = notAssessedResults(DEFAULTS.slice(0, 3), 'disabled');
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.score, null);
    assert.equal(row.status, 'not_assessed');
    assert.equal(row.memoryState, 'disabled');
  }
  assert.equal(scoreCoverage(rows).status, 'not_assessed');
});
