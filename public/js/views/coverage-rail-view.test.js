'use strict';

// The coverage tab lives in the same module that renders the whole agent chat, and
// that module touches Firebase on import — so this exercises the rail's real
// behaviour by evaluating just the coverage section out of the source. It is the
// cheapest guard that fails when someone reintroduces an unbounded fetch on every
// chat render, or collapses the difference between "we did not look" and "we looked
// and found nothing".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'agent.js'), 'utf8');
const START = SOURCE.indexOf('/* --------------------------- question coverage rail');
const END = SOURCE.indexOf('\nfunction pauseSources');
assert.ok(START > 0 && END > START, 'the coverage rail section must stay delimited for this test');
const SECTION = SOURCE.slice(START, END);

/** A DOM element small enough to reason about, big enough for the rail to paint. */
function makeEl(tag, attrs = {}, children = []) {
  const node = {
    tagName: tag,
    attrs: {},
    dataset: {},
    children: [],
    text: '',
    listeners: {},
    addEventListener(type, handler) { (node.listeners[type] || (node.listeners[type] = [])).push(handler); },
    append(...items) { absorb(node, items); },
  };
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined) continue;
    node.attrs[key] = String(value);
    if (key.startsWith('data-')) node.dataset[key.slice(5)] = String(value);
  }
  absorb(node, children);
  return node;
}

/** Flattens a subtree into `text`, keeping each descendant's classes visible. */
function absorb(node, items) {
  for (const item of (Array.isArray(items) ? items : [items]).flat(4)) {
    if (item === null || item === undefined || item === false) continue;
    if (typeof item === 'object' && 'attrs' in item) {
      node.children.push(item);
      node.text += ` ${item.attrs.class || ''} ${item.attrs.id || ''} ${item.text}`;
    } else {
      node.text += String(item);
    }
  }
}

/** Everything the rail rendered, as one string, for assertions on the painted output. */
function painted(node) {
  return `${node.attrs.class || ''} ${node.text}`;
}

function evaluate(extra = {}) {
  const sandbox = {
    el: makeEl,
    railIntro: (title, sub) => makeEl('div', {}, [title, sub]),
    emptyRail: (title, detail) => makeEl('div', { class: 'empty' }, [title, detail]),
    clear: (node) => { node.children = []; node.text = ''; return node; },
    api: { getQuestionCoverage: async () => ({ overall: {}, results: [] }) },
    railState: { mode: 'coverage' },
    console,
    ...extra,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${SECTION}\nthis.__api = { paintCoverageRail, coverageMemoryNote, coverageLayaNote, fetchCoverageReport };`, context);
  return context.__api;
}

const REPORT = {
  overall: { score: 12, status: 'gap', questionCount: 3, assessedCount: 3 },
  results: [
    { id: 'gq_org_01', category: 'organisation', subDimension: 'org_size', question: 'Headcount?', status: 'gap', score: 12, hitCount: 1, matchedScopes: ['business'], evidence: [{ memoryId: 'mem_1', title: 'Headcount', text: '240 staff.', score: 0.8 }] },
    { id: 'gq_per_01', category: 'person', subDimension: 'identity_role', question: 'Role?', status: 'not_assessed', score: null, hitCount: 0, matchedScopes: [], evidence: [] },
    { id: 'gq_pb_01', category: 'project_business', subDimension: 'budget', question: 'Budget?', status: 'unanswered', score: 0, hitCount: 0, matchedScopes: [], evidence: [] },
  ],
  memoryState: 'lexical',
  layaApplied: false,
  layaReason: 'not_configured',
};

test('the chat rail keeps one coverage cache and fetches only on demand', async () => {
  let calls = 0;
  const { fetchCoverageReport } = evaluate({
    api: {
      getQuestionCoverage: async () => {
        calls += 1;
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 5));
        return REPORT;
      },
    },
  });

  assert.equal(await fetchCoverageReport(), REPORT);
  assert.equal(await fetchCoverageReport(), REPORT);
  assert.equal(calls, 1, 'the second open must be served from the module cache');

  await fetchCoverageReport({ refresh: true });
  assert.equal(calls, 2, 'refresh is the only way to force another pass');

  // Concurrent opens must share one in-flight request rather than stampede the planner.
  const before = calls;
  await Promise.all([fetchCoverageReport({ refresh: true }), fetchCoverageReport({ refresh: true })]);
  assert.equal(calls - before, 1, 'two simultaneous refreshes cost one request');
});

test('the rail paints the score, the per-question rows and the status classes', () => {
  const { paintCoverageRail } = evaluate();
  const host = makeEl('div');
  paintCoverageRail(host, REPORT);
  const output = painted(host);

  assert.match(output, /12%/, 'the overall percentage renders');
  assert.match(output, /Headcount\?/, 'per-question rows render');
  assert.match(output, /coverage-gap/, 'a scored row carries its own status class');
  assert.match(output, /keywords only/i, 'a lexical run says matching was keyword-only');
  assert.match(output, /Laya did not take part \(not_configured\)/, 'a coverage number laya did not touch says so');
  assert.match(output, /coverage-summary/, 'the summary is its own panel section');
});

test('grey and red stay distinct: not_assessed is never painted as a 0% gap', () => {
  const { paintCoverageRail } = evaluate();
  const host = makeEl('div');
  // This is the payload a memory-off install actually gets: every row unassessed,
  // so a single "0%" anywhere in the paint would be a fabricated gap.
  const unassessed = {
    overall: { score: null, status: 'not_assessed', questionCount: 3, assessedCount: 0 },
    results: REPORT.results.map((row) => ({ ...row, status: 'not_assessed', score: null, hitCount: 0, evidence: [] })),
    memoryState: 'disabled',
    layaApplied: false,
    layaReason: 'not_attempted',
  };
  paintCoverageRail(host, unassessed);
  const output = painted(host);
  assert.match(output, /memory is off/i);
  assert.doesNotMatch(output, /0%/, 'nothing assessed must not read as zero coverage');
  assert.match(output, /coverage-summary coverage-not_assessed/, 'the summary keeps the grey status class');
  assert.match(output, /Not assessed/, 'the rows say they were not assessed');

  // The same rail with memory on and empty must read red, not grey.
  const redHost = makeEl('div');
  paintCoverageRail(redHost, {
    ...unassessed,
    overall: { score: 0, status: 'unanswered', questionCount: 3, assessedCount: 3 },
    memoryState: 'vector',
    memoryCount: 0,
    results: unassessed.results.map((row) => ({ ...row, status: 'unanswered', score: 0 })),
  });
  const redOutput = painted(redHost);
  assert.match(redOutput, /coverage-summary coverage-unanswered/);
  assert.match(redOutput, /Nothing stored/);
  assert.doesNotMatch(redOutput, /memory is off/i);
});

test('the coverage notes name the reason memory could not answer', () => {
  const { coverageMemoryNote, coverageLayaNote } = evaluate();
  assert.match(coverageMemoryNote({ memoryState: 'unconfigured' }), /could not be read/i);
  assert.match(coverageMemoryNote({ memoryState: 'vector', memoryCount: 7 }), /7 stored memories/);
  assert.match(coverageLayaNote({ layaApplied: false, layaReason: 'unreachable' }), /did not take part/);
  assert.match(coverageLayaNote({ layaApplied: true }), /ordered/);
});
