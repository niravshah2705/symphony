import { el } from '../dom.js';
import { icon } from '../icons.js';

/**
 * The decision-gate review dialog: assessment cards, the threshold each one
 * must reach, and the pass rate it has.
 *
 * A gate node is the one thing on the canvas that is not a step but a question,
 * so it does not get an ordinary field list. The cards are what an approver
 * reads before letting a lane continue, and six of them with three checklist
 * items each is a form nobody wants to scroll past on the way to moving a node.
 *
 * Everything edits a local draft and hands it back through `onApply`, so the
 * graph's own persistence path (debounced save, revision check, conflict
 * report) stays the only writer. Cancelling changes nothing.
 *
 * The verdict math and the card normalization live in ../workflow-gate.mjs,
 * which holds no DOM: the gateway validates a saved gate against the same rules,
 * so the tests have to be able to read them without a browser.
 */

import {
  GATE_CARD_MAX,
  GATE_ITEM_MAX,
  clampPercent,
  cloneGateCards,
  gateConfigFrom,
  gateVerdict,
  gateSummaryText,
} from '../workflow-gate.mjs';

export function openGateReview({ node, gateTemplate, canEdit = true, onApply, onClose = () => {} }) {
  const draft = {
    id: node.gateConfig?.id || gateTemplate?.id || 'gate-template',
    title: node.gateConfig?.title || gateTemplate?.title || 'Decision gate review',
    // A gate that carries no cards yet — an imported graph, or one the template
    // filled in — is seeded through gateConfigFrom, so it starts unassessed
    // rather than inheriting the template's pass rates as a verdict.
    cards: node.gateConfig?.cards?.length ? cloneGateCards(node.gateConfig) : gateConfigFrom(gateTemplate).cards,
  };

  const heading = el('h2', { class: 'workflow-gate-heading' }, draft.title);
  const overallBadge = el('span', { class: 'workflow-gate-overall' }, '');
  const summary = el('p', { class: 'workflow-gate-summary', role: 'status' }, '');
  const blockedNote = el('p', { class: 'workflow-gate-blocked' },
    'Approve unlocks once every card carries a pass rate at or above its own threshold.');
  const cardNote = el('p', { class: 'workflow-gate-blocked' },
    'Every card needs a title: a gate whose cards are all untitled is dropped from the graph when it saves.');
  const grid = el('div', { class: 'workflow-gate-cards' });

  const approve = el('button', { type: 'button', class: 'btn primary workflow-gate-approve' }, [
    icon('check', { size: 14 }),
    el('span', {}, 'Allow to move further'),
    el('span', { class: 'workflow-gate-approve-hint' }, '(approve gate)'),
  ]);
  const save = el('button', { type: 'button', class: 'btn' }, 'Save draft');
  const cancel = el('button', { type: 'button', class: 'btn' }, 'Cancel');

  const draftCard = (id) => draft.cards.find((card) => card.id === id);

  function repaint() {
    const verdict = gateVerdict(draft.cards);
    // The model drops a card with no title, and a gate whose cards all end up
    // dropped is removed from the graph with it. So an untitled draft is
    // refused here instead of saving a success toast over a deleted node.
    const titled = draft.cards.some((card) => String(card.title || '').trim());
    summary.textContent = gateSummaryText(draft.cards);
    overallBadge.textContent = `Threshold pass rate: ${verdict.overall}%`;
    blockedNote.hidden = verdict.passed || !canEdit;
    cardNote.hidden = titled;
    save.disabled = !canEdit || !titled;
    approve.disabled = !canEdit || !titled || !verdict.passed;
  }

  function cardElement(card) {
    const status = el('span', { class: 'workflow-gate-card-status' }, '');
    const title = el('input', {
      class: 'workflow-gate-card-title', type: 'text', maxlength: '120', disabled: !canEdit,
      'aria-label': 'Assessment card title', value: card.title,
    });
    const threshold = el('input', {
      class: 'workflow-gate-number', type: 'number', min: '0', max: '100', step: '1', disabled: !canEdit,
      'aria-label': 'Required threshold percent', value: String(card.threshold),
    });
    const passRate = el('input', {
      class: 'workflow-gate-number', type: 'number', min: '0', max: '100', step: '1', disabled: !canEdit,
      'aria-label': 'Current pass rate percent', value: card.passRate == null ? '' : String(card.passRate),
    });

    const paint = () => {
      const current = draftCard(card.id) || card;
      const met = current.passRate != null && current.passRate >= current.threshold;
      status.textContent = current.passRate == null
        ? 'Not assessed'
        : met ? `Passed (${current.passRate}%)` : `Below (${current.passRate}% / needs ${current.threshold}%)`;
      status.dataset.met = String(met);
      repaint();
    };
    const edit = (changes) => {
      const current = draftCard(card.id);
      if (current) Object.assign(current, changes);
      paint();
    };

    title.addEventListener('input', () => {
      edit({ title: title.value });
      if (title.value.trim()) heading.textContent = draft.title;
    });
    threshold.addEventListener('input', () => edit({ threshold: clampPercent(threshold.value) }));
    passRate.addEventListener('input', () => edit({
      passRate: passRate.value === '' ? null : clampPercent(passRate.value),
    }));

    const items = el('div', { class: 'workflow-gate-items' }, card.items.map((value, index) => {
      const input = el('input', {
        class: 'workflow-gate-item', type: 'text', maxlength: '300', disabled: !canEdit,
        'aria-label': `Checklist item ${index + 1} for ${card.title || `card ${index + 1}`}`, value,
      });
      input.addEventListener('input', () => {
        const current = draftCard(card.id);
        if (!current) return;
        current.items = current.items.map((item, i) => (i === index ? input.value : item));
      });
      return el('div', { class: 'workflow-gate-item-row' }, [
        el('span', { class: 'workflow-gate-item-index' }, String(index + 1)),
        input,
      ]);
    }));

    const remove = el('button', { type: 'button', class: 'workflow-gate-card-remove' }, 'Remove card');
    remove.disabled = !canEdit;
    remove.addEventListener('click', () => {
      draft.cards = draft.cards.filter((item) => item.id !== card.id);
      renderCards();
      repaint();
    });

    paint();
    return el('article', { class: 'workflow-gate-card', dataset: { cardId: card.id } }, [
      el('div', { class: 'workflow-gate-card-head' }, [title, status]),
      items,
      el('div', { class: 'workflow-gate-card-foot' }, [
        el('label', { class: 'workflow-gate-metric' }, [el('span', {}, 'Threshold %'), threshold]),
        el('label', { class: 'workflow-gate-metric' }, [el('span', {}, 'Pass rate %'), passRate]),
        canEdit ? remove : null,
      ]),
    ]);
  }

  const addCard = el('button', { type: 'button', class: 'workflow-gate-add-card' }, 'Add assessment card');
  function renderCards() {
    grid.replaceChildren(...draft.cards.map(cardElement));
    addCard.hidden = !canEdit || draft.cards.length >= GATE_CARD_MAX;
    grid.append(addCard);
  }
  addCard.addEventListener('click', () => {
    draft.cards = [...draft.cards, {
      id: `gate-card-${draft.cards.length + 1}-${Math.random().toString(36).slice(2, 7)}`,
      title: '', threshold: 80, passRate: null,
      items: Array.from({ length: GATE_ITEM_MAX }, () => ''),
    }];
    renderCards();
    repaint();
    grid.querySelector('.workflow-gate-card:last-of-type .workflow-gate-card-title')?.focus();
  });

  const titleInput = el('input', {
    class: 'workflow-gate-title-input', type: 'text', maxlength: '160', disabled: !canEdit,
    'aria-label': 'Gate title', value: draft.title,
  });
  titleInput.addEventListener('input', () => {
    draft.title = titleInput.value;
    heading.textContent = titleInput.value || 'Decision gate review';
  });

  const panel = el('div', { class: 'workflow-gate-panel' }, [
    el('div', { class: 'workflow-gate-head' }, [
      el('span', { class: 'workflow-gate-mark' }, icon('board', { size: 18 })),
      el('div', { class: 'workflow-gate-head-copy' }, [
        heading,
        el('p', { class: 'muted' }, 'Review the assessment cards, their thresholds, and the pass rate each one has reached before this lane continues.'),
      ]),
      overallBadge,
    ]),
    el('div', { class: 'workflow-gate-body' }, [
      el('label', { class: 'workflow-gate-field' }, [el('span', {}, 'Gate title'), titleInput]),
      grid,
    ]),
    el('div', { class: 'workflow-gate-actions' }, [
      el('div', { class: 'workflow-gate-actions-copy' }, [summary, blockedNote, cardNote]),
      el('div', { class: 'workflow-gate-actions-buttons' }, [cancel, save, approve]),
    ]),
  ]);

  const applied = (close) => {
    onApply({
      id: draft.id,
      title: draft.title,
      cards: draft.cards.map((card) => ({
        ...card,
        items: card.items.map((item) => String(item).trim()).filter(Boolean).slice(0, GATE_ITEM_MAX),
      })),
    });
    if (close) closeDialog();
  };

  function onKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
    if (event.key !== 'Tab') return;
    // Focus that wanders out behind the dialog loses the operator: cycle inside.
    const focusable = Array.from(panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select, textarea'))
      .filter((item) => item.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function closeDialog() {
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    restore?.focus?.({ preventScroll: true });
    onClose();
  }

  cancel.addEventListener('click', closeDialog);
  save.addEventListener('click', () => applied(false));
  approve.addEventListener('click', () => applied(true));

  const overlay = el('div', {
    class: 'workflow-gate-overlay', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': 'workflow-gate-title',
  }, [panel]);
  heading.id = 'workflow-gate-title';
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) closeDialog(); });

  const restore = document.activeElement;
  renderCards();
  repaint();
  document.body.append(overlay);
  document.addEventListener('keydown', onKeydown, true);
  (canEdit ? titleInput : cancel).focus();

  return { close: closeDialog };
}
