// Hash router and global workspace shell.

import { api } from './api.js';
import {
  state,
  isImmersiveRoute,
  setActiveRoute,
  setSidebarOpen,
  setSidebarCollapsed,
} from './state.js';
import { el, initials } from './dom.js';
import { hydrateIcons } from './icons.js';
import { initializeI18n, localize, t } from './i18n.js';
import {
  expireAuthentication,
  getAuthenticationState,
  initializeAuthentication,
  promptOneTap,
  signIn,
  signOut,
} from './auth.js';
import { renderProjects } from './views/projects.js';
import { renderBoard } from './views/board.js';
import { renderBusiness } from './views/business.js';
import { renderAgent } from './views/agent.js';
import { renderAgentJobs } from './views/agent-jobs.js';
import { renderCalls } from './views/calls.js';
import { renderTraces } from './views/traces.js';
import { renderAnalytics } from './views/analytics.js';
import { renderWorkflows } from './views/workflows.js';
import { renderTroubleshooting } from './views/troubleshooting.js';
import { renderSettings } from './views/settings.js';
import { renderOrganization } from './views/organization.js';
import { initThemeToggle } from './theme.js';
import { canAccessRoute, permitted, DEFAULT_PUBLIC_ROUTE } from './permissions.js';

const routes = {
  agent: renderAgent,
  'agent-jobs': renderAgentJobs,
  calls: renderCalls,
  traces: renderTraces,
  business: renderBusiness,
  projects: renderProjects,
  board: renderBoard,
  analytics: renderAnalytics,
  workflows: renderWorkflows,
  troubleshooting: renderTroubleshooting,
  settings: renderSettings,
  organization: renderOrganization,
};

const routeMeta = {
  agent: { titleKey: 'agentWorkspace', eyebrowKey: 'workspace' },
  'agent-jobs': { titleKey: 'agentJobs', eyebrowKey: 'workspace' },
  calls: { titleKey: 'callRecorder', eyebrowKey: 'workspace' },
  traces: { titleKey: 'traceAnalysis', eyebrowKey: 'workspace' },
  business: { titleKey: 'business', eyebrowKey: 'planning' },
  projects: { titleKey: 'projects', eyebrowKey: 'planning' },
  board: { titleKey: 'board', eyebrowKey: 'planning' },
  analytics: { titleKey: 'analytics', eyebrowKey: 'insights' },
  workflows: { titleKey: 'workflows', eyebrowKey: 'insights' },
  troubleshooting: { titleKey: 'troubleshooting', eyebrowKey: 'system' },
  settings: { titleKey: 'settings', eyebrowKey: 'system' },
  organization: { titleKey: 'organization', eyebrowKey: 'workspace' },
};

// These existing surfaces depend on the configured project-management connection.
const connectionRoutes = new Set(['business', 'projects', 'board']);
const CONNECTION_TIMEOUT_MS = 8_000;

function currentRoute() {
  const hash = window.location.hash.replace(/^#\//, '');
  const [name] = hash.split('/');
  if (routes[name]) return name;
  const fallback = routes[state.lastWorkspaceRoute] ? state.lastWorkspaceRoute : 'agent';
  window.history.replaceState(null, '', `#/${fallback}`);
  return fallback;
}

// Hide nav links (and their now-empty sections) the current permissions don't
// allow. UX only — the gateway enforces the same rules on every /api route.
function applyMenuPermissions(permissions) {
  const nav = document.getElementById('tabs');
  if (!nav) return;
  nav.querySelectorAll('a[data-route]').forEach((link) => {
    link.hidden = !canAccessRoute(permissions, link.dataset.route);
  });
  nav.querySelectorAll('.nav-section').forEach((section) => {
    const links = section.querySelectorAll('a[data-route]');
    const anyVisible = Array.from(links).some((link) => !link.hidden);
    section.hidden = links.length > 0 && !anyVisible;
  });
}

// Connection/role toolbar refreshes call permission-gated APIs — only run them
// for a session that actually holds the permission (avoids public 401 noise).
function maybeRefreshConnection(session) {
  if (session.authenticated && permitted(session.permissions, 'settings', 'read')) return refreshConnection();
  return Promise.resolve();
}
function maybeRefreshRole(session) {
  if (session.authenticated && permitted(session.permissions, 'settings', 'write')) return refreshRole();
  const chip = document.getElementById('assumed-role');
  if (chip) { chip.hidden = true; chip.replaceChildren(); }
  return Promise.resolve();
}

function syncShell(name, view) {
  const meta = routeMeta[name];
  const title = t(meta.titleKey);
  const eyebrow = t(meta.eyebrowKey);
  const immersive = isImmersiveRoute(name);
  setActiveRoute(name);

  document.body.dataset.route = name;
  document.title = `AI Fleet — ${title}`;
  const routeEyebrow = document.getElementById('route-eyebrow');
  const routeTitle = document.getElementById('route-title');
  routeEyebrow.dataset.i18n = meta.eyebrowKey;
  routeTitle.dataset.i18n = meta.titleKey;
  routeEyebrow.textContent = eyebrow;
  routeTitle.textContent = title;

  view.className = immersive ? 'view view-immersive' : 'view view-standard';
  view.setAttribute('aria-label', title);

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
  toggle.dataset.i18n = state.sidebarOpen ? 'closeNavigation' : 'openNavigation';
  toggle.setAttribute('aria-label', state.sidebarOpen ? t('closeNavigation') : t('openNavigation'));
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

function syncSidebarCollapsed(collapsed = state.sidebarCollapsed) {
  const button = document.getElementById('sidebar-collapse');
  setSidebarCollapsed(collapsed);
  document.body.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  if (!button) return;
  button.dataset.i18n = state.sidebarCollapsed ? 'expandNavigation' : 'collapseNavigation';
  button.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
  button.setAttribute('aria-pressed', String(state.sidebarCollapsed));
  button.setAttribute('aria-label', state.sidebarCollapsed ? t('expandNavigation') : t('collapseNavigation'));
  button.title = state.sidebarCollapsed ? t('expandNavigation') : t('collapseNavigation');
}

function initShellInteractions() {
  const toggle = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  const sidebar = document.getElementById('app-sidebar');
  const collapse = document.getElementById('sidebar-collapse');
  const navigation = document.getElementById('tabs');
  const skipLink = document.querySelector('.skip-link');
  const compactLayout = window.matchMedia('(max-width: 900px)');

  toggle?.addEventListener('click', () => syncSidebar(!state.sidebarOpen, { restoreFocus: state.sidebarOpen }));
  collapse?.addEventListener('click', () => syncSidebarCollapsed(!state.sidebarCollapsed));
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
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  try {
    const settings = await api.getSettings({ signal: controller.signal });
    // Existing live Projects/Board/Business APIs remain Linear-backed. The
    // additional Jira/Asana connector choices are stored for planning-tool
    // routing, while local Agent/Calls/Traces never require any tracker key.
    state.hasKey = Boolean(settings.hasKey);
    state.planningConfigured = Boolean(settings.planningConfigured || settings.hasKey);
    state.planningProvider = settings.planningProvider || 'linear';
    if (!state.planningConfigured) {
      conn.className = 'conn';
      text.dataset.i18n = 'setupNeeded';
      text.textContent = t('setupNeeded');
      return;
    }
    // The legacy validation endpoint is Linear-specific. Other planning
    // providers are already represented by the normalized settings status.
    if (!settings.planningProvider || settings.planningProvider === 'linear') {
      await api.validate({ signal: controller.signal });
    }
    conn.className = 'conn ok';
    if (settings.planningProvider) {
      delete text.dataset.i18n;
      text.textContent = `${settings.planningProvider[0].toUpperCase()}${settings.planningProvider.slice(1)} ${settings.planningProvider === 'linear' ? 'connected' : 'configured'}`;
    } else {
      text.dataset.i18n = 'connected';
      text.textContent = t('connected');
    }
  } catch (err) {
    conn.className = 'conn bad';
    text.dataset.i18n = 'needsAttention';
    text.textContent = t('needsAttention');
  } finally {
    window.clearTimeout(timeout);
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
        el('span', { dataset: { userContent: 'true' } }, t('actingAs', 'Acting as {name}', { name: assumedRole.name }))
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

function setAuthenticationLocked(locked) {
  document.body.classList.toggle('auth-locked', locked);
  const sidebar = document.getElementById('app-sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  if (sidebar) sidebar.inert = locked;
  if (toggle) toggle.disabled = locked;
  if (!locked) syncSidebar(false);
}

async function beginSignIn() {
  try {
    await signIn();
  } catch (error) {
    expireAuthentication(error.message);
    renderAuthControl();
    renderAuthenticationGate({ error: error.message });
  }
}

async function beginSignOut() {
  try {
    await signOut();
  } catch (error) {
    expireAuthentication(error.message);
    renderAuthControl();
    renderAuthenticationGate({ error: error.message });
  }
}

function renderAuthControl() {
  const host = document.getElementById('auth-control');
  if (!host) return;
  const session = getAuthenticationState();
  host.replaceChildren();
  host.hidden = !session.enabled;
  if (!session.enabled) return;

  if (!session.authenticated || !session.user) {
    host.append(el('button', {
      class: 'auth-sign-in',
      type: 'button',
      onclick: beginSignIn,
      dataset: { i18n: 'signIn' },
    }, t('signIn')));
    return;
  }

  const label = session.user.name || session.user.email || t('signedInUser');
  const secondary = session.user.email && session.user.email !== label ? session.user.email : t('googleAccount');
  host.append(
    el('div', { class: 'auth-user', title: label, dataset: { userContent: 'true' } }, [
      el('span', { class: 'avatar sm', 'aria-hidden': 'true' }, initials(label)),
      el('span', { class: 'auth-user-copy' }, [
        el('strong', {}, label),
        el('small', {}, secondary),
      ]),
    ]),
    el('button', {
      class: 'auth-sign-out',
      type: 'button',
      title: t('signOut'),
      'aria-label': t('signOut'),
      onclick: beginSignOut,
      dataset: { i18n: 'signOut', i18nAttr: 'aria-label' },
    }, t('signOut'))
  );
}

function renderAuthenticationGate({ loading = false, error = '' } = {}) {
  const session = getAuthenticationState();
  const view = freshView();
  setAuthenticationLocked(true);
  document.body.dataset.route = 'authentication';
  document.title = `AI Fleet — ${t('authentication')}`;
  view.className = 'view view-standard auth-view';
  view.setAttribute('aria-label', t('authentication'));
  view.setAttribute('aria-busy', String(loading));

  const routeEyebrow = document.getElementById('route-eyebrow');
  const routeTitle = document.getElementById('route-title');
  routeEyebrow.dataset.i18n = 'security';
  routeTitle.dataset.i18n = 'authentication';
  routeEyebrow.textContent = t('security');
  routeTitle.textContent = t('authentication');

  const actions = [];
  if (loading) {
    actions.push(el('div', { class: 'auth-progress', role: 'status' }, [
      el('span', { class: 'auth-spinner', 'aria-hidden': 'true' }),
      el('span', { dataset: { i18n: 'authLoading' } }, t('authLoading')),
    ]));
  } else {
    const configurationFailed = Boolean(error && !session.enabled);
    actions.push(el('button', {
      class: 'primary auth-continue',
      type: 'button',
      onclick: configurationFailed ? () => window.location.reload() : beginSignIn,
      dataset: { i18n: configurationFailed ? 'retry' : 'continueWithGoogle' },
    }, t(configurationFailed ? 'retry' : 'continueWithGoogle')));
  }

  const details = el('details', { class: 'auth-details' }, [
    el('summary', { dataset: { i18n: 'whySignIn' } }, t('whySignIn')),
    el('p', { dataset: { i18n: 'authDetails' } }, t('authDetails')),
  ]);
  if (error) {
    details.append(
      el('p', { class: 'auth-technical-label', dataset: { i18n: 'details' } }, t('details')),
      el('code', { dataset: { i18nSkip: 'true', userContent: 'true' } }, error)
    );
  }

  view.append(el('section', { class: 'auth-card', 'aria-labelledby': 'auth-title' }, [
    el('span', { class: 'auth-badge', dataset: { i18n: 'protectedWorkspace' } }, t('protectedWorkspace')),
    el('h1', { id: 'auth-title', dataset: { i18n: loading ? 'authLoadingTitle' : 'authTitle' } },
      t(loading ? 'authLoadingTitle' : 'authTitle')),
    el('p', { class: 'auth-copy', dataset: { i18n: 'authDescription' } }, t('authDescription')),
    error ? el('div', { class: 'error-banner', role: 'alert', dataset: { i18n: 'authenticationFailed' } },
      t('authenticationFailed')) : null,
    el('div', { class: 'auth-actions' }, actions),
    details,
  ]));
  localize(view);
}

// A gated route reached without permission: prompt sign-in (public) or explain
// the missing role (signed in). The shell stays interactive so the visitor can
// navigate back to what they can access.
function renderSignInRequired(name) {
  const view = freshView();
  syncShell(name, view);
  syncSidebar(false);
  view.className = 'view view-standard';
  view.append(el('section', { class: 'auth-card', 'aria-labelledby': 'auth-title' }, [
    el('span', { class: 'auth-badge' }, t('protectedWorkspace')),
    el('h1', { id: 'auth-title' }, t('signInRequiredTitle', 'Sign in to continue')),
    el('p', { class: 'auth-copy' }, t('signInRequiredBody', 'Sign in with Google to open this area.')),
    el('div', { class: 'auth-actions' }, [
      el('button', { class: 'primary auth-continue', type: 'button', onclick: beginSignIn, dataset: { i18n: 'continueWithGoogle' } }, t('continueWithGoogle')),
    ]),
  ]));
  localize(view);
}

function renderAccessDenied(name) {
  const view = freshView();
  syncShell(name, view);
  syncSidebar(false);
  view.className = 'view view-standard';
  view.append(el('div', { class: 'empty' }, [
    el('span', { class: 'empty-mark', 'aria-hidden': 'true' }, '⛔'),
    el('h2', {}, t('noAccessTitle', 'You do not have access')),
    el('p', { class: 'muted' }, t('noAccessBody', 'Your role does not permit this area. Ask an administrator for access.')),
    el('a', { class: 'btn primary', href: `#/${DEFAULT_PUBLIC_ROUTE}` }, t('backToWorkspace', 'Back to workspace')),
  ]));
  localize(view);
}

async function render({ focus = false } = {}) {
  const session = getAuthenticationState();
  const permissions = session.permissions || {};
  applyMenuPermissions(permissions);
  setAuthenticationLocked(false);
  const epoch = ++renderEpoch;
  const name = currentRoute();

  // Per-route authorization (mirrors the gateway). No permission → sign-in
  // prompt for public visitors, access-denied for signed-in users.
  if (!canAccessRoute(permissions, name)) {
    if (!session.authenticated) renderSignInRequired(name);
    else renderAccessDenied(name);
    return;
  }

  const view = freshView();
  syncShell(name, view);
  syncSidebar(false);
  view.setAttribute('aria-busy', 'true');
  if (focus) view.focus({ preventScroll: true });

  // Keep connection-dependent routes useful by explaining the single next step.
  if (session.authenticated && !state.hasKey && connectionRoutes.has(name)) {
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
      view.replaceChildren(el('div', { class: 'error-banner' }, err.message || 'This view could not be loaded.'));
    }
  } finally {
    if (epoch !== renderEpoch || !view.isConnected) return;
    view.setAttribute('aria-busy', 'false');
    localize(view);
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
  syncSidebarCollapsed();

  // Authentication is the only network dependency allowed to gate the
  // workspace. Paint a useful status immediately while Firebase restores the
  // signed-in session.
  renderAuthenticationGate({ loading: true });
  let session;
  try {
    session = await initializeAuthentication();
  } catch (error) {
    // Hard configuration failure (Firebase web config unreachable) — show the
    // retry gate; there is no usable surface without it.
    await initializeI18n({ discover: false });
    renderAuthControl();
    renderAuthenticationGate({ error: error.message });
    return;
  }
  await initializeI18n({ discover: session.authenticated });
  renderAuthControl();

  // Public visitors AND signed-in users both get a first paint; render() applies
  // per-route authorization (public → read-only Agent workspace). Optional
  // connection/role discovery runs only when the session holds the permission.
  const readiness = Promise.allSettled([
    maybeRefreshConnection(session),
    maybeRefreshRole(session),
  ]);
  await render();
  await readiness;
  if (session.authenticated && connectionRoutes.has(currentRoute())) await render();

  // Anonymous visitors: surface the compact Google One Tap card (the screenshot
  // shape). Non-blocking — the read-only workspace + basic RAG stay usable, and
  // it is a no-op when One Tap is not configured or a user is already signed in.
  if (session.enabled && !session.authenticated) promptOneTap().catch(() => {});
});

window.addEventListener('ai-fleet:locale-changed', async () => {
  const session = getAuthenticationState();
  const permissions = session.permissions || {};
  renderAuthControl();
  applyMenuPermissions(permissions);
  const name = currentRoute();
  if (canAccessRoute(permissions, name)) {
    // Keep the in-view state; only refresh the shell chrome + labels.
    const view = document.getElementById('view');
    if (view) syncShell(name, view);
  } else {
    await render(); // re-render the sign-in / denied panel in the new locale
  }
  syncSidebarCollapsed();
  await Promise.all([maybeRefreshConnection(session), maybeRefreshRole(session)]);
  localize(document);
});

window.addEventListener('ai-fleet:auth-required', (event) => {
  const session = getAuthenticationState();
  // A connected tool can legitimately return 401 in local mode; only an
  // enabled application-auth session reacts to an app-auth failure.
  if (!session.enabled) return;
  expireAuthentication(event.detail?.message || t('sessionExpired'));
  renderAuthControl();
  // Drop back to the public surface: read-only Agent workspace, or a sign-in
  // prompt if the current route needs a role.
  render();
});

// Allow views to request a connection re-check (e.g. after saving a key).
window.addEventListener('lm:connection-changed', async () => {
  const session = getAuthenticationState();
  await maybeRefreshConnection(session);
  await render();
});

// Update the toolbar when the assumed role changes (admin only).
window.addEventListener('lm:role-changed', () => {
  const session = getAuthenticationState();
  if (session.authenticated && permitted(session.permissions, 'settings', 'write')) refreshRole();
});
