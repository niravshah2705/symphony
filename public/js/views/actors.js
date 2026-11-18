import { api } from '../api.js';
import { el, clear, toast } from '../dom.js';
import { t } from '../i18n.js';
import { getAuthenticationState } from '../auth.js';
import { permitted } from '../permissions.js';
import { state } from '../state.js';
import { getWorkspaceContext } from '../workspace-context.js';
import { buildActorCards } from '../actor-cards.mjs';

// Substrate actor cards for the organization the switcher pinned.
//
// The data is one already-scoped call: GET /api/agent/substrate/status resolves the
// caller's atespace server-side and lists the actors inside it, so this view never
// names a tenant. The project filter is a display refinement (an Actor carries no
// project field, so the server maps the project to its name prefix) and its result
// is read back from the response rather than assumed.
//
// What a card can do is what the planner exposes: suspend, resume, delete — each
// re-resolves the atespace from the pinned context, so a name copied from another
// tenant's card resolves as absent instead of reachable.

let pending = null; // the actor name whose verb is in flight, to disable just that card
let projectFilter = null; // this view's project choice; null follows the workspace selection
let renderGeneration = 0;

function canControlActors() {
  // Mirrors the gateway: /api/agent is workspace:write for POST/DELETE, so a
  // read-only member sees the board but not the buttons (views/settings.js uses
  // the same `permitted` check for the same reason). When auth is not configured
  // at all — the local development profile — `session.enabled` is false and the
  // gateway admits the call, so the actions stay available.
  const session = getAuthenticationState();
  return !session.enabled || permitted(session.permissions, 'workspace', 'write');
}

function activeProjects() {
  const context = getWorkspaceContext();
  const organization = (context.organizations || [])
    .find((org) => org.id === context.organizationId);
  return organization && Array.isArray(organization.projects) ? organization.projects : [];
}

function selectedProject() {
  const known = activeProjects().map((project) => String(project.id));
  const wanted = projectFilter === null ? state.currentProjectId : projectFilter;
  return known.includes(String(wanted)) ? String(wanted) : '';
}

async function load(projectId, generation) {
  const payload = await api.getSubstrateStatus(projectId ? { projectId } : {});
  // A response to a superseded render is dropped rather than painted, so switching
  // org or project cannot land the previous selection's actors underneath it.
  return generation === renderGeneration ? payload : null;
}

export async function renderActors(view) {
  const generation = ++renderGeneration;
  clear(view);

  const header = el('header', { class: 'actors-header' }, [
    el('h2', {}, t('actors', 'Actor runs')),
    el('p', { class: 'muted' }, t('actorsSub', 'Substrate actors in this organization')),
  ]);
  const controls = el('div', { class: 'actors-controls' });
  const grid = el('section', { class: 'actors-grid' });
  view.append(header, controls, grid);
  await paint(controls, grid, generation);
}

// One repaint = one status call. Every path here (entry, project filter, refresh,
// a verb) reports the control plane's current answer, so nothing caches it: the
// cards drive suspend/resume/delete, and a board that lags the plane by one render
// is a board of buttons aimed at actors that are no longer there.
async function paint(controls, grid, generation) {
  let payload;
  try {
    payload = await load(selectedProject(), generation);
  } catch (error) {
    if (generation !== renderGeneration) return;
    clear(controls);
    clear(grid);
    controls.append(el('p', { class: 'actors-error' },
      `Actor status is unavailable: ${error && error.message ? error.message : String(error)}`));
    return;
  }
  if (generation !== renderGeneration || !payload) return;

  const view = buildActorCards(payload, { canAct: canControlActors() });
  const rerender = () => paint(controls, grid, generation);
  renderControls(controls, payload, view, rerender);
  renderCards(grid, view, rerender);
}

function renderControls(controls, payload, view, rerender) {
  const projects = activeProjects();
  const projectId = selectedProject();
  const select = el('select', {
    class: 'actors-project-filter',
    'aria-label': t('actorsProjectFilter', 'Filter by project'),
    onchange: () => { projectFilter = select.value; rerender(); },
  }, [
    el('option', { value: '' }, t('actorsAllProjects', 'All projects in this organization')),
    ...projects.map((project) => el('option', {
      value: String(project.id),
      selected: String(project.id) === projectId ? 'selected' : null,
    }, project.name || String(project.id))),
  ]);

  const refresh = el('button', {
    type: 'button',
    class: 'btn secondary actors-refresh',
    onclick: () => { refresh.disabled = true; rerender().finally(() => { refresh.disabled = false; }); },
  }, t('refresh', 'Refresh'));

  controls.replaceChildren(
    el('div', { class: 'actors-context' }, [
      el('span', { class: 'actors-atespace' }, payload.atespace ? `atespace: ${payload.atespace}` : t('actorsNoAtespace', 'No atespace resolved')),
      el('span', { class: 'actors-pattern' }, `pattern: ${payload.agentPattern || 'cloudrun'}`),
    ]),
    select,
    refresh,
    el('div', { class: 'actors-summary' }, [
      summaryPill('running', view.counts.running),
      summaryPill('paused', view.counts.paused),
      summaryPill('attention', view.counts.attention),
    ]),
  );
}

function summaryPill(kind, count) {
  return el('span', { class: `actors-pill actors-pill-${kind}` }, `${kind}: ${count}`);
}

function renderCards(grid, view, rerender) {
  clear(grid);
  if (view.projectFilterNote) {
    grid.append(el('p', { class: 'muted actors-filter-note' }, view.projectFilterNote));
  }
  for (const bucket of ['running', 'paused', 'attention']) {
    const cards = view.buckets[bucket];
    if (!cards.length) continue;
    grid.append(el('section', { class: `actors-bucket actors-bucket-${bucket}` }, [
      el('h3', {}, t(`actorsBucket${bucket}`, `Actors ${bucket}`)),
      ...cards.map((actor) => cardFor(actor, bucket, rerender)),
    ]));
  }
  if (view.emptyReason) {
    grid.append(el('p', { class: 'muted actors-empty' }, view.emptyReason));
  }
}

function cardFor(actor, bucket, rerender) {
  const body = [
    el('strong', { class: 'actors-card-name' }, actor.name || '—'),
    el('span', { class: 'actors-card-state' }, actor.state),
    actor.reason ? el('p', { class: 'actors-card-reason' }, actor.reason) : null,
    actor.workerPod ? el('small', { class: 'muted' }, `${actor.workerPod}${actor.nodeName ? ` on ${actor.nodeName}` : ''}`) : null,
  ];
  const actions = el('div', { class: 'actors-card-actions' });
  for (const action of actor.actions) {
    actions.append(el('button', {
      type: 'button',
      class: `btn small actors-action actors-action-${action}`,
      dataset: { actorName: actor.name, actorAction: action },
      disabled: pending === actor.name ? 'disabled' : null,
      onclick: () => runVerb(actor, action, rerender),
    }, action));
  }
  return el('article', {
    class: `metric-card actors-card actors-card-${bucket}`,
    dataset: { actorName: actor.name || '', actorState: actor.state },
  }, [...body.filter(Boolean), actions]);
}

async function runVerb(actor, action, rerender) {
  if (pending) return;
  if (action === 'delete' && !confirm(`Delete actor ${actor.name}? Its run cannot be resumed afterwards.`)) return;
  pending = actor.name;
  const call = { suspend: api.suspendSubstrateActor, resume: api.resumeSubstrateActor, delete: api.deleteSubstrateActor }[action];
  try {
    await call(actor.name);
    toast(`Actor ${actor.name}: ${action} accepted.`, 'ok');
  } catch (error) {
    // A 404 here is the tenant check answering, not a lost card: the name resolved
    // outside this atespace. Say that, and let the refetch drop the stale card
    // rather than keeping a button that will refuse again.
    toast(error && error.status === 404
      ? `Actor ${actor.name} is not in this organization any more.`
      : `Actor ${action} failed: ${error && error.message ? error.message : String(error)}`, 'error');
  } finally {
    pending = null;
    await rerender();
  }
}

/** Drop the view-local filter. A project id chosen under one organization must not
 * narrow the next organization's board — the server answers an out-of-tenant filter
 * with an empty list, which would read as "no actors" rather than "wrong tenant". */
export function invalidate() {
  renderGeneration += 1;
  pending = null;
  projectFilter = null;
}
