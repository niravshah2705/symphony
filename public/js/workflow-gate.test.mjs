import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATE_CARD_MAX,
  GATE_ITEM_MAX,
  cloneGateCards,
  gateConfigFrom,
  gateSummaryText,
  gateVerdict,
} from './workflow-gate.mjs';

const card = (over = {}) => ({
  id: 'c1', title: 'Business Analysis', items: ['a', 'b', 'c'], threshold: 85, passRate: 90, ...over,
});

test('a gate passes only when every card reaches its own threshold', () => {
  const allMet = gateVerdict([card(), card({ id: 'c2', threshold: 100, passRate: 100 })]);
  assert.equal(allMet.passed, true);
  assert.deepEqual([allMet.total, allMet.met], [2, 2]);

  const oneBelow = gateVerdict([card(), card({ id: 'c2', threshold: 100, passRate: 82 })]);
  assert.equal(oneBelow.passed, false, '82 against a 100 threshold is a fail even when the average looks fine');
  assert.equal(oneBelow.met, 1);
  assert.equal(oneBelow.overall, 86, 'the overall figure is the mean of the card pass rates');
  assert.equal(oneBelow.required, 93);
});

test('a card with no pass rate is not a pass', () => {
  const unassessed = gateVerdict([card({ passRate: null })]);
  assert.equal(unassessed.passed, false, 'unknown must not read as a pass');
  assert.equal(unassessed.unassessed, 1);
  assert.equal(gateSummaryText([card({ passRate: null })]), '0 of 1 cards met · 1 not assessed yet.');

  assert.equal(gateVerdict([]).passed, false, 'an empty gate approves nothing');
  assert.match(gateSummaryText([]), /no assessment card/i);
});

test('the summary states the verdict an approver acts on', () => {
  assert.match(gateSummaryText([card(), card({ id: 'c2' })]), /All 2 cards met their thresholds/);
  assert.match(gateSummaryText([card({ passRate: 60 }), card({ id: 'c2', passRate: 100, threshold: 100 })]),
    /1 of 2 cards are below their threshold/);
});

test('a gate is seeded from the tenant template, capped at six cards and three items', () => {
  const template = { id: 'gate-template-v1', title: 'Specs Gate', cards: Array.from({ length: 9 }, (_, i) => card({ id: `c${i}`, items: ['1', '2', '3', '4', '5'] })) };
  const seeded = gateConfigFrom(template);
  assert.equal(seeded.id, 'gate-template-v1');
  assert.equal(seeded.title, 'Specs Gate');
  assert.equal(seeded.cards.length, GATE_CARD_MAX, 'a template longer than the cap still saves');
  assert.equal(seeded.cards[0].items.length, GATE_ITEM_MAX);
});

test('a seeded gate keeps the template thresholds but not its pass rates', () => {
  // The shipping template records a passing assessment; a new gate is not that
  // assessment. Inheriting the numbers would unlock approve on a lane nobody
  // in this workflow has looked at.
  const shipped = gateConfigFrom({
    id: 'gate-template-v1', title: 'Specs Gate',
    cards: [card({ id: 'business-analysis', passRate: 90, threshold: 85 })],
  });
  assert.deepEqual(shipped.cards[0].passRate, null);
  assert.equal(shipped.cards[0].threshold, 85, 'the bar is part of the template');
  assert.deepEqual(shipped.cards[0].items, ['a', 'b', 'c'], 'the checklist is part of the template');
  assert.equal(gateVerdict(shipped.cards).passed, false);
  assert.match(gateSummaryText(shipped.cards), /not assessed yet/);

  // Cloning keeps an assessment that was already made; only seeding starts
  // unassessed.
  assert.equal(cloneGateCards({ cards: [card({ passRate: 40 })] })[0].passRate, 40);
  assert.equal(gateConfigFrom({ cards: [card({ passRate: 40 })] }).cards[0].passRate, null);
});

test('an empty or partial template still yields a card the operator can fill in', () => {
  assert.equal(gateConfigFrom(null).cards.length, 1, 'a gate with no card cannot be saved at all');
  assert.deepEqual(gateConfigFrom(null).cards[0].items.length, GATE_ITEM_MAX);
  const partial = gateConfigFrom({ id: 't', title: 'T', cards: [{ title: 'Only one', threshold: 70 }] });
  assert.deepEqual(partial.cards[0].passRate, null, 'a card nobody has assessed is not assumed to have passed');
  assert.equal(partial.cards[0].threshold, 70);
});

test('percentages and titles are normalized rather than trusted from the form', () => {
  const cloned = cloneGateCards({ cards: [{ title: 'x', items: [], threshold: 140, passRate: -20 }, { threshold: 50 }] });
  assert.equal(cloned[0].threshold, 100);
  assert.equal(cloned[0].passRate, 0);
  assert.equal(cloned[0].title, 'x');
  assert.deepEqual(cloned[1].id, 'gate-card-2', 'a card with no id still gets a stable one');
  assert.equal(cloned[1].title, '');
  assert.equal(cloned.every((c) => c.items.length === GATE_ITEM_MAX), true);
});
