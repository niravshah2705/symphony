import { api } from '../api.js';
import { state, setCurrentProject } from '../state.js';
import { el, clear, esc, toast, loading } from '../dom.js';

export async function renderBoard(view) {
  view.append(loading('Loading projects…'));
  const { projects } = await api.getProjects();
  clear(view);

  if (!projects.length) {
    view.append(el('div', { class: 'empty' }, [el('h2', {}, 'No projects'), el('p', { class: 'muted' }, 'Create a project in Linear first.')]));
    return;
  }

  // Default the selected project to the stored one, else the first project.
  let selectedId = state.currentProjectId && projects.some((p) => p.id === state.currentProjectId)
    ? state.currentProjectId
    : projects[0].id;
  setCurrentProject(selectedId);

  const selector = el(
    'select',
    { style: 'max-width:280px' },
    projects.map((p) => el('option', { value: p.id, selected: p.id === selectedId, dataset: { userContent: 'true' } }, p.name))
  );

  const boardHost = el('div', {});

  async function loadBoard() {
    clear(boardHost).append(loading('Loading board…'));
    try {
      const data = await api.getBoard(selectedId);
      renderColumns(boardHost, data, loadBoard);
    } catch (err) {
      clear(boardHost).append(el('div', { class: 'error-banner' }, err.message));
    }
  }

  selector.addEventListener('change', () => {
    selectedId = selector.value;
    setCurrentProject(selectedId);
    loadBoard();
  });

  view.append(
    el('div', { class: 'page-head' }, [
      el('h1', {}, 'Issues Board'),
      el('div', { class: 'row' }, [
        el('label', { style: 'margin:0' }, 'Project'),
        selector,
        el('button', { onclick: loadBoard }, '↻ Refresh'),
      ]),
    ]),
    boardHost
  );

  await loadBoard();
}

function renderColumns(host, data, reload) {
  clear(host);
  if (!data.columns.length) {
    host.append(el('div', { class: 'empty' }, [el('p', { class: 'muted' }, 'This project has no issues yet.')]));
    return;
  }

  const board = el('div', { class: 'board' });
  for (const col of data.columns) {
    board.append(columnNode(col, reload));
  }
  host.append(board);
}

function columnNode(col, reload) {
  const body = el('div', { class: 'column-body', dataset: { stateId: col.id } });
  for (const issue of col.issues) {
    body.append(issueCard(issue));
  }

  // Drop handling — move issue to this column's state.
  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    body.parentElement.classList.add('drop-hover');
  });
  body.addEventListener('dragleave', () => body.parentElement.classList.remove('drop-hover'));
  body.addEventListener('drop', async (e) => {
    e.preventDefault();
    body.parentElement.classList.remove('drop-hover');
    const issueId = e.dataTransfer.getData('text/issue-id');
    const fromState = e.dataTransfer.getData('text/from-state');
    if (!issueId || fromState === col.id) return;
    try {
      await api.moveIssue(issueId, col.id);
      toast(`Moved to ${col.name}.`, 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  return el('div', { class: 'column' }, [
    el('div', { class: 'column-head' }, [
      el('span', { class: 'swatch', style: `background:${esc(col.color || '#888')}` }),
      el('span', {}, col.name),
      el('span', { class: 'spacer' }),
      el('span', { class: 'count' }, String(col.issues.length)),
    ]),
    body,
  ]);
}

function issueCard(issue) {
  const card = el('div', { class: 'issue-card', draggable: 'true' }, [
    el('div', { class: 'title', dataset: { userContent: 'true' } }, issue.title),
    el('div', { class: 'meta' }, [
      el('span', { dataset: { userContent: 'true' } }, issue.identifier || ''),
      issue.priority ? el('span', { class: `prio prio-${issue.priority}` }, issue.priorityLabel || `P${issue.priority}`) : null,
      el('span', { class: 'spacer' }),
      issue.assignee ? el('span', { dataset: { userContent: 'true' } }, issue.assignee.displayName || issue.assignee.name) : null,
    ]),
  ]);

  card.addEventListener('dragstart', (e) => {
    card.classList.add('dragging');
    e.dataTransfer.setData('text/issue-id', issue.id);
    e.dataTransfer.setData('text/from-state', issue.state ? issue.state.id : '');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}
