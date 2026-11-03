// The global discovery-question bank, edited by hand or with AI help.
//
// This page is served by Firebase Hosting on platform.archagentix.com while the
// gateway is a separate Cloud Run origin, so every call here is cross-origin and
// must go through api.js — it carries the bearer token, the selected-organization
// header, and the single-flight 401 refresh.
//
// initializeAuthentication() is not decoration: it is the only path that confirms
// the identity, fails closed on the organization context, and re-points api.js at
// a PROVISIONED tenant gateway. Skipping it would write this organization's bank
// into the shared gateway's legacy namespace while the admin believes they are
// editing their own.

import { api } from '/js/api.js';
import { getAuthenticationState, initializeAuthentication, signIn, signInWithMicrosoft } from '/js/auth.js';

const DRAFT_KEY = 'archagentix.question-drafts';
const CATEGORIES = ['organisation', 'person', 'project_business'];
const ANSWER_TYPES = ['free_text', 'choice', 'multi_choice', 'number', 'boolean'];
const CATEGORY_LABELS = { organisation: 'Organisation', person: 'Person', project_business: 'Project & business' };
const OPEN_ANSWERS = new Set(['choice', 'multi_choice']);

const state = { questions: [], canEdit: false, categoryFilter: '', originFilter: '' };
let drafts = readDrafts();
let controlsWired = false;

function readDrafts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {}; // a corrupt draft is worth less than the organization's real bank
  }
}

// A dedicated tenant stack reloads the page mid-provisioning (auth.js does that),
// so unsaved typing is kept in sessionStorage rather than lost to the refresh.
function writeDrafts() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  } catch (_) {
    /* storage disabled — editing still works, it just will not survive a reload */
  }
}

function element(id) {
  return document.getElementById(id);
}

function field(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'value') node.value = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

function setStatus(message, tone = '') {
  const node = element('questions-status');
  if (!node) return;
  node.textContent = message || '';
  node.className = `questions-status ${tone}`.trim();
}

function applyDraft(question) {
  const draft = drafts[question.id];
  return draft ? { ...question, ...draft } : question;
}

function visibleQuestions() {
  return state.questions
    .map(applyDraft)
    .filter((question) => !state.categoryFilter || question.category === state.categoryFilter)
    .filter((question) => {
      if (!state.originFilter) return true;
      if (state.originFilter === 'hidden') return question.active === false;
      return question.origin === state.originFilter;
    });
}

/* --------------------------------- header ---------------------------------- */

function renderIdentity(authState) {
  const chip = element('questions-org');
  if (!chip) return;
  if (!authState?.authenticated) {
    chip.textContent = 'Not signed in';
    chip.dataset.state = 'anonymous';
    return;
  }
  // The org choice is device-local, so the panel states which organization it is
  // actually talking to — a second tab may have selected a different one.
  const deployment = authState.deploymentStatus && authState.deploymentStatus !== 'shared'
    ? ` · ${authState.deploymentStatus}`
    : '';
  chip.textContent = `${authState.orgName || 'Selected organization'} · ${authState.role}${deployment}`;
  chip.dataset.state = authState.deploymentStatus === 'provisioning' ? 'pending' : 'ready';
}

function renderAuthGate(authState, error) {
  const gate = element('questions-auth');
  if (!gate) return;
  gate.textContent = '';
  gate.hidden = Boolean(authState?.authenticated) && !error;

  const message = field('p', {
    text: error
      ? error.message
      : 'Sign in to read or edit this organization’s discovery questions.',
  });
  gate.append(message);
  if (error) return;

  const actions = field('div', { class: 'auth-actions' });
  for (const [label, handler] of [['Sign in with Google', signIn], ['Sign in with Microsoft', signInWithMicrosoft]]) {
    const button = field('button', { type: 'button', class: 'btn btn-primary', text: label });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await handler();
        await openBank(); // the session resolves asynchronously; re-run the gate
      } catch (_) {
        button.disabled = false;
        setStatus('Sign-in did not complete.', 'error');
      }
    });
    actions.append(button);
  }
  gate.append(actions);
}

/* ------------------------------- the table --------------------------------- */

function bindEdit(node, question, key) {
  if (!state.canEdit) return node;
  node.addEventListener('change', () => {
    const draft = drafts[question.id] || (drafts[question.id] = {});
    draft[key] = node.value;
    writeDrafts();
    renderActionsCell(question);
    if (key === 'answerType') renderTable(); // choices are only meaningful for choice types
  });
  return node;
}

function textCell(question, key, { multiline = false, maxlength = '600', value = '', className = '' } = {}) {
  if (!state.canEdit) return field('span', { text: value || '—', class: `read-only ${className}`.trim() });
  const node = multiline
    ? field('textarea', { rows: '2', maxlength, class: className })
    : field('input', { type: 'text', maxlength, class: className });
  node.value = value;
  return bindEdit(node, question, key);
}

/** Only org-authored rows carry their own grouping; a platform default's is versioned in code. */
function orgOwned(question) {
  return Boolean(question.isNew) || question.origin === 'custom';
}

function renderActionsCell(question) {
  const cell = document.querySelector(`[data-actions-for="${cssEscape(question.id)}"]`);
  if (!cell) return;
  cell.textContent = '';
  cell.append(...actionButtons(question));
}

function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function actionButtons(question) {
  if (!state.canEdit) return [field('span', { text: 'view only', class: 'muted' })];

  const dirty = Boolean(drafts[question.id]);
  const buttons = [];
  if (dirty) {
    const save = field('button', { class: 'btn btn-primary', text: question.isNew ? 'Create' : 'Save' });
    save.addEventListener('click', () => saveQuestion(question));
    const discard = field('button', {
      class: 'btn',
      text: question.isNew ? 'Cancel' : 'Discard',
      title: 'Clears the unsaved edits in this row; the stored bank is untouched.',
    });
    discard.addEventListener('click', () => {
      delete drafts[question.id];
      if (question.isNew) state.questions = state.questions.filter((row) => row.id !== question.id);
      writeDrafts();
      renderTable();
    });
    buttons.push(save, discard);
  }
  if (question.isNew) return buttons;

  if (question.origin !== 'custom') {
    buttons.push(field('span', { text: dirty ? 'unsaved' : 'up to date', class: 'muted' }));
    const toggle = field('button', {
      class: 'btn',
      text: question.active === false ? 'Restore' : 'Hide',
      title: 'A platform default is switched off with a tombstone, so a future bank revision cannot resurrect it.',
    });
    toggle.addEventListener('click', () => toggleActive(question));
    buttons.push(toggle);
  } else {
    const remove = field('button', { class: 'btn btn-danger', text: 'Delete' });
    remove.addEventListener('click', () => deleteQuestion(question));
    buttons.push(remove);
  }
  return buttons;
}

function renderTable() {
  const body = element('questions-body');
  if (!body) return;
  body.textContent = '';

  for (const question of visibleQuestions()) {
    const row = document.createElement('tr');
    row.dataset.questionId = question.id;
    if (question.active === false) row.classList.add('is-hidden');

    const categoryCell = state.canEdit && orgOwned(question)
      ? (() => {
        const select = field('select', { 'aria-label': 'Category' });
        for (const value of CATEGORIES) {
          const option = field('option', { value, text: CATEGORY_LABELS[value] });
          if (question.category === value) option.selected = true;
          select.append(option);
        }
        return bindEdit(select, question, 'category');
      })()
      : field('span', { text: CATEGORY_LABELS[question.category] || question.category, class: 'grouping-locked' });
    row.append(field('td', { class: 'nowrap' }, categoryCell));

    row.append(field('td', {}, orgOwned(question)
      ? textCell(question, 'subDimension', { maxlength: '60', value: question.subDimension, className: 'sub-dimension' })
      : field('span', {
        text: question.subDimension || '—',
        class: 'read-only sub-dimension',
        title: 'A platform default keeps its sub-dimension — edit its text, answer type and choices instead.',
      })));
    row.append(field('td', {}, textCell(question, 'question', { multiline: true, value: question.question, className: 'question-text' })));
    row.append(field('td', {}, textCell(question, 'whyItMatters', { multiline: true, value: question.whyItMatters, className: 'why-text' })));

    if (state.canEdit) {
      const select = field('select', { 'aria-label': 'Answer type' });
      for (const value of ANSWER_TYPES) {
        const option = field('option', { value, text: value });
        if (question.answerType === value) option.selected = true;
        select.append(option);
      }
      row.append(field('td', {}, bindEdit(select, question, 'answerType')));
    } else {
      row.append(field('td', { text: question.answerType, class: 'nowrap' }));
    }

    const needsChoices = OPEN_ANSWERS.has(question.answerType);
    if (state.canEdit && needsChoices) {
      const choices = field('input', { type: 'text', class: 'choices-input', placeholder: 'comma, separated, options', value: (question.choices || []).join(', ') });
      choices.addEventListener('change', () => {
        const draft = drafts[question.id] || (drafts[question.id] = {});
        draft.choices = choices.value.split(',').map((choice) => choice.trim()).filter(Boolean).slice(0, 10);
        writeDrafts();
        renderActionsCell(question);
      });
      row.append(field('td', {}, choices));
    } else {
      row.append(field('td', { text: needsChoices ? (question.choices || []).join(', ') : '—', class: 'choices-readout' }));
    }

    row.append(field('td', {
      text: question.active === false ? 'hidden' : question.origin,
      class: `origin-cell origin-${question.origin}`,
    }));

    const actions = field('td', { 'data-actions-for': question.id });
    actions.append(...actionButtons(question));
    row.append(actions);
    body.append(row);
  }

  const count = element('questions-count');
  if (count) {
    const active = state.questions.filter((question) => question.active !== false).length;
    count.textContent = `${visibleQuestions().length} shown · ${active} active of ${state.questions.length}`;
  }
}

/* -------------------------------- mutations -------------------------------- */

function patchFor(question) {
  const draft = drafts[question.id] || {};
  const patch = {
    question: draft.question ?? question.question,
    whyItMatters: draft.whyItMatters ?? question.whyItMatters,
    answerType: draft.answerType ?? question.answerType,
    choices: draft.choices ?? question.choices ?? [],
  };
  if (OPEN_ANSWERS.has(patch.answerType)) {
    patch.choices = patch.choices.map((choice) => String(choice).trim()).filter(Boolean).slice(0, 10);
  } else {
    patch.choices = [];
  }
  // A platform default keeps its grouping: the route rejects a category or
  // sub-dimension on one, because mergeBank re-forces those from the versioned bank.
  if (orgOwned(question)) {
    patch.subDimension = draft.subDimension ?? question.subDimension;
    patch.category = draft.category ?? question.category;
    patch.order = question.order;
  }
  return patch;
}

async function saveQuestion(question) {
  setStatus(question.isNew ? 'Creating…' : 'Saving…');
  try {
    if (question.isNew) await api.createGlobalQuestion(patchFor(question));
    else await api.updateGlobalQuestion(question.id, patchFor(question));
    delete drafts[question.id];
    writeDrafts();
    await loadBank();
    setStatus('Saved.', 'success');
  } catch (error) {
    setStatus(error.message || 'The bank rejected this edit.', 'error');
  }
}

async function toggleActive(question) {
  setStatus(question.active === false ? 'Restoring…' : 'Hiding…');
  try {
    await api.updateGlobalQuestion(question.id, { active: question.active === false });
    await loadBank();
    setStatus('Done.', 'success');
  } catch (error) {
    setStatus(error.message || 'That change did not save.', 'error');
  }
}

async function deleteQuestion(question) {
  if (!window.confirm(`Delete “${question.question}”? This org-authored question is removed entirely.`)) return;
  try {
    await api.removeGlobalQuestion(question.id);
    delete drafts[question.id];
    writeDrafts();
    await loadBank();
    setStatus('Question deleted.', 'success');
  } catch (error) {
    setStatus(error.message || 'The question could not be deleted.', 'error');
  }
}

function addQuestionRow() {
  state.questions.push({
    id: `gq_custom_new_${Date.now()}`,
    isNew: true,
    category: state.categoryFilter || 'organisation',
    subDimension: '',
    order: state.questions.length + 1,
    question: '',
    whyItMatters: '',
    answerType: 'free_text',
    choices: [],
    active: true,
    origin: 'custom',
  });
  renderTable();
  const rows = element('questions-body')?.querySelectorAll('tr');
  rows?.[rows.length - 1]?.querySelector('input, select')?.focus();
}

async function loadBank() {
  setStatus('Loading question bank…');
  try {
    const payload = await api.listGlobalQuestions();
    state.questions = payload.questions || [];
    renderTable();
    setStatus(`Bank version ${payload.bankVersion} loaded.`, 'success');
  } catch (error) {
    setStatus(error.message || 'The question bank could not be loaded.', 'error');
  }
}

/* ------------------------------- AI assistance ------------------------------ */

function draftFromAI(mode) {
  const payload = {
    mode,
    category: element('ai-category').value,
    subDimension: element('ai-subdimension').value.trim(),
    instruction: element('ai-instruction').value.trim(),
  };
  if (!payload.instruction) {
    setStatus(mode === 'import' ? 'Paste the question list first.' : 'Describe what you want drafted first.', 'error');
    return;
  }
  setStatus('Drafting with the local model…');
  api.assistGlobalQuestions(payload)
    .then((result) => {
      renderProposals(result);
      setStatus(`${result.proposals.length} proposed.`, 'success');
      for (const warning of result.warnings || []) setStatus(warning, 'error');
    })
    .catch((error) => setStatus(error.message || 'AI drafting failed — is a local model configured in Settings?', 'error'));
}

function renderProposals(result) {
  const list = element('ai-proposals');
  list.textContent = '';
  list.append(field('p', {
    text: result.provenance?.usedFallback
      ? 'The local model was unavailable, so a safe basic read of your text was used. Nothing is saved until you press Save.'
      : 'Proposals only — nothing is saved until you press Save.',
    class: 'ai-provenance',
  }));

  if (!result.proposals.length) {
    list.append(field('p', { text: 'No usable proposals this time.', class: 'muted' }));
    return;
  }

  for (const proposal of result.proposals) {
    const card = field('div', { class: 'proposal-card' });
    card.append(field('strong', { text: proposal.question }));
    card.append(field('p', {
      text: `${CATEGORY_LABELS[proposal.category] || proposal.category} · ${proposal.subDimension || '—'} · ${proposal.answerType}`,
      class: 'muted',
    }));
    const save = field('button', { class: 'btn btn-primary', text: proposal.origin === 'customised' ? 'Apply to default' : 'Add to bank' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        if (proposal.origin === 'customised') {
          await api.updateGlobalQuestion(proposal.id, {
            question: proposal.question,
            whyItMatters: proposal.whyItMatters,
            answerType: proposal.answerType,
            choices: proposal.choices,
          });
        } else {
          const { id, origin, revision, ...created } = proposal;
          await api.createGlobalQuestion(created);
        }
        await loadBank();
        card.classList.add('is-saved');
        save.textContent = 'Saved';
      } catch (error) {
        save.disabled = false;
        setStatus(error.message || 'That proposal could not be saved.', 'error');
      }
    });
    card.append(save);
    list.append(card);
  }
}

/* ---------------------------------- wiring ---------------------------------- */

function wireControls() {
  if (controlsWired) return;
  controlsWired = true;

  const category = element('questions-filter');
  category.append(...CATEGORIES.map((value) => field('option', { value, text: CATEGORY_LABELS[value] })));
  category.addEventListener('change', () => {
    state.categoryFilter = category.value;
    renderTable();
  });

  const origin = element('questions-origin');
  origin.append(
    field('option', { value: 'default', text: 'Platform default' }),
    field('option', { value: 'customised', text: 'Customised' }),
    field('option', { value: 'custom', text: 'Org-authored' }),
    field('option', { value: 'hidden', text: 'Hidden' })
  );
  origin.addEventListener('change', () => {
    state.originFilter = origin.value;
    renderTable();
  });

  element('questions-add').addEventListener('click', addQuestionRow);
  element('questions-reload').addEventListener('click', () => loadBank());

  const drawer = element('questions-drawer');
  element('questions-ai').addEventListener('click', () => {
    drawer.hidden = !drawer.hidden;
  });
  element('ai-suggest').addEventListener('click', () => draftFromAI('suggest'));
  element('ai-rewrite').addEventListener('click', () => draftFromAI('rewrite'));
  element('ai-import').addEventListener('click', () => draftFromAI('import'));
  element('ai-close').addEventListener('click', () => {
    drawer.hidden = true;
  });
}

async function openBank() {
  let authState;
  try {
    authState = await initializeAuthentication();
  } catch (error) {
    renderAuthGate(getAuthenticationState(), error);
    setStatus('Sign-in is required before this bank can be opened.', 'error');
    return;
  }
  renderIdentity(authState);
  renderAuthGate(authState);

  // Server-side gates are the real enforcement; hiding these controls only keeps a
  // viewer from typing into fields that would 403 on save.
  state.canEdit = authState.permissions?.settings === 'write';
  for (const node of document.querySelectorAll('#questions .edit-only')) node.hidden = !state.canEdit;

  if (!authState.authenticated) {
    setStatus('Sign in to load this organization’s bank.');
    return;
  }
  await loadBank();
}

export async function initQuestionBank() {
  wireControls();
  await openBank();
}
