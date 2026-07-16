// Hash router and global workspace shell.

import { api } from './api.js';
import {
  state,
  isImmersiveRoute,
  setActiveRoute,
  setSidebarOpen,
} from './state.js';
import { el } from './dom.js';
import { hydrateIcons } from './icons.js';
import { renderProjects } from './views/projects.js';
import { renderBoard } from './views/board.js';
import { renderBusiness } from './views/business.js';
import { renderAgent } from './views/agent.js';
import { renderCalls } from './views/calls.js';
import { renderTraces } from './views/traces.js';
import { renderSettings } from './views/settings.js';
import { initThemeToggle } from './theme.js';

const routes = {
  agent: renderAgent,
  calls: renderCalls,
  traces: renderTraces,
  business: renderBusiness,
  projects: renderProjects,
  board: renderBoard,
  settings: renderSettings,
};

const routeMeta = {
  agent: { title: 'Agent workspace', eyebrow: 'Workspace' },
  calls: { title: 'Call recorder', eyebrow: 'Workspace' },
  traces: { title: 'Trace analysis', eyebrow: 'Workspace' },
  business: { title: 'Business', eyebrow: 'Planning' },
  projects: { title: 'Projects', eyebrow: 'Planning' },
  board: { title: 'Board', eyebrow: 'Planning' },
  settings: { title: 'Settings', eyebrow: 'System' },
};

// These existing surfaces depend on the configured project-management connection.
const connectionRoutes = new Set(['business', 'projects', 'board']);

function currentRoute() {
  const hash = window.location.hash.replace(/^#\//, '');
  const [name] = hash.split('/');
  if (routes[name]) return name;
  const fallback = routes[state.lastWorkspaceRoute] ? state.lastWorkspaceRoute : 'agent';
  window.history.replaceState(null, '', `#/${fallback}`);
  return fallback;
}

function syncShell(name, view) {
  const meta = routeMeta[name];
  const immersive = isImmersiveRoute(name);
  setActiveRoute(name);

  document.body.dataset.route = name;
  document.title = `AI Fleet — ${meta.title}`;
  document.getElementById('route-eyebrow').textContent = meta.eyebrow;
  document.getElementById('route-title').textContent = meta.title;

  view.className = immersive ? 'view view-immersive' : 'view view-standard';
  view.setAttribute('aria-label', meta.title);

  document.querySelectorAll('#tabs a[data-route]').forEach((link) => {
    const active = link.dataset.route === name;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function syncSidebar(open, { restoreFocus = false } = {}) {
  const sidebar = document.getElementById('app-sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar || !toggle || !backdrop) return;
  const compact = window.matchMedia('(max-width: 900px)').matches;

  setSidebarOpen(open);
  sidebar.classList.toggle('open', state.sidebarOpen);
  toggle.setAttribute('aria-expanded', String(state.sidebarOpen));
  toggle.setAttribute('aria-label', state.sidebarOpen ? 'Close navigation' : 'Open navigation');
  backdrop.hidden = !state.sidebarOpen;
  document.body.classList.toggle('nav-open', state.sidebarOpen);
  sidebar.inert = compact && !state.sidebarOpen;
  if (compact && !state.sidebarOpen) sidebar.setAttribute('aria-hidden', 'true');
  else sidebar.removeAttribute('aria-hidden');

  const backgroundInert = compact && state.sidebarOpen;
  const view = document.getElementById('view');
  const brand = document.querySelector('.brand');
  const context = document.querySelector('.topbar-context');
  const actions = document.querySelector('.topbar-actions');
  const skipLink = document.querySelector('.skip-link');
  if (view) view.inert = backgroundInert;
  if (brand) brand.inert = backgroundInert;
  if (context) context.inert = backgroundInert;
  if (actions) actions.inert = backgroundInert;
  if (skipLink) skipLink.inert = backgroundInert;

  if (state.sidebarOpen) {
    window.requestAnimationFrame(() => {
      sidebar.querySelector('a[aria-current="page"]')?.focus();
    });
  } else if (restoreFocus) {
    toggle.focus();
  }
}

function initShellInteractions() {
  const toggle = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  const sidebar = document.getElementById('app-sidebar');
  const navigation = document.getElementById('tabs');
  const skipLink = document.querySelector('.skip-link');
  const compactLayout = window.matchMedia('(max-width: 900px)');

  toggle?.addEventListener('click', () => syncSidebar(!state.sidebarOpen, { restoreFocus: state.sidebarOpen }));
  backdrop?.addEventListener('click', () => syncSidebar(false, { restoreFocus: true }));
  navigation?.addEventListener('click', (event) => {
    if (event.target.closest('a[data-route]') && compactLayout.matches) syncSidebar(false);
  });
  skipLink?.addEventListener('click', (event) => {
    event.preventDefault();
    document.getElementById('view')?.focus({ preventScroll: true });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.sidebarOpen) syncSidebar(false, { restoreFocus: true });
  });

  const closeAtBreakpoint = (event) => {
    const focusMovesOutside = Boolean(event.matches && sidebar?.contains(document.activeElement));
    syncSidebar(false, { restoreFocus: focusMovesOutside });
  };
  compactLayout.addEventListener?.('change', closeAtBreakpoint);
}

async function refreshConnection() {
  const conn = document.getElementById('conn');
  const text = document.getElementById('conn-text');
  try {
    const settings = await api.getSettings();
    // Existing live Projects/Board/Business APIs remain Linear-backed. The
    // additional Jira/Asana connector choices are stored for planning-tool
    // routing, while local Agent/Calls/Traces never require any tracker key.
    state.hasKey = Boolean(settings.hasKey);
    state.planningConfigured = Boolean(settings.planningConfigured || settings.hasKey);
    state.planningProvider = settings.planningProvider || 'linear';
    if (!state.planningConfigured) {
      conn.className = 'conn';
      text.textContent = 'Setup needed';
      return;
    }
    // The legacy validation endpoint is Linear-specific. Other planning
    // providers are already represented by the normalized settings status.
    if (!settings.planningProvider || settings.planningProvider === 'linear') await api.validate();
    conn.className = 'conn ok';
    text.textContent = settings.planningProvider
      ? `${settings.planningProvider[0].toUpperCase()}${settings.planningProvider.slice(1)} ${settings.planningProvider === 'linear' ? 'connected' : 'configured'}`
      : 'Connected';
  } catch (err) {
    conn.className = 'conn bad';
    text.textContent = 'Needs attention';
  }
}

// Show the currently assumed role in the top toolbar.
async function refreshRole() {
  const chip = document.getElementById('assumed-role');
  if (!chip) return;
  try {
    const { assumedRole } = await api.getAssumedRole();
    if (assumedRole) {
      chip.hidden = false;
      chip.replaceChildren(
        el('span', { class: 'avatar sm' }, (assumedRole.name || '?').slice(0, 2).toUpperCase()),
        el('span', {}, `Acting as ${assumedRole.name}`)
      );
    } else {
      chip.hidden = true;
      chip.replaceChildren();
    }
  } catch (err) {
    chip.hidden = true;
  }
}

let renderEpoch = 0;

function freshView() {
  const previous = document.getElementById('view');
  const view = document.createElement('main');
  view.id = 'view';
  view.className = 'view';
  view.tabIndex = -1;
  previous.replaceWith(view);
  return view;
}

async function render({ focus = false } = {}) {
  const epoch = ++renderEpoch;
  const name = currentRoute();
  const view = freshView();
  syncShell(name, view);
  syncSidebar(false);
  view.setAttribute('aria-busy', 'true');
  if (focus) view.focus({ preventScroll: true });

  // Keep connection-dependent routes useful by explaining the single next step.
  if (!state.hasKey && connectionRoutes.has(name)) {
    const selectedElsewhere = state.planningConfigured && state.planningProvider !== 'linear';
    view.append(
      el('div', { class: 'empty connection-empty' }, [
        el('span', { class: 'empty-mark', 'aria-hidden': 'true' }, '✦'),
        el('h2', {}, selectedElsewhere ? `${capitalize(state.planningProvider)} is configured` : 'Connect your planning workspace'),
        el('p', { class: 'muted' }, selectedElsewhere
          ? 'This live project and board view currently reads Linear. Add a Linear key as well, or use the local Agent, Call, and Trace workspaces.'
          : 'Add a Linear key in Settings, then come back here to load live projects and issues.'),
        el('a', { class: 'btn primary', href: '#/settings' }, 'Open Settings'),
      ])
    );
    view.setAttribute('aria-busy', 'false');
    if (focus) view.focus({ preventScroll: true });
    return;
  }

  try {
    await routes[name](view);
  } catch (err) {
    if (epoch === renderEpoch && view.isConnected) {
      view.append(el('div', { class: 'error-banner' }, err.message || 'This view could not be loaded.'));
    }
  } finally {
    if (epoch !== renderEpoch || !view.isConnected) return;
    view.setAttribute('aria-busy', 'false');
    if (focus) view.focus({ preventScroll: true });
  }
}

function capitalize(value) {
  const text = String(value || '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : '';
}

window.addEventListener('hashchange', () => render({ focus: true }));
window.addEventListener('DOMContentLoaded', async () => {
  hydrateIcons();
  initThemeToggle(document.getElementById('theme-toggle'));
  initShellInteractions();
  await Promise.all([refreshConnection(), refreshRole()]);
  await render();
});

// Allow views to request a connection re-check (e.g. after saving a key).
window.addEventListener('lm:connection-changed', async () => {
  await refreshConnection();
  await render();
});

// Update the toolbar when the assumed role changes.
window.addEventListener('lm:role-changed', refreshRole);
