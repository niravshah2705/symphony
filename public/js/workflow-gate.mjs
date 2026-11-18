/**
 * Decision-gate verdict math, shared by the canvas card, the review dialog and
 * the tests.
 *
 * Kept DOM-free (`.mjs`, no browser globals): the same rules are what the
 * gateway validates a saved gate against, so a card the canvas colours as
 * passed must be a card the server agrees has passed — and `node --test` can
 * only import a module that never reaches for `document`.
 */

// The caps come from the designer model, which is the side the parity test
// holds against the server's own normalizeGateConfig. Re-spelling 6 and 3 here
// would let the dialog offer a seventh card the model then silently drops.
import { GATE_CARD_MAX, GATE_ITEM_MAX } from './workflow-designer-model.mjs';

export { GATE_CARD_MAX, GATE_ITEM_MAX };

export const clampPercent = (value) => Math.min(100, Math.max(0, Math.round(Number(value) || 0)));

export function cloneGateCards(config) {
  return (Array.isArray(config?.cards) ? config.cards : []).slice(0, GATE_CARD_MAX).map((card, index) => ({
    id: String(card?.id || `gate-card-${index + 1}`),
    title: String(card?.title || ''),
    items: Array.from({ length: GATE_ITEM_MAX }, (_, i) => String(card?.items?.[i] ?? '')),
    threshold: clampPercent(card?.threshold ?? 80),
    passRate: card?.passRate == null || card.passRate === '' ? null : clampPercent(card.passRate),
  }));
}

/**
 * Seed a new gate node from the tenant's effective template. The gateway sends
 * that template with the graph list; a deployment that answers nothing still
 * gets a fillable card, because a gate with no card cannot be saved at all —
 * the model rejects it.
 *
 * What the organization agrees on is which cards are assessed, at what bar, and
 * against which checklist; a pass rate is an observation about one gate, made
 * later by whoever reviews it. So the shape is cloned from the template and
 * `passRate` is then cleared — a card nobody has assessed must not inherit the
 * template's 90% and hand the operator an enabled approve button.
 */
export function gateConfigFrom(template) {
  const cards = cloneGateCards(template);
  for (const card of cards) card.passRate = null;
  return {
    id: template?.id || 'gate-template',
    title: template?.title || 'Decision gate review',
    cards: cards.length ? cards : [{
      id: 'gate-card-1', title: 'Readiness', threshold: 80, passRate: null,
      items: Array.from({ length: GATE_ITEM_MAX }, () => ''),
    }],
  };
}

/**
 * A card is met when its pass rate reaches its own threshold. A card with no
 * pass rate has not been assessed, so it is never met: "unknown" must not read
 * as a pass, which is why the approve button stays locked until every card has
 * a number rather than treating a blank as 100%.
 */
export function gateVerdict(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const assessed = list.filter((card) => card.passRate != null);
  const met = assessed.filter((card) => card.passRate >= clampPercent(card.threshold));
  const round = (values) => (values.length
    ? Math.round(values.reduce((sum, value) => sum + clampPercent(value), 0) / values.length)
    : 0);
  return {
    total: list.length,
    met: met.length,
    unassessed: list.length - assessed.length,
    overall: round(assessed.map((card) => card.passRate)),
    required: round(list.map((card) => card.threshold)),
    passed: list.length > 0 && assessed.length === list.length && met.length === list.length,
  };
}

export function gateSummaryText(cards) {
  const verdict = gateVerdict(cards);
  if (!verdict.total) return 'This gate has no assessment card yet, so it cannot be approved.';
  if (verdict.unassessed) {
    return `${verdict.met} of ${verdict.total} cards met · ${verdict.unassessed} not assessed yet.`;
  }
  return verdict.passed
    ? `All ${verdict.total} cards met their thresholds (overall ${verdict.overall}% / ${verdict.required}% required).`
    : `${verdict.total - verdict.met} of ${verdict.total} cards are below their threshold (overall ${verdict.overall}% / ${verdict.required}% required).`;
}

