import { api } from '../api.js';
import { state, setCurrentProject } from '../state.js';
import { el, clear, fmtDate, fmtPercent, esc, loading } from '../dom.js';

function hashProjectId() {
  const parts = window.location.hash.replace(/^#\//, '').split('/');
  return parts[0] === 'projects' && parts[1] ? decodeURIComponent(parts[1]) : '';
}

export async function renderProjects(view) {
  const projectId = hashProjectId();
  if (projectId) return renderPlanning(view, projectId);

  view.append(el('div', { class: 'page-head' }, [el('h1', {}, 'Projects')]), loading());
  const { projects } = await api.getProjects();
  clear(view).append(el('div', { class: 'page-head' }, [el('h1', {}, 'Projects')]));

  if (!projects.length) {
    view.append(el('div', { class: 'empty' }, [el('h2', {}, 'No projects yet'), el('p', { class: 'muted' }, 'Create a project in Linear or via the Business tab.')]));
    return;
  }

  const grid = el('div', { class: 'grid cols' });
  for (const p of projects) {
    grid.append(projectCard(p));
  }
  view.append(grid);
}

function projectCard(p) {
  const pct = fmtPercent(p.progress);
  const card = el('div', { class: 'project-card card' }, [
    el('div', { class: 'row' }, [
      el('h3', {}, p.name),
      el('span', { class: 'spacer' }),
      el('span', { class: `badge state-${esc(p.state || '')}` }, p.state || 'no state'),
    ]),
    p.description ? el('p', { class: 'muted', style: 'margin:0;font-size:13px' }, truncate(p.description, 120)) : null,
    el('div', { class: 'progress' }, [el('span', { style: `width:${pct}%` })]),
    el('div', { class: 'row muted', style: 'font-size:12px' }, [
      el('span', {}, `${pct}% complete`),
      el('span', { class: 'spacer' }),
      el('span', {}, `Target: ${fmtDate(p.targetDate)}`),
    ]),
  ]);
  card.addEventListener('click', () => {
    setCurrentProject(p.id);
    window.location.hash = `#/projects/${encodeURIComponent(p.id)}`;
  });
  return card;
}

async function renderPlanning(view, projectId) {
  view.append(loading('Loading planning view…'));
  const [{ project, milestones }, board] = await Promise.all([
    api.getMilestones(projectId),
    api.getBoard(projectId).catch(() => ({ columns: [] })),
  ]);
  setCurrentProject(projectId);

  // Group issues by milestone id (plus an "Unscheduled" bucket).
  const issues = (board.columns || []).flatMap((c) => c.issues);
  const byMilestone = new Map();
  for (const issue of issues) {
    const key = issue.projectMilestone ? issue.projectMilestone.id : '__none__';
    if (!byMilestone.has(key)) byMilestone.set(key, []);
    byMilestone.get(key).push(issue);
  }

  clear(view).append(
    el('div', { class: 'page-head' }, [
      el('div', { class: 'row' }, [
        el('a', { class: 'btn', href: '#/projects' }, '← Projects'),
        el('h1', {}, project.name),
        el('span', { class: `badge state-${esc(project.state || '')}` }, project.state || ''),
      ]),
      el('div', { class: 'row' }, [
        el('a', { class: 'btn', href: '#/board' }, 'Open Board →'),
      ]),
    ])
  );

  // Project summary bar.
  const pct = fmtPercent(project.progress);
  view.append(
    el('div', { class: 'card', style: 'margin-bottom:20px' }, [
      project.description ? el('p', { class: 'muted', style: 'margin-top:0' }, project.description) : null,
      el('div', { class: 'progress' }, [el('span', { style: `width:${pct}%` })]),
      el('div', { class: 'row muted', style: 'font-size:12px;margin-top:8px' }, [
        el('span', {}, `${pct}% complete`),
        el('span', { class: 'spacer' }),
        el('span', {}, `Start: ${fmtDate(project.startDate)}`),
        el('span', {}, `Target: ${fmtDate(project.targetDate)}`),
      ]),
    ])
  );

  view.append(el('h2', { style: 'font-size:16px' }, 'Milestone plan'));

  if (!milestones.length && !byMilestone.get('__none__')) {
    view.append(el('div', { class: 'empty' }, [el('p', { class: 'muted' }, 'No milestones defined for this project yet.')]));
    return;
  }

  const timeline = el('div', { class: 'timeline' });
  for (const m of milestones) {
    timeline.append(milestoneNode(m, byMilestone.get(m.id) || []));
  }
  const unscheduled = byMilestone.get('__none__') || [];
  if (unscheduled.length) {
    timeline.append(
      milestoneNode({ name: 'Unscheduled', targetDate: null, description: 'Issues not attached to a milestone.' }, unscheduled)
    );
  }
  view.append(timeline);
}

function milestoneNode(m, issues) {
  const done = issues.filter((i) => i.state && i.state.type === 'completed').length;
  return el('div', { class: 'milestone' }, [
    el('div', { class: 'm-head' }, [
      el('h4', {}, m.name),
      el('span', { class: 'date' }, fmtDate(m.targetDate)),
      el('span', { class: 'spacer' }),
      el('span', { class: 'badge' }, `${done}/${issues.length} done`),
    ]),
    m.description ? el('p', { class: 'muted', style: 'margin:4px 0;font-size:13px' }, m.description) : null,
    issues.length
      ? el(
          'div',
          { class: 'milestone-issues' },
          issues.map((i) =>
            el('div', { class: 'mini-issue' }, [
              el('span', { class: 'id' }, i.identifier || ''),
              el('span', {}, i.title),
              el('span', { class: 'spacer' }),
              i.state ? el('span', { class: 'badge' }, i.state.name) : null,
            ])
          )
        )
      : el('p', { class: 'muted', style: 'font-size:12px' }, 'No issues yet.'),
  ]);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
