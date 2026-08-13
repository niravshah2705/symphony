import { api } from '../api.js';
import { getAuthenticationState } from '../auth.js';
import { el, clear, toast, loading } from '../dom.js';
import { brandIcon } from '../icons.js';
import { permitted } from '../permissions.js';
import {
  activeWorkspaceOrganization,
  activeWorkspaceProject,
  getWorkspaceContext,
} from '../workspace-context.js';
import { state } from '../state.js';

export async function renderSettings(view) {
  view.append(loading('Loading settings…'));

  const session = getAuthenticationState();
  const workspace = getWorkspaceContext();
  const selectedProject = activeWorkspaceProject(workspace);
  const canWriteGlobal = !session.enabled || permitted(session.permissions, 'settings', 'write');
  if (!canWriteGlobal) {
    await renderScopedPolicySettings(view);
    return;
  }

  // The labels/members enrichment is Linear-backed and 401s when the saved key
  // was rejected. Skip it in that known-bad state so the settings page (the very
  // place to fix the key) doesn't spam the console with connected-tool 401s.
  const linearBroken = state.connectionValid === false;
  const [settings, presets, configRes, modelsRes, labelsRes, membersRes, roleRes, codexRes, claudeRes, jsonRes, meRes, universeRes, effectiveRes, codexPreflight] = await Promise.all([
    api.getSettings(),
    api.getLlmPresets(),
    api.getAgentConfig().catch(() => ({ config: {} })),
    api.getAgentModels().catch(() => ({ intervals: [5, 10, 15] })),
    linearBroken ? Promise.resolve({ labels: [] }) : api.getAgentLabels().catch(() => ({ labels: [] })),
    linearBroken ? Promise.resolve({ members: [] }) : api.getMembers().catch(() => ({ members: [] })),
    api.getAssumedRole().catch(() => ({ assumedRole: null })),
    api.getCodexStatus().catch(() => ({ connected: false })),
    api.getClaudeStatus().catch(() => ({ connected: false })),
    api.getSettingsJson().catch(() => ({ settings: {} })),
    api.org.getMe().catch(() => null),
    api.settingsPolicy.getUniverse().catch(() => ({ schemaVersion: 0, harnesses: [] })),
    api.settingsPolicy.getEffective(selectedProject && selectedProject.id).catch(() => ({ prefs: {} })),
    api.settingsPolicy.preflight({ stages: ['plan'], harnesses: { plan: 'codex-sdk' } }).catch(() => null),
  ]);

  const codexDecision = codexPreflight && Array.isArray(codexPreflight.stages)
    ? codexPreflight.stages.find((entry) => entry.stage === 'plan')
    : null;
  if (codexDecision && codexDecision.credential) {
    codexRes.connected = codexDecision.credential.ready === true;
    codexRes.credentialSource = codexDecision.credential.source || null;
  }

  // Older stores intentionally kept hosted model ids blank and relied on the
  // provider defaults. Seed those effective ids into the in-memory public view
  // so the dropdown reflects today's provider default rather than a stale UI
  // fallback. Nothing is persisted until the operator changes a selection.
  if (!settings.codexModel) settings.codexModel = codexRes.model || codexRes.defaultModel || 'gpt-5.6-sol';
  if (!settings.claudeModel) settings.claudeModel = claudeRes.model || claudeRes.defaultModel || 'claude-opus-4-8';

  const identity = deriveIdentity(meRes, workspace);
  const ctx = {
    settings,
    presets,
    discovery: Object.create(null),
    selectionPending: Object.create(null),
    codex: codexRes,
    claude: claudeRes,
    view,
    me: meRes,
    identity,
    harnessCatalog: Array.isArray(universeRes.harnesses) ? universeRes.harnesses : [],
    effectivePrefs: (effectiveRes && effectiveRes.prefs) || {},
    advanced: { configRes, modelsRes, labelsRes, membersRes, roleRes, jsonRes },
  };
  const llm = llmSection(ctx);
  // A model/param change inside a role card re-renders the LLM section via
  // ctx.rebuild; extend it so the complexity dial re-derives its position too.
  const baseRebuild = ctx.rebuild;
  ctx.rebuild = () => {
    baseRebuild();
    if (ctx.refreshComplexity) ctx.refreshComplexity();
  };

  // Scope state — which level (org/project/user) the page is editing. It governs
  // the per-scope policy / effective / inheritance surfaces. Operational settings
  // (complexity/provider/roles/runtime/tracker) are still a single global store,
  // so they are labeled "Global" in the effective panel until per-scope lands.
  const scopeState = {
    scope: identity.isOrgAdmin && identity.hasOrg
      ? 'org'
      : identity.isProjectAdmin && identity.defaultProjectId ? 'project' : 'user',
    projectId: identity.defaultProjectId,
    identity,
  };

  const render = () => {
    clear(view).append(
      el('div', { class: 'sx-root' }, [
        sxHeader(),
        scopeLadder(scopeState, identity, render),
        editingBanner(scopeState, ctx),
      ]),
      el('div', { class: 'settings-layout' }, [
        el('div', { class: 'settings-content' }, [
          governanceSection(ctx, scopeState),
          modelsRuntimeSection(ctx, llm, scopeState),
          connectionsSection(ctx, scopeState),
          advancedGroup(ctx),
        ]),
        el('aside', { class: 'settings-rail' }, railCards(ctx, scopeState, identity)),
      ]),
    );
    applyControlLocks(view, scopeState);
  };
  ctx.rerenderPage = render;
  render();
}

/**
 * Selected-context administrators do not necessarily hold the legacy global
 * Firebase admin role. Give those users the policy surface backed by the org
 * and settings services, without loading or exposing mutable process-wide
 * provider/runtime controls.
 */
async function renderScopedPolicySettings(view) {
  const [presets, meRes] = await Promise.all([
    api.getLlmPresets().catch(() => ({ presets: [], complexityTiers: [] })),
    api.org.getMe().catch(() => null),
  ]);
  const identity = deriveIdentity(meRes, getWorkspaceContext());
  const ctx = {
    settings: {},
    presets,
    view,
    me: meRes,
    identity,
  };
  const scopeState = {
    scope: identity.isOrgAdmin && identity.hasOrg
      ? 'org'
      : identity.isProjectAdmin && identity.defaultProjectId ? 'project' : 'user',
    projectId: identity.defaultProjectId,
    identity,
  };
  const render = () => {
    clear(view).append(
      el('div', { class: 'sx-root' }, [
        sxHeader(),
        scopeLadder(scopeState, identity, render),
        editingBanner(scopeState, ctx),
      ]),
      el('div', { class: 'settings-layout settings-layout-policy-only' }, [
        el('div', { class: 'settings-content' }, [
          el('div', { class: 'notice' }, 'Operational models, connections, and runtime defaults require a global settings administrator. Context policy below follows the selected organization and project.'),
          governanceSection(ctx, scopeState),
          el('section', { class: 'sx-section' }, [
            sxSecHead('Harness, tools & skills', 'Selected-context policy'),
            policyGroup(ctx),
          ]),
        ]),
      ]),
    );
  };
  render();
}

/* ===================== Redesign: shell & scope ===================== */

// Derive Settings Policy authority from the selected native AI Fleet context.
// The Firebase/gateway identity can only carry one legacy org role, so it is not
// authoritative when the user switches organizations. Personal/tracker projects
// are intentionally excluded from this scope ladder.
function deriveIdentity(me, workspace) {
  const organization = activeWorkspaceOrganization(workspace);
  const project = activeWorkspaceProject(workspace);
  const orgRole = String(organization?.role || '').toUpperCase();
  const projectRole = String(project?.role || '').toUpperCase();
  return {
    hasOrg: Boolean(organization),
    isOrgAdmin: orgRole === 'ORG_ADMIN',
    isProjectAdmin: projectRole === 'PROJECT_ADMIN',
    orgName: organization?.name || 'Organization',
    userEmail: workspace?.user?.email || (me && (me.email || (me.user && me.user.email))) || 'Your settings',
    projects: organization?.projects || [],
    defaultProjectId: project?.id || null,
    defaultProjectName: project?.name || null,
  };
}

function canEditPolicyScope(identity, scope) {
  if (scope === 'org') return Boolean(identity?.isOrgAdmin);
  if (scope === 'project') return Boolean(identity?.isOrgAdmin || identity?.isProjectAdmin);
  return scope === 'user';
}

const SCOPE_META = {
  org: { kicker: 'Organization', ring: 'var(--amber)', srcClass: 'sx-src-org' },
  project: { kicker: 'Project', ring: 'var(--accent)', srcClass: 'sx-src-project' },
  user: { kicker: 'User', ring: 'var(--green)', srcClass: 'sx-src-user' },
};

// Record an operational override at the ACTIVE scope's prefs (readable, merge).
// Best-effort/additive: the control also writes the global store (today's source
// of truth), so a settings-policy outage or insufficient role is swallowed. Once
// the agent overlays prefs, these become the authoritative per-scope values.
// After render, at USER scope, disable operational controls whose pref key is
// locked by a higher scope (from effective.locks) and flag them. Fail-open: a
// settings-policy outage leaves controls enabled (server-side still enforces).
function applyControlLocks(root, scopeState) {
  if (scopeState.scope !== 'user') return; // org edits its own locks; project handled server-side
  void (async () => {
    let locked = [];
    try { const eff = await api.settingsPolicy.getEffective(scopeState.projectId); locked = (eff && eff.locks) || []; }
    catch (_) { return; }
    const set = new Set(locked);
    root.querySelectorAll('[data-lock-key]').forEach((node) => {
      if (!set.has(node.dataset.lockKey)) return;
      node.classList.add('sx-control-locked');
      node.querySelectorAll('button, input, select').forEach((c) => { c.disabled = true; });
      if (!node.querySelector('.sx-lock-flag')) {
        const flag = lockChip('Locked by organization');
        flag.classList.add('sx-lock-flag');
        node.appendChild(flag);
      }
    });
  })();
}

function setScopePrefs(scopeState, prefs, { strict = false } = {}) {
  if (!canEditPolicyScope(scopeState.identity, scopeState.scope)) return Promise.resolve(null);
  const p = api.settingsPolicy;
  const call = scopeState.scope === 'org' ? p.setOrgPrefs(prefs)
    : scopeState.scope === 'project' && scopeState.projectId ? p.setProjectPrefs(scopeState.projectId, prefs)
      : scopeState.scope === 'user' ? p.setMyPrefs(prefs)
        : null;
  const result = call || Promise.resolve(null);
  return strict ? result : result.catch(() => null);
}

function sxHeader() {
  return el('header', { class: 'sx-head' }, [
    el('p', { class: 'sx-eyebrow' }, 'Workspace configuration'),
    el('h1', {}, 'Settings'),
    el('p', {}, 'Configuration flows down: the organization sets the boundary, projects narrow it, people choose inside what is left. Pick the level you are editing, then open only the parts you want to change.'),
  ]);
}

function scopeLadder(scopeState, identity, rerender) {
  const projectName = identity.defaultProjectName || 'Project';
  const rows = [
    {
      id: 'org',
      name: identity.orgName,
      meta: identity.isOrgAdmin ? 'Boundary for every project' : 'View only · organization admins edit',
      enabled: identity.hasOrg,
    },
    {
      id: 'project',
      name: projectName,
      meta: !identity.defaultProjectId
        ? 'No AI Fleet project selected'
        : identity.isOrgAdmin || identity.isProjectAdmin ? 'Narrows the org list' : 'View only · project admins edit',
      enabled: Boolean(identity.defaultProjectId),
    },
    { id: 'user', name: identity.userEmail, meta: 'Chooses inside what is left', enabled: true },
  ];
  const wrap = el('div', { class: 'sx-scopes' });
  for (const r of rows) {
    const active = r.id === scopeState.scope;
    const btn = el('button', {
      type: 'button',
      class: `sx-scope${active ? ' active' : ''}`,
      ...(r.enabled ? {} : { disabled: 'disabled' }),
      'aria-pressed': active ? 'true' : 'false',
    }, [
      el('span', { class: 'sx-scope-kicker' }, [el('span', { class: 'sx-dot' }), SCOPE_META[r.id].kicker]),
      el('span', { class: 'sx-scope-name', dataset: { i18nSkip: 'true' } }, r.name),
      el('span', { class: 'sx-scope-meta' }, r.meta),
    ]);
    if (r.enabled) btn.addEventListener('click', () => { scopeState.scope = r.id; rerender(); });
    wrap.append(btn);
  }
  return wrap;
}

function editingBanner(scopeState, ctx) {
  const scope = scopeState.scope;
  const note = scope === 'org'
    ? 'Organization level. What you deny here can never be re-enabled by a project or a person.'
    : scope === 'project'
      ? 'Project level. You may narrow the organization list further, never widen it.'
      : 'User level. Pick your working set from what the project allows.';
  const catalog = (ctx.presets && ctx.presets.presets) || [];
  const inherit = `${catalog.length} models in catalog · governed per scope`;
  return el('div', { class: 'sx-editing' }, [
    el('span', { class: 'sx-editing-tag' }, 'Editing'),
    el('span', { class: 'sx-editing-note' }, note),
    el('span', { class: 'sx-editing-inherit' }, inherit),
  ]);
}

function sxSecHead(title, hint) {
  return el('div', { class: 'sx-sec-head' }, [
    el('h2', {}, title),
    hint ? el('span', { class: 'sx-sec-hint' }, hint) : null,
  ]);
}

/* ===================== Redesign: governance (model catalog) ===================== */

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n % 1e3 ? 1 : 0)}K`;
  return String(n);
}

function modelPrice(preset) {
  const c = preset.cost;
  if (!c || !Number.isFinite(c.inputPer1M) || !Number.isFinite(c.outputPer1M)) return 'self-hosted';
  return `$${c.inputPer1M} / $${c.outputPer1M} per 1M`;
}

function providerLabel(id) {
  return PROVIDER_LABELS[id] || id;
}

function modelSpec(preset) {
  const provLabel = providerLabel(preset.provider);
  const ctxTok = fmtTokens(preset.limits && preset.limits.contextWindow);
  const outTok = fmtTokens(preset.limits && preset.limits.maxOutputTokens);
  return `${provLabel} · ctx ${ctxTok} · out ${outTok} · ${modelPrice(preset)}`;
}

function lockGlyph() {
  return el('span', { dataset: { i18nSkip: 'true' }, style: 'display:inline-flex', html: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>' });
}

function lockChip(label) {
  return el('span', { class: 'sx-locked' }, [lockGlyph(), label]);
}

// Lockable entries an org can pin so lower scopes can't change them. The
// operational pref keys plus the `models` domain (freeze the model catalog).
// Keys/labels mirror the settings-service LOCKABLE_KEYS + the effective rail.
const LOCKABLE_PREFS = Object.freeze([
  ['complexityTier', 'Complexity'],
  ['llmProvider', 'Provider'],
  ['agentRuntime', 'Runtime'],
  ['planHarness', 'Planning harness'],
  ['codeHarness', 'Coding harness'],
  ['testHarness', 'Testing harness'],
  ['deployHarness', 'Deployment harness'],
  ['workflowPattern', 'Workflow'],
  ['planningProvider', 'Issue tracker'],
  ['langsmithTracing', 'Tracing'],
  ['models', 'Model catalog'],
]);

// Configuration locks. At ORG scope: editable toggles that pin operational prefs
// (org.locks) so projects/people can't override them. At project/user scope: a
// read-only view of what a higher scope has locked (from the effective response).
function locksCard(ctx, scopeState) {
  const scope = scopeState.scope;
  const card = el('div', { class: 'sx-card sx-card-pad' });
  const head = (sub) => el('div', { class: 'sx-card-head' }, [
    el('div', {}, [
      el('div', { class: 'sx-card-title' }, 'Configuration locks'),
      el('div', { class: 'sx-card-sub' }, sub),
    ]),
  ]);
  card.append(loading('Loading locks…'));

  void (async () => {
    if (scope === 'org') {
      let locks = [];
      let editable = canEditPolicyScope(scopeState.identity, 'org');
      try { const p = await api.settingsPolicy.getOrgPolicy(); locks = (p && p.locks) || []; }
      catch (_) { editable = false; }
      const set = new Set(locks);
      const paint = () => {
        clear(card).append(
          head('Pin a setting so projects and people can’t override the org default.'),
          editable
            ? el('div', { class: 'sx-lock-grid' }, LOCKABLE_PREFS.map(([key, label]) => {
              const on = set.has(key);
              const tile = el('button', { type: 'button', class: `sx-lock-tile${on ? ' active' : ''}` }, [lockGlyph(), el('span', {}, label)]);
              tile.addEventListener('click', async () => {
                const wasOn = set.has(key);
                if (wasOn) set.delete(key); else set.add(key);
                tile.disabled = true;
                try { await api.settingsPolicy.setOrgLocks([...set]); toast(wasOn ? `${label} unlocked.` : `${label} locked.`, 'ok'); }
                catch (err) { if (wasOn) set.add(key); else set.delete(key); toast(err.message || 'Could not update locks.', 'err'); }
                finally { paint(); }
              });
              return tile;
            }))
            : el('p', { class: 'muted' }, 'Organization admins only.'),
        );
      };
      paint();
      return;
    }
    // project / user scope: read-only "locked by a higher scope" view.
    let locked = [];
    try { const eff = await api.settingsPolicy.getEffective(scopeState.projectId); locked = (eff && eff.locks) || []; }
    catch (_) { locked = []; }
    const lockedLabels = LOCKABLE_PREFS.filter(([k]) => locked.includes(k)).map(([, l]) => l);
    clear(card).append(
      head(lockedLabels.length ? 'These are pinned by your organization and can’t be changed here.' : 'Nothing is pinned by a higher scope — you can change everything below.'),
      lockedLabels.length ? el('div', { class: 'sx-lock-chips' }, lockedLabels.map((l) => lockChip(l))) : null,
    );
  })();
  return card;
}

// Interactive per-scope model catalog. Status comes from the backend-computed
// effective breakdown (`models` domain — globs already applied); edits mutate this
// scope's policy include/exclude and PUT the full domain set (so other domains are
// preserved). Org/project DENY (exclude); the user SHORTLISTS (include). Falls back
// to read-only when the scope's policy isn't editable (non-admin / no session).
function governanceSection(ctx, scopeState) {
  const scope = scopeState.scope;
  const catalog = (ctx.presets && ctx.presets.presets) || [];
  const allIds = catalog.map((p) => p.id);
  const card = el('div', { class: 'sx-card' });
  const wrap = el('section', { class: 'sx-section' }, [
    sxSecHead('Allow & deny lists', 'Governs which models each scope may use'),
    card,
  ]);
  let filter = 'all';
  let data = null;

  const statusOf = (id) => {
    if (!data.orgAllowed.has(id)) return 'orgblock';
    if (!data.projAllowed.has(id)) return 'projblock';
    return 'allow';
  };
  const add = (arr, id) => { if (!arr.includes(id)) arr.push(id); return arr; };
  const drop = (arr, id) => arr.filter((x) => x !== id);

  const persist = async (nextModels) => {
    const domains = {};
    for (const [d, v] of Object.entries(data.domains)) {
      domains[d] = { include: (v.include || []).slice(), exclude: (v.exclude || []).slice() };
    }
    domains.models = nextModels;
    const body = { domains };
    if (scope === 'org') await api.settingsPolicy.setOrgPolicy(body);
    else if (scope === 'project') await api.settingsPolicy.setProjectPolicy(scopeState.projectId, body);
    else await api.settingsPolicy.setMyPolicy(body);
  };
  const mutate = async (mutator, okMsg) => {
    const base = data.domains.models || { include: [], exclude: [] };
    const next = { include: (base.include || []).slice(), exclude: (base.exclude || []).slice() };
    mutator(next);
    try { await persist(next); toast(okMsg, 'ok'); await load(); }
    catch (err) { toast(err.message || 'Could not update model policy.', 'err'); }
  };

  const controlFor = (preset) => {
    const id = preset.id;
    const s = statusOf(id);
    if (!data.editable) return null;
    if (scope === 'user') {
      if (s !== 'allow') return lockChip(s === 'orgblock' ? 'Denied · org' : 'Denied · project');
      const inShort = data.shortlisting && data.myInclude.has(id);
      const b = el('button', { type: 'button', class: `sx-btn${inShort ? ' primary' : ''}` }, inShort ? 'On shortlist' : 'Add to shortlist');
      b.addEventListener('click', () => mutate((m) => {
        if (m.include.includes(id)) m.include = drop(m.include, id); else add(m.include, id);
      }, inShort ? 'Removed from shortlist.' : 'Added to shortlist.'));
      return b;
    }
    if (scope === 'project' && s === 'orgblock') return lockChip('Denied · org');
    const denyActive = scope === 'org' ? !data.orgAllowed.has(id) : (data.orgAllowed.has(id) && !data.projAllowed.has(id));
    const allow = el('button', { type: 'button', class: `sx-seg${!denyActive ? ' active ok' : ''}` }, 'Allow');
    const deny = el('button', { type: 'button', class: `sx-seg${denyActive ? ' active bad' : ''}` }, 'Deny');
    allow.addEventListener('click', () => { if (denyActive) mutate((m) => { m.exclude = drop(m.exclude, id); }, 'Model allowed.'); });
    deny.addEventListener('click', () => { if (!denyActive) mutate((m) => { add(m.exclude, id); m.include = drop(m.include, id); }, 'Model denied.'); });
    return el('div', { class: 'sx-seg-group' }, [allow, deny]);
  };

  const row = (preset) => {
    const id = preset.id;
    const s = statusOf(id);
    const good = s === 'allow';
    const provLabel = providerLabel(preset.provider);
    const strike = s === 'orgblock' && scope !== 'org' ? 'line-through' : 'none';
    return el('div', { class: 'sx-row' }, [
      el('span', { class: 'sx-badge', dataset: { i18nSkip: 'true' } }, (provLabel[0] || '?').toUpperCase()),
      el('div', { style: 'min-width:0' }, [
        el('div', { class: 'sx-row-name', dataset: { i18nSkip: 'true' }, style: good ? '' : `color:var(--muted-2);text-decoration:${strike}` }, preset.name || preset.model || id),
        el('div', { class: 'sx-row-spec', dataset: { i18nSkip: 'true' } }, modelSpec(preset)),
      ]),
      el('span', { class: `sx-tag ${good ? 'ok' : 'bad'}` }, good ? 'Allowed' : s === 'orgblock' ? 'Denied · org' : 'Denied · project'),
      controlFor(preset) || el('span', { style: 'flex:none' }),
    ]);
  };

  const paint = () => {
    clear(card);
    const denied = allIds.filter((id) => statusOf(id) !== 'allow').length;
    const filterDefs = scope === 'user' ? ['all', 'allowed', 'denied', 'short'] : ['all', 'allowed', 'denied'];
    const filters = el('div', { class: 'sx-catalog-filters' }, filterDefs.map((f) => {
      const label = { all: 'All', allowed: 'Allowed', denied: 'Denied', short: 'Shortlist' }[f];
      const b = el('button', { type: 'button', class: `sx-filter${filter === f ? ' active' : ''}` }, label);
      b.addEventListener('click', () => { filter = f; paint(); });
      return b;
    }));
    const rows = catalog.filter((p) => {
      const s = statusOf(p.id);
      if (filter === 'allowed') return s === 'allow';
      if (filter === 'denied') return s !== 'allow';
      if (filter === 'short') return data.shortlisting && data.myInclude.has(p.id);
      return true;
    });
    const scopeWord = scope === 'user' ? 'on your shortlist basis' : scope === 'project' ? 'for this project' : 'org-wide';
    const foot = data.editable
      ? `${denied} of ${allIds.length} models denied ${scopeWord}.`
      : data.lockedByHigher
        ? `🔒 The model catalog is locked by your organization — it can’t be changed here. · ${denied} of ${allIds.length} denied.`
        : `${(scope === 'org' ? 'Organization admins only — sign in to edit.' : scope === 'project' ? 'Select a project you administer to edit.' : 'Sign in to build your shortlist.')} · ${denied} of ${allIds.length} denied.`;
    card.append(
      el('div', { class: 'sx-card-head bordered' }, [
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'sx-card-title' }, 'Model catalog'),
          el('div', { class: 'sx-card-sub' }, scope === 'org' ? 'Deny here and the model disappears everywhere below.' : scope === 'project' ? 'Org-denied models are struck out and cannot be re-enabled.' : 'Build a personal shortlist from what the project allows.'),
        ]),
        filters,
      ]),
      ...rows.map(row),
      el('div', { class: 'sx-card-foot' }, foot),
    );
  };

  const load = async () => {
    clear(card).append(loading('Loading model policy…'));
    let models = null;
    let lockedByHigher = false;
    try {
      const eff = await api.settingsPolicy.getEffective(scopeState.projectId);
      models = eff && eff.domains && eff.domains.models;
      // The `models` domain is frozen by a higher scope → this scope can't edit it.
      lockedByHigher = scope !== 'org' && ((eff && eff.locks) || []).includes('models');
    } catch (_) { models = null; }
    const orgAllowed = new Set(models ? models.org : allIds);
    const projAllowed = new Set(models ? models.project : allIds);
    const userAllowed = new Set(models ? models.user : allIds);
    let editable = !lockedByHigher
      && canEditPolicyScope(scopeState.identity, scope)
      && (scope !== 'project' || Boolean(scopeState.projectId));
    let policy = null;
    if (editable) {
      try {
        policy = scope === 'org' ? await api.settingsPolicy.getOrgPolicy()
          : scope === 'project' ? await api.settingsPolicy.getProjectPolicy(scopeState.projectId)
            : await api.settingsPolicy.getMyPolicy();
      } catch (_) { editable = false; }
    }
    const domains = (policy && policy.domains) || {};
    const myModels = domains.models || { include: [], exclude: [] };
    data = {
      orgAllowed, projAllowed, userAllowed, domains, editable, lockedByHigher,
      myInclude: new Set(myModels.include || []),
      shortlisting: scope === 'user' && (myModels.include || []).length > 0,
    };
    paint();
  };
  void load();
  return wrap;
}

/* ===================== Redesign: models & runtime ===================== */

function modelsRuntimeSection(ctx, llm, scopeState) {
  return el('section', { class: 'sx-section', id: 'settings-models' }, [
    sxSecHead('Models & runtime', 'Complexity sets every task model. Override any piece below.'),
    locksCard(ctx, scopeState),
    sxComplexity(ctx, scopeState),
    providerTiles(ctx, scopeState),
    el('div', { class: 'sx-card sx-card-pad' }, [
      el('div', { class: 'sx-card-head' }, [
        el('div', {}, [
          el('div', { class: 'sx-card-title' }, 'Task models'),
          el('div', { class: 'sx-card-sub' }, 'Assign a provider, model, and reasoning depth per role.'),
        ]),
      ]),
      llm,
    ]),
    runtimeTiles(ctx, scopeState),
  ]);
}

function sxComplexity(ctx, scopeState) {
  const tiers = [...((ctx.presets && ctx.presets.complexityTiers) || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const body = el('div', { class: 'sx-card sx-card-pad', dataset: { lockKey: 'complexityTier' } });
  const render = () => {
    clear(body);
    if (!tiers.length) {
      body.append(el('p', { class: 'muted' }, 'No complexity tiers are defined in the model catalog.'));
      return;
    }
    const current = ctx.settings.complexityTier || 'custom';
    const currentIdx = tiers.findIndex((t) => t.id === current);
    const value = currentIdx >= 0 ? currentIdx : tiers.length; // last+1 → Custom
    const sourceChip = el('span', { class: 'sx-src' }, currentIdx >= 0 ? 'Applied' : 'Custom');
    const slider = el('input', {
      type: 'range', min: '0', max: String(tiers.length), step: '1', value: String(value),
      style: 'width:100%', 'aria-label': 'Solution complexity',
    });
    const labels = el('div', { class: 'sx-cx-labels' }, [
      ...tiers.map((t, i) => el('span', {
        dataset: { i18nSkip: 'true' },
        style: `text-align:${i === 0 ? 'left' : 'center'};color:${i === Number(slider.value) ? 'var(--accent-2)' : 'var(--muted-2)'}`,
      }, t.label)),
      el('span', { style: 'text-align:right' }, 'Custom'),
    ]);
    const est = estimateMonthlyCostUsd(ctx);
    const execProvider = roleProvider(ctx.settings, 'execution');
    const execModel = currentParameters(ctx.settings, execProvider).model || 'Choose model';
    const execReason = currentParameters(ctx.settings, execProvider).reasoningEffort;
    const stats = el('div', { class: 'sx-cx-stats' }, [
      el('div', { class: 'sx-cx-stat' }, [el('div', { class: 'sx-cx-k' }, 'Est. spend'), el('div', { class: 'sx-cx-v', dataset: { i18nSkip: 'true' } }, est === null ? 'varies' : `~$${est}/mo`)]),
      el('div', { class: 'sx-cx-stat' }, [el('div', { class: 'sx-cx-k' }, 'Reasoning'), el('div', { class: 'sx-cx-v', dataset: { i18nSkip: 'true' } }, (REASONING_META[execReason] && REASONING_META[execReason].label) || '—')]),
      el('div', { class: 'sx-cx-stat' }, [el('div', { class: 'sx-cx-k' }, 'Execution model'), el('div', { class: 'sx-cx-v', dataset: { i18nSkip: 'true' } }, execModel)]),
    ]);
    const note = el('p', { class: 'sx-cx-note' });
    const describe = () => {
      const tier = tiers[Number(slider.value)] || null;
      note.textContent = tier ? tier.description : 'Models were set individually — the dial reads Custom.';
      [...labels.children].forEach((span, i) => { span.style.color = i === Number(slider.value) ? 'var(--accent-2)' : 'var(--muted-2)'; });
    };
    slider.addEventListener('input', describe);
    slider.addEventListener('change', async () => {
      const tier = tiers[Number(slider.value)];
      if (!tier) { describe(); return; } // Custom position is never applied
      slider.disabled = true;
      try {
        const res = await api.applyLlmTier(tier.id);
        Object.assign(ctx.settings, res && res.settings ? res.settings : res);
        setScopePrefs(scopeState, { complexityTier: tier.id });
        toast(`Complexity set to ${tier.label}.`, 'ok');
        if (ctx.rebuild) ctx.rebuild();
        render();
      } catch (err) { toast(err.message, 'err'); slider.disabled = false; }
    });
    body.append(
      el('div', { class: 'sx-card-head' }, [
        el('div', {}, [
          el('div', { class: 'sx-card-title' }, 'Complexity'),
          el('div', { class: 'sx-card-sub' }, 'One dial for model choice and reasoning depth across every role.'),
        ]),
        sourceChip,
      ]),
      slider, labels, stats, note,
    );
    describe();
  };
  ctx.refreshComplexity = render;
  render();
  return body;
}

function providerTiles(ctx, scopeState) {
  const card = el('div', { class: 'sx-card sx-card-pad' });
  const render = () => {
    clear(card);
    const active = roleProvider(ctx.settings, 'execution');
    const tiles = el('div', { class: 'sx-tiles', dataset: { lockKey: 'llmProvider' } });
    for (const opt of PROVIDER_PICKER) {
      const selected = opt.id === active || (opt.id === 'ollama' && ['ollama', 'lmstudio', 'omlx'].includes(active));
      const tile = el('button', { type: 'button', class: `sx-tile${selected ? ' active' : ''}`, 'aria-pressed': selected ? 'true' : 'false' }, [
        brandIcon(opt.icon, { label: opt.label }),
        el('span', { style: 'min-width:0' }, [
          el('span', { class: 'sx-tile-name' }, opt.label),
          el('span', { class: 'sx-tile-meta' }, opt.hint || 'Hosted'),
        ]),
      ]);
      tile.addEventListener('click', async () => {
        [...tiles.querySelectorAll('button')].forEach((b) => { b.disabled = true; });
        try {
          const ok = await cascadeProviderToAllRoles(ctx, opt.id);
          if (ok) { setScopePrefs(scopeState, { llmProvider: opt.id }); toast(`All models set to ${opt.label}.`, 'ok'); if (ctx.rebuild) ctx.rebuild(); }
        } catch (err) { toast(err.message, 'err'); }
        render();
      });
      tiles.append(tile);
    }
    card.append(
      el('div', { class: 'sx-card-head' }, [
        el('div', {}, [
          el('div', { class: 'sx-card-title' }, 'Default provider'),
          el('div', { class: 'sx-card-sub' }, 'Applies to every task model unless a role overrides it.'),
        ]),
      ]),
      tiles,
    );
  };
  render();
  return card;
}

const FALLBACK_HARNESSES = Object.freeze([
  { id: 'deepagent', label: 'DeepAgent', availability: 'available', stages: ['planning', 'coding', 'testing', 'deployment'], brokeredStages: ['planning', 'coding', 'testing', 'deployment'] },
  { id: 'codex-sdk', label: 'Codex SDK', availability: 'available', stages: ['planning', 'coding', 'testing'], brokeredStages: ['planning', 'testing'] },
  { id: 'claude-agent-sdk', label: 'Claude Agent SDK', availability: 'available', stages: ['planning', 'coding', 'testing'], brokeredStages: ['planning', 'testing'] },
  { id: 'antigravity-sdk', label: 'Antigravity SDK', availability: 'available', stages: ['planning'], brokeredStages: ['planning'] },
]);

const PIPELINE_HARNESS_STAGES = Object.freeze([
  { id: 'plan', workflow: 'planning', pref: 'planHarness', label: 'Planning', hint: 'Turns a request into an executable plan.' },
  { id: 'code', workflow: 'coding', pref: 'codeHarness', label: 'Coding', hint: 'Writes changes through the credential broker.', brokerRequired: true },
  { id: 'test', workflow: 'testing', pref: 'testHarness', label: 'Testing', hint: 'Verifies the change and records evidence.' },
  { id: 'deploy', workflow: 'deployment', pref: 'deployHarness', label: 'Deployment', hint: 'Follows the repository release instructions after tests pass.', brokerRequired: true },
]);

function availableHarnesses(ctx) {
  const catalog = Array.isArray(ctx.harnessCatalog) && ctx.harnessCatalog.length
    ? ctx.harnessCatalog
    : FALLBACK_HARNESSES;
  return catalog.filter((entry) => entry && entry.availability === 'available');
}

function harnessLabel(id, ctx) {
  return (availableHarnesses(ctx).find((entry) => entry.id === id) || {}).label || id || 'DeepAgent';
}

function harnessMeta(id, ctx) {
  if (id === 'codex-sdk') return ctx.codex && ctx.codex.connected ? 'Ready' : 'Admin token import needed';
  if (id === 'claude-agent-sdk') return ctx.claude && ctx.claude.connected ? 'Ready' : 'Sign-in needed';
  if (id === 'antigravity-sdk') return ctx.settings.hasAntigravityApiKey ? 'Ready' : 'Gemini API key needed';
  return 'Ready';
}

function runtimeTiles(ctx, scopeState) {
  const card = el('div', { class: 'sx-card sx-card-pad' });
  const render = () => {
    clear(card);
    const active = ctx.settings.agentRuntime || 'deepagent';
    const tiles = el('div', { class: 'sx-tiles', dataset: { lockKey: 'agentRuntime' } });
    const harnesses = availableHarnesses(ctx);
    for (const h of harnesses) {
      const selected = h.id === active;
      const tile = el('button', { type: 'button', class: `sx-tile block${selected ? ' active' : ''}` }, [
        el('span', { class: 'sx-tile-name' }, h.label),
        el('span', { class: 'sx-tile-meta' }, harnessMeta(h.id, ctx)),
      ]);
      tile.addEventListener('click', async () => {
        [...tiles.querySelectorAll('button')].forEach((b) => { b.disabled = true; });
        try {
          const res = await api.saveAgentRuntime({ agentRuntime: h.id, workflowPattern: ctx.settings.workflowPattern || 'sequential' });
          Object.assign(ctx.settings, res && res.settings ? res.settings : res);
          ctx.settings.agentRuntime = h.id;
          ctx.effectivePrefs.agentRuntime = h.id;
          setScopePrefs(scopeState, { agentRuntime: h.id });
          toast(`Runtime set to ${h.label}.`, 'ok');
        } catch (err) { toast(err.message, 'err'); }
        render();
      });
      tiles.append(tile);
    }
    const stageGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-top:16px' });
    for (const stage of PIPELINE_HARNESS_STAGES) {
      const compatible = harnesses.filter((h) => {
        if (!Array.isArray(h.stages) || !h.stages.includes(stage.workflow)) return false;
        return !stage.brokerRequired || (Array.isArray(h.brokeredStages) && h.brokeredStages.includes(stage.workflow));
      });
      const inherited = ctx.effectivePrefs[stage.pref] || ctx.effectivePrefs.agentRuntime || active;
      const supported = compatible.some((h) => h.id === inherited);
      const options = compatible.map((h) => el('option', {
        value: h.id,
        ...(h.id === inherited ? { selected: 'selected' } : {}),
      }, h.label));
      if (!supported) {
        options.unshift(el('option', { value: inherited, selected: 'selected', disabled: 'disabled' }, `${harnessLabel(inherited, ctx)} (unsupported for this stage)`));
      }
      const select = el('select', { style: 'width:100%' }, options);
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await setScopePrefs(scopeState, { [stage.pref]: select.value }, { strict: true });
          ctx.effectivePrefs[stage.pref] = select.value;
          toast(`${stage.label} harness set to ${harnessLabel(select.value, ctx)}.`, 'ok');
        } catch (err) {
          toast(err.message || `Could not save the ${stage.label.toLowerCase()} harness.`, 'err');
          render();
        } finally {
          select.disabled = false;
        }
      });
      stageGrid.append(el('div', { dataset: { lockKey: stage.pref } }, [
        field(`${stage.label} harness`, select),
        el('div', { class: 'sx-tile-meta' }, stage.hint),
      ]));
    }
    const workflow = el('select', { style: 'width:100%' }, [
      ['sequential', 'Sequential'], ['parallel', 'Fan-out'], ['evaluator', 'Evaluator / retry'], ['supervisor', 'Supervisor handoff'],
    ].map(([v, l]) => el('option', { value: v, ...((ctx.settings.workflowPattern || 'sequential') === v ? { selected: 'selected' } : {}) }, l)));
    workflow.addEventListener('change', async () => {
      try {
        await api.saveAgentRuntime({ agentRuntime: ctx.settings.agentRuntime || 'deepagent', workflowPattern: workflow.value });
        ctx.settings.workflowPattern = workflow.value;
        setScopePrefs(scopeState, { workflowPattern: workflow.value });
        toast('Workflow pattern saved.', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });
    const tracing = el('select', { style: 'width:100%' }, [
      ['on', 'LangSmith (on)'], ['off', 'Off'],
    ].map(([v, l]) => el('option', { value: v, ...((ctx.settings.langsmithTracing ? 'on' : 'off') === v ? { selected: 'selected' } : {}) }, l)));
    tracing.addEventListener('change', async () => {
      try {
        await api.saveLangsmith({ langsmithTracing: tracing.value === 'on' });
        ctx.settings.langsmithTracing = tracing.value === 'on';
        setScopePrefs(scopeState, { langsmithTracing: tracing.value === 'on' ? 'true' : 'false' });
        toast('Tracing preference saved.', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });
    card.append(
      el('div', { class: 'sx-card-head' }, [
        el('div', {}, [
          el('div', { class: 'sx-card-title' }, 'Agent runtime & workflow'),
          el('div', { class: 'sx-card-sub' }, 'Choose a default, then override individual pipeline stages. Only compatible broker-safe choices are offered.'),
        ]),
      ]),
      tiles,
      stageGrid,
      el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px' }, [
        el('div', { dataset: { lockKey: 'workflowPattern' } }, [field('Workflow pattern', workflow)]),
        el('div', { dataset: { lockKey: 'langsmithTracing' } }, [field('Tracing', tracing)]),
      ]),
    );
  };
  render();
  void api.settingsPolicy.getEffective(scopeState.projectId).then((effective) => {
    ctx.effectivePrefs = (effective && effective.prefs) || {};
    render();
  }).catch(() => {});
  return card;
}

/* ===================== Redesign: connections ===================== */

function connectionsSection(ctx, scopeState) {
  const settings = ctx.settings;
  const trackerCard = el('div', { class: 'sx-card sx-card-pad' });
  let activeTracker = ['linear', 'jira', 'asana'].includes(settings.planningProvider) ? settings.planningProvider : 'linear';
  const renderTracker = () => {
    clear(trackerCard);
    const tiles = el('div', { class: 'sx-tiles', dataset: { lockKey: 'planningProvider' } });
    for (const opt of PM_PICKER) {
      const selected = opt.id === activeTracker;
      const tile = el('button', { type: 'button', class: `sx-tile${selected ? ' active' : ''}` }, [
        brandIcon(opt.icon, { label: opt.label }),
        el('span', { class: 'sx-tile-name' }, opt.label),
      ]);
      tile.addEventListener('click', async () => {
        if (opt.id === activeTracker) return;
        [...tiles.querySelectorAll('button')].forEach((b) => { b.disabled = true; });
        try { await api.saveIntegrations({ planningProvider: opt.id }); activeTracker = opt.id; settings.planningProvider = opt.id; setScopePrefs(scopeState, { planningProvider: opt.id }); toast(`Issue tracker set to ${opt.label}.`, 'ok'); }
        catch (err) { toast(err.message, 'err'); }
        renderTracker();
      });
      tiles.append(tile);
    }
    trackerCard.append(
      el('div', { class: 'sx-card-head' }, [
        el('div', {}, [
          el('div', { class: 'sx-card-title' }, 'Issue tracker'),
          el('div', { class: 'sx-card-sub' }, 'Where planning reads and writes work items.'),
        ]),
      ]),
      tiles,
    );
  };
  renderTracker();

  const planningReady = Boolean(settings.planningConfigured || settings.hasKey);
  const repoReady = Boolean(settings.repositoryConfigured);
  const trackerName = settings.planningProvider === 'jira' ? 'JIRA' : settings.planningProvider === 'asana' ? 'Asana' : 'Linear';
  const services = [
    { name: trackerName, meta: 'Issue tracker · live project views', ok: planningReady, status: planningReady ? 'Connected' : 'Needs credentials' },
    { name: 'Repository', meta: settings.repositoryProvider === 'gitlab' ? 'GitLab · branches and merge requests' : 'GitHub · branches and pull requests', ok: repoReady, status: repoReady ? 'Connected' : 'Credentials missing' },
    { name: 'LangSmith', meta: 'Tracing and evaluation', ok: Boolean(settings.hasLangsmithKey), status: settings.hasLangsmithKey ? 'Connected' : 'Not configured' },
  ];
  const servicesCard = el('div', { class: 'sx-card' }, services.map((s) => el('div', { class: 'sx-svc' }, [
    el('div', { style: 'min-width:0' }, [
      el('div', { class: 'sx-svc-name' }, s.name),
      el('div', { class: 'sx-svc-meta' }, s.meta),
    ]),
    el('div', { class: 'sx-svc-status' }, [
      el('span', { class: 'sx-dot', style: `background:${s.ok ? 'var(--green)' : 'var(--amber)'}` }),
      el('span', {}, s.status),
    ]),
  ])));

  return el('section', { class: 'sx-section', id: 'settings-connections' }, [
    sxSecHead('Connections', 'Planning, source control, and observability'),
    trackerCard,
    servicesCard,
    // Detailed credential editors reuse the existing collapsible sections.
    integrationsSection(settings),
    keysSection(settings),
  ]);
}

/* ===================== Redesign: advanced (kept, collapsible) ===================== */

function advancedGroup(ctx) {
  const { configRes, modelsRes, labelsRes, membersRes, roleRes, jsonRes } = ctx.advanced;
  return el('section', { class: 'sx-section', id: 'settings-advanced' }, [
    sxSecHead('Accounts & advanced', 'Sign-ins, policy, automation & raw config'),
    accountsSection(ctx),
    policyGroup(ctx),
    agentSection({ config: configRes.config, intervals: modelsRes.intervals || [5, 10, 15], labels: labelsRes.labels || [], view: ctx.view }),
    roleSection({ members: membersRes.members || [], assumedRole: roleRes.assumedRole, view: ctx.view }),
    jsonSection({ view: ctx.view, doc: (jsonRes && jsonRes.settings) || {} }),
    settingsCommandCard({ view: ctx.view }),
  ]);
}

/* ===================== Redesign: right rail ===================== */

function sxScrollTo(id) {
  const n = document.getElementById(id);
  if (n) n.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function railCards(ctx, scopeState, identity) {
  return [attentionCard(ctx), effectiveCard(ctx, scopeState), inheritanceCard(scopeState, identity)].filter(Boolean);
}

function attentionCard(ctx) {
  const s = ctx.settings;
  const tasks = [];
  const usesClaude = ['thinking', 'execution', 'testing', 'deployment'].some((r) => roleProvider(s, r) === 'claude');
  const usesCodex = ['thinking', 'execution', 'testing', 'deployment'].some((r) => roleProvider(s, r) === 'codex');
  if (usesClaude && !(ctx.claude && ctx.claude.connected)) tasks.push({ title: 'Sign in to Anthropic', sub: "Hosted Claude models can't run until this account is connected.", action: 'Sign in', target: 'settings-advanced' });
  if (usesCodex && !(ctx.codex && ctx.codex.connected)) tasks.push({ title: 'Import OpenAI tokens', sub: "Hosted OpenAI models can't run until an administrator imports a token bundle.", action: 'View setup', target: 'settings-advanced' });
  if (!(s.planningConfigured || s.hasKey)) tasks.push({ title: 'Connect the issue tracker', sub: 'Planning needs credentials to read and write work items.', action: 'Add credentials', target: 'settings-connections' });
  if (!s.repositoryConfigured) tasks.push({ title: 'Add repository credentials', sub: 'Needed to read branches and open pull requests.', action: 'Add credentials', target: 'settings-connections' });
  if (!tasks.length) return null;
  return el('div', { class: 'sx-rail-card attention' }, [
    el('div', { class: 'sx-rail-head attention' }, [
      el('span', { class: 'sx-rail-kicker' }, tasks.length > 1 ? `${tasks.length} things need you` : 'One thing needs you'),
    ]),
    ...tasks.map((t) => el('div', { class: 'sx-task' }, [
      el('div', { class: 'sx-task-title' }, t.title),
      el('div', { class: 'sx-task-sub' }, t.sub),
      el('button', { type: 'button', class: 'sx-btn primary', onclick: () => sxScrollTo(t.target) }, t.action),
    ])),
  ]);
}

function effectiveCard(ctx, scopeState) {
  const s = ctx.settings;
  const scope = scopeState.scope;
  const forLine = scope === 'org' ? 'Applies to every project' : scope === 'project' ? 'Applies to everyone on the project' : 'Applies to your runs only';
  const thinking = currentParameters(s, roleProvider(s, 'thinking')).model || '—';
  const execution = currentParameters(s, roleProvider(s, 'execution')).model || '—';
  const testing = currentParameters(s, roleProvider(s, 'testing')).model || '—';
  const deployment = currentParameters(s, roleProvider(s, 'deployment')).model || '—';
  const catalog = (ctx.presets && ctx.presets.presets) || [];
  const runtimeName = harnessLabel(s.agentRuntime || 'deepagent', ctx);
  // Each operational row carries the pref key that overrides it (if any); the
  // per-role model rows aren't pref-backed. Default source is "Global"; resolved
  // per-scope prefs (loaded async below) flip the badge to the active scope.
  const rows = [
    ['Complexity', s.complexityTier ? s.complexityTier : 'Custom', 'complexityTier'],
    ['Provider', providerLabel(roleProvider(s, 'execution')), 'llmProvider'],
    ['Thinking', thinking, null],
    ['Execution', execution, null],
    ['Testing', testing, null],
    ['Deployment', deployment, null],
    ['Runtime', `${runtimeName} · ${s.workflowPattern || 'sequential'}`, 'agentRuntime'],
    ...PIPELINE_HARNESS_STAGES.map((stage) => [
      `${stage.label} harness`,
      harnessLabel((ctx.effectivePrefs && (ctx.effectivePrefs[stage.pref] || ctx.effectivePrefs.agentRuntime)) || s.agentRuntime || 'deepagent', ctx),
      stage.pref,
    ]),
    ['Models', `${catalog.length} in catalog`, null, SCOPE_META[scope] ? scope : 'global'],
  ];
  const srcSpans = Object.create(null);
  const card = el('div', { class: 'sx-rail-card' }, [
    el('div', { class: 'sx-rail-head' }, [
      el('div', {}, [
        el('div', { class: 'sx-rail-kicker' }, 'Effective configuration'),
        el('div', { class: 'sx-rail-for' }, forLine),
      ]),
    ]),
    ...rows.map(([k, v, prefKey, fixedSrc]) => {
      const src = fixedSrc || 'global';
      const srcSpan = el('span', { class: `sx-eff-src sx-src-${src}` }, src === 'global' ? 'Global' : (SCOPE_META[src] ? SCOPE_META[src].kicker : src));
      if (prefKey) srcSpans[prefKey] = srcSpan;
      return el('div', { class: 'sx-eff-row' }, [
        el('span', { class: 'sx-eff-k' }, k),
        el('span', { class: 'sx-eff-v', dataset: { i18nSkip: 'true' } }, v),
        srcSpan,
      ]);
    }),
    el('div', { style: 'padding:12px 14px' }, [
      el('button', { type: 'button', class: 'sx-btn primary sx-save', onclick: () => toast('Changes on this page save as you make them.', 'ok') }, `Save ${scope === 'org' ? 'org policy' : scope === 'project' ? 'project settings' : 'my settings'}`),
    ]),
  ]);
  // Reflect resolved per-scope operational prefs onto the source badges (async;
  // fail-open — leaves "Global" if the settings-policy service is unavailable).
  void (async () => {
    try {
      const eff = await api.settingsPolicy.getEffective(scopeState.projectId);
      const prefs = (eff && eff.prefs) || {};
      const meta = SCOPE_META[scope];
      for (const key of Object.keys(srcSpans)) {
        if (!prefs[key] || !meta) continue;
        srcSpans[key].className = `sx-eff-src ${meta.srcClass}`;
        srcSpans[key].textContent = meta.kicker;
      }
    } catch (_) { /* leave Global */ }
  })();
  return card;
}

function inheritanceCard(scopeState, identity) {
  const chain = [
    { id: 'org', name: `Organization · ${identity.orgName}`, detail: 'Sets the boundary: model catalog, provider and runtime ceiling.' },
    { id: 'project', name: `Project · ${identity.defaultProjectName || 'Project'}`, detail: 'Narrows the org list and picks defaults for the team.' },
    { id: 'user', name: `You · ${identity.userEmail}`, detail: 'Chooses a personal working set inside what is left.' },
  ];
  return el('div', { class: 'sx-rail-card', style: 'padding:14px' }, [
    el('div', { class: 'sx-rail-kicker', style: 'margin-bottom:10px' }, 'Inheritance'),
    ...chain.map((c) => {
      const active = c.id === scopeState.scope;
      return el('div', { class: `sx-inh-step${active ? ' active' : ''}` }, [
        el('span', { class: 'sx-inh-ring', style: `border-color:${SCOPE_META[c.id].ring};background:${active ? SCOPE_META[c.id].ring : 'transparent'}` }),
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'sx-inh-name', dataset: { i18nSkip: 'true' } }, c.name),
          el('div', { class: 'sx-inh-detail' }, c.detail),
        ]),
      ]);
    }),
  ]);
}

/* ===================== Redesigned settings sections ===================== */

// Provider picker: user-facing label + brand icon + backend provider id. BYoM
// points at the local default (Ollama); vLLM/LM Studio/oMLX share the group.
const PROVIDER_PICKER = Object.freeze([
  { id: 'claude', label: 'Claude', icon: 'anthropic' },
  { id: 'codex', label: 'OpenAI', icon: 'openai' },
  { id: 'antigravity', label: 'Gemini', icon: 'gemini' },
  { id: 'huggingface', label: 'Hugging Face', icon: 'huggingface' },
  { id: 'ollama', label: 'BYoM', icon: 'byom', hint: 'vLLM / Ollama / LM Studio / oMLX' },
]);

function providerDisplay(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

// ---- Complexity slider ----------------------------------------------------

function estimateMonthlyCostUsd(ctx) {
  // Indicative: every active task role
  // against a fixed monthly volume. null when any active model is unpriced.
  const ASSUMED_INPUT = 20, ASSUMED_OUTPUT = 4;
  let total = 0;
  for (const role of ['thinking', 'execution', 'testing', 'deployment']) {
    const provider = roleProvider(ctx.settings, role);
    const model = currentParameters(ctx.settings, provider).model;
    const preset = findPresetForModel(ctx, provider, model);
    const cost = preset && preset.cost;
    if (!cost || !Number.isFinite(cost.inputPer1M) || !Number.isFinite(cost.outputPer1M)) return null;
    total += ASSUMED_INPUT * cost.inputPer1M + ASSUMED_OUTPUT * cost.outputPer1M;
  }
  return Math.round(total);
}

// ---- Provider picker cascade (used by the redesign's provider tiles) ------

async function cascadeProviderToAllRoles(ctx, provider) {
  for (const entry of LLM_ROLES) {
    await discoverProviderModels(ctx, entry.role, provider, false, () => {});
    const recommended = recommendedModelEntry(ctx, provider);
    if (!recommended) {
      toast(`No models are configured for ${providerDisplay(provider)}.`, 'err');
      return false;
    }
    const res = await api.applyLlmSelection({
      role: entry.role, provider, model: recommended.id,
      reasoningEffort: defaultReasoningFor(recommended, recommended.preset), mode: 'model',
    });
    Object.assign(ctx.settings, res && res.settings ? res.settings : res);
  }
  return true;
}

// ---- Project management tool (icons) --------------------------------------

const PM_PICKER = Object.freeze([
  { id: 'linear', label: 'Linear', icon: 'linear' },
  { id: 'jira', label: 'JIRA', icon: 'jira' },
]);

// ---- Hosted account status + sign-in (Accounts, kept last) ----------------

function hostedStatusPill(ctx, provider) {
  const connected = provider === 'codex' ? Boolean(ctx.codex && ctx.codex.connected) : Boolean(ctx.claude && ctx.claude.connected);
  return el('div', { class: `preset-status ${connected ? 'ok' : 'warn'}` },
    connected ? `${providerDisplay(provider)} account connected.` : 'Not signed in — see Accounts at the bottom of Settings.');
}

function accountsSection(ctx) {
  return section('Sign in with Claude / OpenAI', 'Hosted providers', false, [
    el('p', { class: 'muted settings-section-intro' }, 'Only needed for the hosted OpenAI (ChatGPT) or Anthropic (Claude) providers. BYoM and Gemini use keys configured above.'),
    el('div', { class: 'accounts-grid' }, [
      el('div', { class: 'account-card' }, [el('div', { class: 'subhead' }, 'Anthropic · Claude'), claudeConnection(ctx)]),
      el('div', { class: 'account-card' }, [el('div', { class: 'subhead' }, 'OpenAI · ChatGPT'), codexConnection(ctx)]),
    ]),
  ]);
}

// ---- Merged settings policy (harness/tools/skills/plugins/hooks) ----------

const POLICY_DOMAINS = ['harness', 'tools', 'skills', 'plugins', 'hooks'];
const POLICY_DOMAIN_LABELS = {
  harness: 'Harness (agent runtimes)',
  tools: 'Tools (developer-tool registry)',
  skills: 'Skills (workflow skills)',
  plugins: 'Plugins',
  hooks: 'Hooks (lifecycle)',
};
// A curated "good default for software development" include set per domain.
const RECOMMENDED_SOFTWARE_DEV = {
  harness: ['deepagent'],
  tools: ['docker', 'build', 'quality', 'codegen', 'playwright'],
  skills: ['software-planning', 'commit', 'push', 'pull', 'land'],
  plugins: ['security', 'langsmith-tracing'],
  hooks: ['pre-code', 'post-code', 'pre-pr'],
};
// Provider secrets held in the per-org KMS vault (the source proxied agents
// read). Each has a managed-vs-customer selection. Keys must be in the settings
// service SECRET_KEYS allowlist (services/settings/app/models/secrets.py).
const VAULT_SECRETS = [
  { key: 'anthropicApiKey', label: 'Anthropic API key', hint: 'Used by the Claude provider (managed alternative to Sign in with Claude).' },
  { key: 'openaiApiKey', label: 'OpenAI API key', hint: 'Used by the OpenAI provider (managed alternative to Sign in with ChatGPT).' },
  { key: 'geminiApiKey', label: 'Gemini API key', hint: 'Used by the Gemini / Antigravity provider.' },
  { key: 'huggingfaceApiKey', label: 'Hugging Face token', hint: 'Used by the Hugging Face (BYoM) provider.' },
];

function describeVaultStatus(isSet, source) {
  if (source === 'customer') {
    return isSet ? 'Customer key configured' : 'Customer selected — no key stored (agents fail closed)';
  }
  return 'Using platform-managed key';
}

function parsePolicyList(text) {
  return String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function policyDomainEditor(domain, policy, universe, editors) {
  const dp = (policy && policy.domains && policy.domains[domain]) || { include: [], exclude: [] };
  const items = (universe && universe[domain]) || [];
  const include = el('textarea', { class: 'policy-input', rows: '2', placeholder: 'Empty = all. ids or globs (e.g. security:*)' });
  include.value = (dp.include || []).join('\n');
  const exclude = el('textarea', { class: 'policy-input', rows: '2', placeholder: 'ids or globs to block' });
  exclude.value = (dp.exclude || []).join('\n');
  editors[domain] = { include, exclude };
  const useRecommended = el('button', { type: 'button', class: 'btn btn-small' }, 'Use recommended');
  useRecommended.addEventListener('click', () => { include.value = (RECOMMENDED_SOFTWARE_DEV[domain] || []).join('\n'); });
  // Available ids are catalog values; el() renders string children as text nodes.
  const chips = items.length
    ? items.map((id) => el('code', { class: 'param-chip' }, id))
    : [el('em', { class: 'muted' }, 'none')];
  return el('div', { class: 'policy-domain field' }, [
    el('div', { class: 'subhead policy-domain-head' }, [
      el('span', {}, POLICY_DOMAIN_LABELS[domain] || domain),
      RECOMMENDED_SOFTWARE_DEV[domain] ? useRecommended : null,
    ]),
    el('div', { class: 'policy-chips' }, [el('span', { class: 'muted' }, 'Available: '), ...chips]),
    el('label', {}, ['Include', include]),
    el('label', {}, ['Exclude', exclude]),
  ]);
}

function collectPolicyDomains(editors) {
  const domains = {};
  for (const domain of POLICY_DOMAINS) {
    const e = editors[domain];
    if (!e) continue;
    domains[domain] = { include: parsePolicyList(e.include.value), exclude: parsePolicyList(e.exclude.value) };
  }
  return { domains };
}

async function policyScopeCard(container, { title, hint, load, save, universe, enabled, disabledReason, vault }) {
  const head = [el('div', { class: 'subhead' }, title), hint ? el('p', { class: 'muted' }, hint) : null].filter(Boolean);
  if (!enabled) {
    clear(container).append(...head, el('p', { class: 'muted' }, disabledReason || 'Not available for your role.'));
    return;
  }
  let policy;
  try { policy = await load(); }
  catch (err) { clear(container).append(...head, el('div', { class: 'error-banner' }, err.message)); return; }
  const editors = {};
  const form = el('form', { class: 'policy-form' });
  for (const domain of POLICY_DOMAINS) form.append(policyDomainEditor(domain, policy, universe, editors));
  const saveBtn = el('button', { type: 'submit', class: 'btn primary' }, 'Save policy');
  form.append(saveBtn);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    saveBtn.disabled = true;
    try { await save(collectPolicyDomains(editors)); toast('Policy saved.', 'ok'); }
    catch (err) { toast(err.message || 'Could not save policy.', 'err'); }
    finally { saveBtn.disabled = false; }
  });
  clear(container).append(...head, form);
  // Provider secrets live in the per-org vault, so they attach to the org scope only.
  if (vault) container.append(vaultSecretsEditor());
}

/**
 * Per-org secret-vault editor (org admin). For each provider key: a managed vs
 * customer selection and a write-only customer key. This is the source proxied
 * agents read; pasting a customer key auto-selects "customer" so it takes effect.
 */
function vaultSecretsEditor() {
  const wrap = el('div', { class: 'policy-domain field vault-secrets' });
  const render = (secrets) => {
    clear(wrap).append(
      el('div', { class: 'subhead' }, 'Provider keys (per-org vault)'),
      el('p', { class: 'muted' }, 'KMS-encrypted and write-only — never shown again. “Managed” uses the platform key; “Customer” uses the key you paste here. Agents read from this vault.'),
    );
    for (const item of VAULT_SECRETS) {
      const entry = (secrets && secrets[item.key]) || { set: false, source: 'managed' };
      let source = entry.source === 'customer' ? 'customer' : 'managed';
      const status = el('span', { class: 'muted' }, describeVaultStatus(entry.set, source));
      const input = pwd(entry.set ? 'Configured — paste a new key to replace' : 'Paste your key');
      const saveBtn = el('button', { type: 'button', class: 'btn' }, 'Save customer key');
      const clearBtn = el('button', { type: 'button', class: 'btn' }, 'Clear');
      const managedBtn = el('button', { type: 'button', class: `btn btn-small${source === 'managed' ? ' primary' : ''}` }, 'Managed');
      const customerBtn = el('button', { type: 'button', class: `btn btn-small${source === 'customer' ? ' primary' : ''}` }, 'Customer');
      const reflect = () => {
        managedBtn.classList.toggle('primary', source === 'managed');
        customerBtn.classList.toggle('primary', source === 'customer');
        status.textContent = describeVaultStatus(entry.set, source);
      };
      const setSource = async (mode) => {
        managedBtn.disabled = customerBtn.disabled = true;
        try { await api.settingsPolicy.setOrgSecretSelection({ [item.key]: mode }); source = mode; reflect(); toast(`Using ${mode} key.`, 'ok'); }
        catch (err) { toast(err.message || 'Could not update selection.', 'err'); }
        finally { managedBtn.disabled = customerBtn.disabled = false; }
      };
      managedBtn.addEventListener('click', () => setSource('managed'));
      customerBtn.addEventListener('click', () => setSource('customer'));
      saveBtn.addEventListener('click', async () => {
        const value = input.value.trim();
        if (!value) return toast('Paste a key value to save.', 'err');
        saveBtn.disabled = true;
        try {
          await api.settingsPolicy.setOrgSecrets({ [item.key]: value });
          entry.set = true; input.value = '';
          // A stored customer key only takes effect once the org selects "customer".
          if (source !== 'customer') { await api.settingsPolicy.setOrgSecretSelection({ [item.key]: 'customer' }); source = 'customer'; }
          reflect();
          toast('Customer key saved.', 'ok');
        } catch (err) { toast(err.message || 'Could not save key.', 'err'); }
        finally { saveBtn.disabled = false; }
      });
      clearBtn.addEventListener('click', async () => {
        clearBtn.disabled = true;
        try { await api.settingsPolicy.setOrgSecrets({ [item.key]: '' }); entry.set = false; input.value = ''; reflect(); toast('Customer key cleared.', 'ok'); }
        catch (err) { toast(err.message || 'Could not clear key.', 'err'); }
        finally { clearBtn.disabled = false; }
      });
      wrap.append(el('div', { class: 'vault-secret' }, [
        el('div', { class: 'subhead policy-domain-head' }, [el('span', {}, item.label), status]),
        item.hint ? el('p', { class: 'muted', style: 'margin:2px 0 6px;font-size:12px' }, item.hint) : null,
        el('div', { class: 'row', style: 'gap:6px;align-items:center' }, [el('span', { class: 'muted', style: 'font-size:12px' }, 'Key source:'), managedBtn, customerBtn]),
        field('Customer key', input),
        el('div', { class: 'row' }, [saveBtn, clearBtn]),
      ]));
    }
  };
  wrap.append(loading('Loading provider keys…'));
  void (async () => {
    try { const res = await api.settingsPolicy.getOrgSecrets(); render((res && res.secrets) || {}); }
    catch (err) {
      clear(wrap).append(
        el('div', { class: 'subhead' }, 'Provider keys (per-org vault)'),
        el('div', { class: 'error-banner' }, err.message || 'Could not load provider keys.'),
      );
    }
  })();
  return wrap;
}

async function policyEffectiveCard(container) {
  let data;
  try { data = await api.settingsPolicy.getEffective(); }
  catch (err) {
    clear(container).append(el('div', { class: 'subhead' }, 'Effective'), el('div', { class: 'error-banner' }, err.message));
    return;
  }
  const rows = [el('div', { class: 'subhead' }, 'Effective (after the cascade)')];
  for (const domain of POLICY_DOMAINS) {
    const res = (data.domains && data.domains[domain]) || { effective: [] };
    rows.push(el('div', { class: 'policy-effective' }, [
      el('strong', {}, POLICY_DOMAIN_LABELS[domain] || domain),
      el('div', { class: 'policy-chips' }, res.effective.length
        ? res.effective.map((id) => el('code', { class: 'param-chip ok' }, id))
        : [el('em', { class: 'muted' }, 'nothing allowed')]),
    ]));
  }
  clear(container).append(...rows);
}

function policyGroup(ctx) {
  const wrap = el('div', { class: 'policy-merged' });
  const userC = el('div', { class: 'policy-scope' });
  const orgC = el('div', { class: 'policy-scope' });
  const effC = el('div', { class: 'policy-scope' });
  wrap.append(loading('Loading policy…'));
  void (async () => {
    let universe;
    try { universe = (await api.settingsPolicy.getUniverse()).domains; }
    catch (err) { clear(wrap).append(el('div', { class: 'error-banner' }, err.message || 'Sign in to manage policy.')); return; }
    const isOrgAdmin = Boolean(ctx.identity?.isOrgAdmin);
    clear(wrap).append(
      el('p', { class: 'muted settings-section-intro' }, 'Include/exclude what agents may use per scope. Lower scopes only narrow — an exclude higher up always wins. Empty include = allow all.'),
      userC, orgC, effC,
    );
    await Promise.all([
      policyScopeCard(userC, {
        title: 'My settings (user scope)', hint: 'Your personal narrowing — applied last.',
        universe, enabled: true,
        load: () => api.settingsPolicy.getMyPolicy(), save: (b) => api.settingsPolicy.setMyPolicy(b),
      }),
      policyScopeCard(orgC, {
        title: 'Organization scope', hint: 'Applies to everyone in the org. An exclude here blocks project and user.',
        universe, enabled: isOrgAdmin, disabledReason: 'Organization admins only.',
        load: () => api.settingsPolicy.getOrgPolicy(), save: (b) => api.settingsPolicy.setOrgPolicy(b),
        vault: true,
      }),
      policyEffectiveCard(effC),
    ]);
  })();
  return wrap;
}

/* ----------------------------- Settings JSON ---------------------------- */

const JSON_EDITOR_STYLE =
  'width:100%;min-height:320px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;padding:10px;box-sizing:border-box';

function jsonSection({ view, doc }) {
  const editor = el('textarea', { class: 'settings-json-editor', spellcheck: 'false', style: JSON_EDITOR_STYLE });
  editor.value = JSON.stringify(doc || {}, null, 2);
  const status = el('span', { class: 'muted', role: 'status', style: 'font-size:11px' });
  const save = el('button', { class: 'primary', type: 'button' }, 'Save JSON');
  const copy = el('button', { class: 'ghost', type: 'button' }, 'Copy');
  const download = el('button', { class: 'ghost', type: 'button' }, 'Download');

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(editor.value);
      toast('Copied settings JSON.', 'ok');
    } catch (_) {
      toast('Copy failed.', 'err');
    }
  });

  download.addEventListener('click', () => {
    const blob = new Blob([editor.value], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: 'settings.json' });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  save.addEventListener('click', async () => {
    let parsed;
    try {
      parsed = JSON.parse(editor.value);
    } catch (err) {
      status.textContent = `Invalid JSON: ${err.message}`;
      toast('Invalid JSON.', 'err');
      return;
    }
    const payload = parsed && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings) ? parsed.settings : parsed;
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const res = await api.saveSettingsJson(payload);
      const applied = res.applied || [];
      const rejected = res.rejected || [];
      status.textContent =
        `Applied ${applied.length} setting${applied.length === 1 ? '' : 's'}.` +
        (rejected.length ? ` Rejected: ${rejected.map((r) => r.key).join(', ')}.` : '');
      toast(rejected.length ? 'Saved with some rejected keys.' : 'Settings JSON saved.', rejected.length ? 'err' : 'ok');
      if (view) setTimeout(() => renderSettings(view), 700);
    } catch (err) {
      status.textContent = err.message;
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
      save.textContent = 'Save JSON';
    }
  });

  return section('Edit as JSON', 'Non-secret operational settings', false, [
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:0' }, 'The full non-secret configuration as JSON. Edit and save to apply; only known keys are accepted and validated. Secrets and tokens keep their own fields and are never shown here.'),
    editor,
    el('div', { class: 'row', style: 'margin-top:10px;gap:8px;flex-wrap:wrap' }, [save, copy, download, status]),
  ]);
}

function settingsCommandCard({ view }) {
  const input = el('textarea', {
    rows: '2',
    placeholder: 'e.g. Set the harness to codex and turn off LangSmith tracing',
    style: 'width:100%;box-sizing:border-box',
  });
  const run = el('button', { class: 'primary', type: 'button' }, 'Apply with local model');
  const status = el('span', { class: 'muted', role: 'status', style: 'font-size:11px' });
  const result = el('pre', {
    style: 'display:none;white-space:pre-wrap;margin-top:10px;padding:10px;border-radius:8px;background:rgba(127,127,127,0.12);font-size:12px;overflow:auto',
  });

  run.addEventListener('click', async () => {
    const instruction = input.value.trim();
    if (!instruction) {
      status.textContent = 'Describe the change first.';
      return;
    }
    run.disabled = true;
    run.textContent = 'Thinking…';
    try {
      const res = await api.settingsCommand({ instruction });
      const command = res.command || {};
      const applied = res.applied || [];
      const rejected = res.rejected || [];
      result.style.display = 'block';
      result.textContent = JSON.stringify(command.patch || {}, null, 2);
      status.textContent =
        (command.notes ? `${command.notes} ` : '') +
        `Applied ${applied.length} setting${applied.length === 1 ? '' : 's'}.` +
        (rejected.length ? ` Rejected: ${rejected.map((r) => r.key).join(', ')}.` : '');
      toast(applied.length ? 'Settings updated by the local model.' : 'No changes applied.', applied.length ? 'ok' : 'err');
      if (applied.length && view) setTimeout(() => renderSettings(view), 900);
    } catch (err) {
      status.textContent = err.message;
      toast(err.message, 'err');
    } finally {
      run.disabled = false;
      run.textContent = 'Apply with local model';
    }
  });

  return section('Change settings by typing', 'Local model · never leaves your machine', false, [
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:0' }, 'Describe a change in plain language. The configured local model proposes a validated settings patch, which is saved to data/store.json. Secrets can only be changed through their own fields.'),
    field('Request', input),
    el('div', { class: 'row', style: 'gap:8px' }, [run, status]),
    result,
  ]);
}

/* --------------------------- Collapsible box ---------------------------- */

function section(title, subtitle, open, children) {
  return el('details', { class: 'section', ...(open ? { open: 'open' } : {}) }, [
    el('summary', {}, [
      el('span', { class: 'section-title', role: 'heading', 'aria-level': '3' }, title),
      subtitle ? el('span', { class: 'section-sub' }, subtitle) : null,
    ]),
    el('div', { class: 'section-body' }, children),
  ]);
}

let fieldSequence = 0;
const field = (label, control, hint) => {
  const target = control.matches && control.matches('input, select, textarea')
    ? control
    : control.querySelector && control.querySelector('input, select, textarea');
  if (target && !target.id) target.id = `settings-field-${++fieldSequence}`;
  return el('div', { class: 'field' }, [
    el('label', target ? { for: target.id } : {}, label),
    control,
    hint ? el('p', { class: 'muted', style: 'margin:6px 0 0;font-size:12px' }, hint) : null,
  ]);
};

const pwd = (placeholder) => el('input', { type: 'password', autocomplete: 'off', placeholder });

/* ------------------------- Keys & connection ---------------------------- */

function keysSection(settings) {
  const status = el('div', { class: 'muted', style: 'font-size:13px;margin-top:6px' });

  const linearInput = pwd(settings.hasKey ? `Saved: ${settings.maskedKey}` : 'lin_api_…');
  const langsmithInput = pwd(settings.hasLangsmithKey ? `Saved: ${settings.maskedLangsmithKey}` : 'lsv2_…');
  const hostInput = el('input', { value: settings.langsmithEndpoint || '', placeholder: 'https://api.smith.langchain.com' });
  const projectInput = el('input', { value: settings.langsmithProject || '', placeholder: 'linear-manager' });
  const tracingInput = el('input', { type: 'checkbox', style: 'width:auto', ...(settings.langsmithTracing ? { checked: 'checked' } : {}) });

  const saveBtn = el('button', { class: 'primary' }, 'Save keys');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (linearInput.value.trim()) {
        const r = await api.saveKey(linearInput.value.trim());
        linearInput.value = '';
        linearInput.placeholder = `Saved: ${r.maskedKey}`;
      }
      const lsPayload = {
        langsmithProject: projectInput.value.trim() || 'linear-manager',
        langsmithEndpoint: hostInput.value.trim() || 'https://api.smith.langchain.com',
        langsmithTracing: tracingInput.checked,
      };
      if (langsmithInput.value.trim()) lsPayload.langsmithApiKey = langsmithInput.value.trim();
      const lr = await api.saveLangsmith(lsPayload);
      langsmithInput.value = '';
      langsmithInput.placeholder = lr.hasLangsmithKey ? `Saved: ${lr.maskedLangsmithKey}` : 'lsv2_…';

      status.textContent = 'Keys saved.';
      status.style.color = 'var(--green)';
      toast('Keys saved.', 'ok');
      window.dispatchEvent(new Event('lm:connection-changed'));
    } catch (err) {
      status.textContent = err.message;
      status.style.color = 'var(--red)';
      toast(err.message, 'err');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save keys';
    }
  });

  const removeLinear = el('button', {
    class: 'danger',
    onclick: async () => {
      await api.clearKey();
      linearInput.placeholder = 'lin_api_…';
      status.textContent = 'Linear key removed.';
      status.style.color = 'var(--muted)';
      toast('Linear key removed.');
      window.dispatchEvent(new Event('lm:connection-changed'));
    },
  }, 'Remove Linear key');

  // Reflect current connection state. validate() now returns 200 { ok:false }
  // for a rejected key (instead of a 401), so handle that in the success path.
  if (settings.hasKey) {
    api
      .validate()
      .then((r) => {
        if (r && r.ok === false) {
          status.textContent = `Linear key not working: ${r.error || 'the key was rejected.'}`;
          status.style.color = 'var(--red)';
          return;
        }
        const who = r.viewer ? r.viewer.name : 'your account';
        const org = r.organization ? ` @ ${r.organization.name}` : '';
        status.textContent = `Connected as ${who}${org}.`;
        status.style.color = 'var(--green)';
      })
      .catch((err) => {
        status.textContent = `Linear key not working: ${err.message}`;
        status.style.color = 'var(--red)';
      });
  } else {
    status.textContent = 'No Linear key configured yet.';
  }

  return section('API Keys & Connection', 'Linear · LangSmith', true, [
    el('div', { class: 'subhead' }, 'Linear'),
    field('Linear API Key', linearInput, [
      'Personal key from ',
      el('a', { href: 'https://linear.app/settings/api', target: '_blank', style: 'color:var(--accent-2)' }, 'linear.app/settings/api'),
      '.',
    ]),
    el('div', { class: 'subhead subhead-icon' }, [brandIcon('langsmith', { label: 'LangSmith' }), el('span', {}, 'Tracing')]),
    el('label', { class: 'row', style: 'gap:8px;cursor:pointer;margin:4px 0 6px' }, [tracingInput, el('span', {}, 'Enable tracing')]),
    el('p', { class: 'muted', style: 'margin:0 0 12px;font-size:12px' }, 'When on, agent runs are traced and stored in LangSmith for debugging and evaluation.'),
    field('LangSmith API Key', langsmithInput),
    field('Host / Endpoint', hostInput),
    field('Project', projectInput),
    el('div', { class: 'row' }, [saveBtn, settings.hasKey ? removeLinear : null]),
    status,
    el('p', { class: 'muted', style: 'font-size:12px' }, 'All keys are stored server-side and never returned to the browser.'),
  ]);
}

/* ------------------------ Tool integrations ---------------------------- */

function integrationsSection(settings) {
  const planningProvider = el('select', {}, [
    el('option', { value: 'linear', selected: settings.planningProvider === 'linear' }, 'Linear'),
    el('option', { value: 'jira', selected: settings.planningProvider === 'jira' }, 'Jira'),
    el('option', { value: 'asana', selected: settings.planningProvider === 'asana' }, 'Asana'),
  ]);
  const repositoryProvider = el('select', {}, [
    el('option', { value: 'github', selected: settings.repositoryProvider !== 'gitlab' }, 'GitHub'),
    el('option', { value: 'gitlab', selected: settings.repositoryProvider === 'gitlab' }, 'GitLab'),
  ]);

  const repositoryUrl = el('input', {
    value: settings.repositoryUrl || '',
    placeholder: settings.repositoryProvider === 'gitlab' ? 'group/project' : 'owner/repository',
  });
  const githubToken = pwd(settings.hasGithubToken ? `Saved: ${settings.maskedGithubToken}` : 'github_pat_… / ghp_…');
  const gitlabToken = pwd(settings.hasGitlabToken ? `Saved: ${settings.maskedGitlabToken}` : 'glpat-…');
  const jiraBaseUrl = el('input', { value: settings.jiraBaseUrl || '', placeholder: 'https://company.atlassian.net' });
  const jiraEmail = el('input', { value: settings.jiraEmail || '', type: 'email', placeholder: 'you@company.com' });
  const jiraToken = pwd(settings.hasJiraToken ? `Saved: ${settings.maskedJiraToken}` : 'Jira API token');
  const asanaWorkspaceId = el('input', { value: settings.asanaWorkspaceId || '', placeholder: 'Workspace GID' });
  const asanaToken = pwd(settings.hasAsanaToken ? `Saved: ${settings.maskedAsanaToken}` : 'Asana personal access token');
  const status = el('div', { class: 'muted', style: 'font-size:12px;min-height:18px' });

  const removalControl = (saved, label, tokenInput) => {
    const checkbox = el('input', { type: 'checkbox', style: 'width:auto' });
    const row = el('label', { class: 'row connector-remove', style: 'gap:8px;cursor:pointer' }, [
      checkbox,
      el('span', {}, label),
    ]);
    row.hidden = !saved;
    checkbox.addEventListener('change', () => {
      tokenInput.disabled = checkbox.checked;
      if (checkbox.checked) tokenInput.value = '';
    });
    return { checkbox, row, tokenInput };
  };
  const clearGithub = removalControl(settings.hasGithubToken, 'Remove saved GitHub token', githubToken);
  const clearGitlab = removalControl(settings.hasGitlabToken, 'Remove saved GitLab token', gitlabToken);
  const clearJira = removalControl(settings.hasJiraToken, 'Remove saved Jira token', jiraToken);
  const clearAsana = removalControl(settings.hasAsanaToken, 'Remove saved Asana token', asanaToken);

  const linearFields = el('div', {}, [
    el('div', { class: 'connector-note' }, [
      el('strong', {}, settings.hasKey ? 'Linear is connected.' : 'Linear needs a key.'),
      el('span', {}, settings.hasKey
        ? ' Projects, planning, and agent updates use the Linear key saved above.'
        : ' Save a Linear key in API Keys & Connection to use project automation.'),
    ]),
  ]);
  const jiraFields = el('div', {}, [
    field('Jira site', jiraBaseUrl),
    field('Account email', jiraEmail),
    field('API token', jiraToken, 'Saved server-side. The token is never returned to this page.'),
    clearJira.row,
  ]);
  const asanaFields = el('div', {}, [
    field('Workspace ID', asanaWorkspaceId),
    field('Personal access token', asanaToken, 'Saved server-side. The token is never returned to this page.'),
    clearAsana.row,
  ]);
  const githubFields = el('div', {}, [
    field('GitHub token', githubToken, 'Fine-grained token with repository contents and pull-request access.'),
    clearGithub.row,
  ]);
  const gitlabFields = el('div', {}, [
    field('GitLab token', gitlabToken, 'Project token or personal token with repository write access.'),
    clearGitlab.row,
  ]);

  const syncVisibility = () => {
    linearFields.hidden = planningProvider.value !== 'linear';
    jiraFields.hidden = planningProvider.value !== 'jira';
    asanaFields.hidden = planningProvider.value !== 'asana';
    githubFields.hidden = repositoryProvider.value !== 'github';
    gitlabFields.hidden = repositoryProvider.value !== 'gitlab';
    repositoryUrl.placeholder = repositoryProvider.value === 'gitlab' ? 'group/project' : 'owner/repository';
  };
  planningProvider.addEventListener('change', syncVisibility);
  repositoryProvider.addEventListener('change', syncVisibility);
  syncVisibility();

  const save = el('button', { class: 'primary' }, 'Save integrations');
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    status.textContent = '';
    const payload = {
      planningProvider: planningProvider.value,
      repositoryProvider: repositoryProvider.value,
      repositoryUrl: repositoryUrl.value.trim(),
      jiraBaseUrl: jiraBaseUrl.value.trim(),
      jiraEmail: jiraEmail.value.trim(),
      asanaWorkspaceId: asanaWorkspaceId.value.trim(),
      clearGithubToken: clearGithub.checkbox.checked,
      clearGitlabToken: clearGitlab.checkbox.checked,
      clearJiraToken: clearJira.checkbox.checked,
      clearAsanaToken: clearAsana.checkbox.checked,
    };
    if (githubToken.value.trim()) payload.githubToken = githubToken.value.trim();
    if (gitlabToken.value.trim()) payload.gitlabToken = gitlabToken.value.trim();
    if (jiraToken.value.trim()) payload.jiraApiToken = jiraToken.value.trim();
    if (asanaToken.value.trim()) payload.asanaAccessToken = asanaToken.value.trim();
    try {
      const next = await api.saveIntegrations(payload);
      githubToken.value = '';
      gitlabToken.value = '';
      jiraToken.value = '';
      asanaToken.value = '';
      githubToken.placeholder = next.hasGithubToken ? `Saved: ${next.maskedGithubToken}` : 'github_pat_… / ghp_…';
      gitlabToken.placeholder = next.hasGitlabToken ? `Saved: ${next.maskedGitlabToken}` : 'glpat-…';
      jiraToken.placeholder = next.hasJiraToken ? `Saved: ${next.maskedJiraToken}` : 'Jira API token';
      asanaToken.placeholder = next.hasAsanaToken ? `Saved: ${next.maskedAsanaToken}` : 'Asana personal access token';
      for (const [control, saved] of [
        [clearGithub, next.hasGithubToken],
        [clearGitlab, next.hasGitlabToken],
        [clearJira, next.hasJiraToken],
        [clearAsana, next.hasAsanaToken],
      ]) {
        control.checkbox.checked = false;
        control.tokenInput.disabled = false;
        control.row.hidden = !saved;
      }
      status.textContent = 'Integration choices saved.';
      status.style.color = 'var(--green)';
      toast('Integrations saved.', 'ok');
      window.dispatchEvent(new Event('lm:connection-changed'));
    } catch (err) {
      status.textContent = err.message;
      status.style.color = 'var(--red)';
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
      save.textContent = 'Save integrations';
    }
  });

  const repoName = settings.repositoryProvider === 'gitlab' ? 'GitLab' : 'GitHub';
  const planName = ({ linear: 'Linear', jira: 'Jira', asana: 'Asana' })[settings.planningProvider] || 'Linear';
  return section('Tool integrations', `${planName} · ${repoName}`, true, [
    el('p', { class: 'muted', style: 'font-size:13px;margin-top:0' }, 'Save planning-connector and repository credentials on this server. Live project views and scheduled planning remain Linear-backed; Jira and Asana are ready as stored connector choices for routing extensions.'),
    el('div', { class: 'subhead' }, 'Project planning'),
    field('Planning tool', planningProvider),
    linearFields,
    jiraFields,
    asanaFields,
    el('div', { class: 'subhead' }, 'Code repository'),
    field('Repository host', repositoryProvider),
    field('Default repository', repositoryUrl, 'Use owner/name, group/project, or a GitHub/GitLab Git URL.'),
    githubFields,
    gitlabFields,
    el('div', { class: 'row' }, [save, status]),
  ]);
}

/* ------------------------------- Deep Agent LLM ------------------------- */

function llmSection(ctx) {
  const container = el('div', { class: 'llm-section' });
  const rebuild = () => {
    const previous = container.firstElementChild;
    const wasOpen = previous && previous.tagName === 'DETAILS' ? previous.open : null;
    const customOpen = new Set(
      [...container.querySelectorAll('.preset-card')]
        .filter((card) => card.querySelector('.preset-customize[open]'))
        .map((card) => card.dataset.role)
    );
    clear(container).append(buildLlmSection(ctx, rebuild));
    if (wasOpen === true && container.firstElementChild) container.firstElementChild.open = true;
    for (const role of customOpen) {
      const details = container.querySelector(`.preset-card[data-role="${role}"] .preset-customize`);
      if (details) details.open = true;
    }
  };

  ctx.rebuild = rebuild;
  rebuild();
  queueMicrotask(() => {
    for (const entry of LLM_ROLES) {
      void discoverProviderModels(ctx, entry.role, roleProvider(ctx.settings, entry.role), false, rebuild);
    }
  });
  return container;
}

const PROVIDER_LABELS = Object.freeze({
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  omlx: 'oMLX',
  codex: 'OpenAI',
  claude: 'Anthropic',
  huggingface: 'Hugging Face',
  antigravity: 'Gemini',
});

const PROVIDER_DEPLOYMENT = Object.freeze({
  ollama: 'byom',
  lmstudio: 'byom',
  omlx: 'byom',
  huggingface: 'byom',
  codex: 'hosted',
  claude: 'hosted',
  antigravity: 'hosted',
});

// Task-model roles. Each role is provider-flexible and maps to its own settings
// fields; deployment is the release-stage model, not a provider-class slot.
const LLM_ROLES = Object.freeze([
  {
    role: 'thinking',
    provider: 'thinkingLlmProvider',
    preset: 'thinkingLlmPresetId',
    heading: 'Thinking · task planning',
    description: 'Used by the planner to generate and enrich plans.',
  },
  {
    role: 'execution',
    provider: 'executionLlmProvider',
    preset: 'executionLlmPresetId',
    heading: 'Execution · coder',
    description: 'Used by the code-writer for every coding task.',
  },
  {
    role: 'testing',
    provider: 'testingLlmProvider',
    preset: 'testingLlmPresetId',
    heading: 'Testing · verification',
    description: 'Used by the tester to verify changes and produce evidence.',
  },
  {
    role: 'deployment',
    provider: 'deploymentLlmProvider',
    preset: 'deploymentLlmPresetId',
    heading: 'Deployment · release',
    description: 'Used by the deployer after a successful full test stage and approval.',
  },
]);
const ROLE_FIELDS = Object.freeze(Object.fromEntries(
  LLM_ROLES.map((entry) => [entry.role, { provider: entry.provider, preset: entry.preset }])
));
const ROLE_META = Object.freeze(Object.fromEntries(
  LLM_ROLES.map((entry) => [entry.role, { heading: entry.heading, description: entry.description }])
));
const ALL_PROVIDERS = Object.freeze(['ollama', 'lmstudio', 'omlx', 'codex', 'claude', 'huggingface', 'antigravity']);
const ROLE_PROVIDERS = Object.freeze({
  // Legacy provider-class slots, kept for provider-scoped callers. "byom"
  // (Bring Your Own Model) folds Hugging Face in with the local runtimes.
  byom: ['ollama', 'lmstudio', 'omlx', 'huggingface'],
  hosted: ['codex', 'claude', 'antigravity'],
  // Task roles accept any provider (BYoM or hosted).
  thinking: ALL_PROVIDERS,
  execution: ALL_PROVIDERS,
  testing: ALL_PROVIDERS,
  deployment: ALL_PROVIDERS,
});

// Providers that truly run on the operator's own machine. Narrower than the BYoM
// group (which also includes the Hugging Face hosted router): only these get the
// "runs privately" hint, the local discovery source, and substring model matching.
const LOCAL_INFERENCE_PROVIDERS = new Set(['ollama', 'lmstudio', 'omlx']);

const REASONING_META = Object.freeze({
  none: { label: 'Off', description: 'Do not request additional reasoning from this model.' },
  low: { label: 'Low', description: 'Fast responses with lighter reasoning.' },
  medium: { label: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks.' },
  high: { label: 'High', description: 'Greater reasoning depth for complex problems.' },
  xhigh: { label: 'Extra high', description: 'Extra high reasoning depth for complex problems.' },
  max: { label: 'Max', description: 'Maximum reasoning depth for the hardest problems.' },
  ultra: { label: 'Ultra', description: 'Maximum reasoning with automatic task delegation.' },
});

function buildLlmSection(ctx, rebuild) {
  const summary = LLM_ROLES.map((entry) => {
    const provider = roleProvider(ctx.settings, entry.role);
    const model = currentParameters(ctx.settings, provider).model || 'Choose model';
    const name = entry.heading.split(' · ')[0];
    return `${name}: ${PROVIDER_LABELS[provider] || provider} · ${model}`;
  }).join(' · ');
  const incomplete = LLM_ROLES.some((entry) => {
    const provider = roleProvider(ctx.settings, entry.role);
    return !currentParameters(ctx.settings, provider).model || !providerConnected(ctx, provider);
  });

  return section('Task Models', summary, incomplete, [
    el('p', { class: 'muted settings-section-intro' }, 'Assign a model to each task type. Each role picks any provider — BYoM (Ollama / LM Studio / oMLX / Hugging Face) or hosted (OpenAI / Anthropic) — plus a model and model-supported reasoning level. Model changes save immediately; recommended context, output, and sampling values are applied automatically, and advanced values use an explicit save.'),
    el('div', { class: 'preset-stack' }, LLM_ROLES.map((entry) => presetSlot(ctx, entry.role, rebuild))),
  ]);
}

function findPreset(ctx, id, deployment) {
  return (ctx.presets.presets || []).find(
    (preset) => preset.id === id && (!deployment || preset.deployment === deployment)
  ) || null;
}

function roleProvider(settings, role) {
  const fields = ROLE_FIELDS[role];
  if (fields) return settings[fields.provider];
  return role === 'byom' ? settings.byomProvider : settings.llmProvider;
}

function selectedPresetId(settings, role) {
  const fields = ROLE_FIELDS[role];
  if (fields) return settings[fields.preset];
  return role === 'byom' ? settings.byomPresetId : settings.hostedLlmPresetId;
}

function providerConnected(ctx, provider) {
  if (provider === 'codex') return Boolean(ctx.codex && ctx.codex.connected);
  if (provider === 'claude') return Boolean(ctx.claude && ctx.claude.connected);
  if (provider === 'huggingface') return Boolean(ctx.settings && ctx.settings.hasHuggingfaceApiKey);
  if (provider === 'antigravity') return Boolean(ctx.settings && ctx.settings.hasAntigravityApiKey);
  return true;
}

function presetSlot(ctx, role, rebuild) {
  const slotProvider = roleProvider(ctx.settings, role);
  // A task role's provider class follows whichever provider it names.
  const deployment = PROVIDER_DEPLOYMENT[slotProvider] || 'hosted';
  const preset = findPreset(ctx, selectedPresetId(ctx.settings, role), deployment);
  const provider = preset ? preset.provider : slotProvider;
  const params = currentParameters(ctx.settings, provider);
  const customized = Boolean(preset && presetCustomized(preset, params));
  const pending = Boolean(ctx.selectionPending[role]);
  const modelEntries = modelsForProvider(ctx, provider);
  const selectedModel = modelEntries.find((entry) => entry.id === params.model) || null;
  const profilePreset = preset || findPresetForModel(ctx, provider, params.model);
  const reasoningOptions = reasoningOptionsFor(selectedModel, profilePreset);
  const modelDefaultReasoning = defaultReasoningFor(selectedModel, profilePreset);
  const profileAdapter = selectedModel && selectedModel.reasoningAdapter ||
    profilePreset && profilePreset.capabilities && profilePreset.capabilities.reasoningAdapter || 'none';
  const currentAdapter = configuredReasoningAdapter(ctx.settings, provider);
  const adapterActive = currentAdapter === profileAdapter;
  const currentReasoning = adapterActive && reasoningOptions.some((option) => option.value === params.reasoningEffort)
    ? params.reasoningEffort
    : '';
  const editorPreset = preset || customEditorPreset(provider, params, ctx.settings, deployment);

  const applySelection = async ({ nextProvider, model, reasoningEffort, mode }) => {
    ctx.selectionPending[role] = true;
    rebuild();
    try {
      const response = await api.applyLlmSelection({
        role,
        provider: nextProvider,
        model,
        reasoningEffort,
        mode,
      });
      Object.assign(ctx.settings, response && response.settings ? response.settings : response);
      toast(
        mode === 'reasoning'
          ? `Reasoning set to ${reasoningLabel(reasoningEffort)}.`
          : `${PROVIDER_LABELS[nextProvider] || nextProvider} model set to ${model}.`,
        'ok'
      );
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      ctx.selectionPending[role] = false;
      rebuild();
    }
  };

  const providerSelect = optionSelect(
    ROLE_PROVIDERS[role].map((value) => [value, PROVIDER_LABELS[value] || value]),
    provider
  );
  providerSelect.className = 'llm-provider-select';
  providerSelect.disabled = pending;
  providerSelect.addEventListener('change', () => {
    const nextProvider = providerSelect.value;
    void (async () => {
      ctx.selectionPending[role] = true;
      rebuild();
      try {
        await discoverProviderModels(ctx, role, nextProvider, false, rebuild);
        const recommended = recommendedModelEntry(ctx, nextProvider);
        if (!recommended) {
          ctx.selectionPending[role] = false;
          rebuild();
          return toast(`No models are configured for ${PROVIDER_LABELS[nextProvider] || nextProvider}.`, 'err');
        }
        await applySelection({
          nextProvider,
          model: recommended.id,
          reasoningEffort: defaultReasoningFor(recommended, recommended.preset),
          mode: 'model',
        });
      } catch (err) {
        ctx.selectionPending[role] = false;
        rebuild();
        toast(err.message, 'err');
      }
    })();
  });

  const modelSelect = modelSelectControl(modelEntries, params.model);
  modelSelect.disabled = pending || !modelEntries.length;
  modelSelect.addEventListener('change', () => {
    const selected = modelEntries.find((entry) => entry.id === modelSelect.value);
    if (!selected) return;
    void applySelection({
      nextProvider: provider,
      model: selected.id,
      reasoningEffort: defaultReasoningFor(selected, selected.preset),
      mode: 'model',
    });
  });

  const reasoningSelect = optionSelect(
    [
      ...(!currentReasoning && reasoningOptions.length
        ? [['', `Apply ${reasoningLabel(modelDefaultReasoning)} default…`]]
        : []),
      ...reasoningOptions.map((option) => [
        option.value,
        `${option.label}${option.value === modelDefaultReasoning ? ' (default)' : ''}`,
      ]),
    ],
    currentReasoning
  );
  reasoningSelect.className = 'llm-reasoning-select';
  reasoningSelect.disabled = pending || !reasoningOptions.length;
  const reasoningHint = el('span', {}, reasoningDescription(reasoningOptions, currentReasoning));
  reasoningSelect.addEventListener('change', () => {
    const chosen = reasoningOptions.find((option) => option.value === reasoningSelect.value);
    reasoningHint.textContent = chosen ? chosen.description : '';
    if (!chosen) return;
    void applySelection({
      nextProvider: provider,
      model: params.model,
      reasoningEffort: chosen.value,
      mode: 'reasoning',
    });
  });

  const meta = ROLE_META[role] || {};
  const heading = meta.heading || role;
  const deploymentHint = LOCAL_INFERENCE_PROVIDERS.has(provider)
    ? ` Runs privately on this machine through ${PROVIDER_LABELS[provider] || provider}.`
    : provider === 'huggingface'
      ? ' Runs on the Hugging Face hosted router — your own model, billed to your HF account (BYoM).'
      : ' Runs on a hosted OAuth provider (OpenAI / Anthropic).';
  const description = `${meta.description || ''}${deploymentHint}`;
  const status = modelDiscoveryStatus(ctx, role, provider, params.model, rebuild);
  const children = [
    el('div', { class: 'preset-card-head' }, [
      el('div', {}, [el('div', { class: 'preset-title' }, heading), el('div', { class: 'muted preset-route' }, description)]),
      customized || !preset ? el('span', { class: 'badge preset-custom-badge' }, 'Customized') : null,
    ]),
    el('div', { class: 'llm-primary-grid' }, [
      field('Provider', providerSelect),
      field('Model', modelSelect, modelEntries.length ? `${modelEntries.length} model${modelEntries.length === 1 ? '' : 's'} available in this list.` : 'No models found yet.'),
      field('Reasoning', reasoningSelect, reasoningHint),
    ]),
  ];

  if (preset || selectedModel) {
    const descriptionText = (selectedModel && selectedModel.description) || (preset && preset.description);
    children.push(
      descriptionText ? el('p', { class: 'preset-description' }, descriptionText) : null,
      parameterSummary(params, reasoningOptions, currentReasoning, selectedModel && selectedModel.cost),
      profilePreset && profilePreset.requirements ? el('p', { class: 'muted preset-requirement' }, [
        profilePreset.requirements,
        profilePreset.sourceUrl ? ' ' : null,
        profilePreset.sourceUrl ? el('a', { href: profilePreset.sourceUrl, target: '_blank', rel: 'noopener', class: 'preset-doc-link' }, 'Model docs ↗') : null,
      ]) : null
    );
  } else {
    children.push(
      el('div', { class: 'preset-legacy-note' }, [
        el('strong', {}, `Custom ${PROVIDER_LABELS[provider] || provider} configuration`),
        el('span', {}, ' This discovered model has no catalog profile, so provider-specific reasoning overrides remain disabled.'),
      ])
    );
  }

  if (LOCAL_INFERENCE_PROVIDERS.has(provider) && editorPreset) {
    children.push(localConnectionEditor(ctx, role, editorPreset, params, rebuild));
  }
  children.push(status);
  if (provider === 'codex' || provider === 'claude') {
    // Full sign-in lives in the Accounts section at the bottom; show only status here.
    children.push(hostedStatusPill(ctx, provider));
  }
  if (provider === 'huggingface' && editorPreset) {
    children.push(huggingfaceConnection(ctx, role, editorPreset, params, rebuild));
  }
  if (editorPreset) children.push(parameterEditor(ctx, role, editorPreset, params, rebuild));

  return el('div', { class: `preset-card preset-card-${deployment}`, dataset: { role } }, children);
}

function customEditorPreset(provider, params, settings, deployment) {
  const isOllama = provider === 'ollama';
  const isLmstudio = provider === 'lmstudio';
  const isOmlx = provider === 'omlx';
  const isOpenAiLocal = isLmstudio || isOmlx;
  const isCodex = provider === 'codex';
  const isHuggingface = provider === 'huggingface';
  let adapter = 'none';
  if (isOllama && ['ollama-think-effort', 'ollama-think-toggle'].includes(settings.ollamaReasoningAdapter)) {
    adapter = settings.ollamaReasoningAdapter;
  } else if (isLmstudio && settings.lmstudioReasoningAdapter === 'openai-compatible') {
    adapter = 'openai-compatible';
  } else if (isOmlx && settings.omlxReasoningAdapter === 'omlx-template-effort') {
    adapter = 'omlx-template-effort';
  } else if (isCodex && settings.codexReasoningAdapter === 'openai') {
    adapter = 'openai';
  } else if (isHuggingface && settings.huggingfaceReasoningAdapter === 'openai') {
    adapter = 'openai';
  } else if (!isOpenAiLocal && !isOllama && !isCodex && !isHuggingface &&
    ['anthropic-adaptive', 'anthropic-effort'].includes(settings.claudeReasoningAdapter)) {
    adapter = settings.claudeReasoningAdapter;
  }

  let efforts = ['none'];
  if (adapter === 'ollama-think-effort' || adapter === 'omlx-template-effort') efforts = ['low', 'medium', 'high'];
  else if (adapter === 'ollama-think-toggle') efforts = ['none', 'medium'];
  else if (adapter === 'openai-compatible') efforts = ['none', 'low', 'medium', 'high'];
  else if (adapter === 'openai') efforts = ['none', 'low', 'medium', 'high', 'xhigh'];
  else if (adapter === 'anthropic-adaptive' || adapter === 'anthropic-effort') {
    efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  }

  const parameter = {
    'ollama-think-effort': 'think',
    'ollama-think-toggle': 'think',
    'openai-compatible': 'reasoning_effort',
    'omlx-template-effort': 'chat_template_kwargs.reasoning_effort',
    openai: 'reasoning.effort',
    'anthropic-adaptive': 'thinking.type=adaptive + output_config.effort',
    'anthropic-effort': 'output_config.effort',
  }[adapter] || null;
  return {
    id: 'custom',
    provider,
    deployment,
    model: params.model,
    limits: {
      contextWindow: isOllama || isOpenAiLocal ? 262144 : isCodex ? 1050000 : 1000000,
      maxOutputTokens: 128000,
    },
    requestLimits: {
      maxOutputContextFraction: isOpenAiLocal ? 0.5 : isOllama ? 1 : null,
    },
    capabilities: {
      temperature: isOllama || isOpenAiLocal || ((isCodex || isHuggingface) && adapter === 'none'),
      contextWindowConfigurable: isOllama || isOpenAiLocal,
      reasoningAdapter: adapter,
      reasoningEfforts: efforts,
      streamingConfigurable: !isOllama && !isOpenAiLocal && !isCodex,
    },
    parameters: {
      contextWindow: params.contextWindow,
      maxOutputTokens: params.maxOutputTokens,
      streaming: params.streaming,
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      repeatPenalty: params.repeatPenalty,
      reasoning: { effort: params.reasoningEffort, parameter },
      jsonMode: params.jsonMode,
      contextMode: params.contextMode,
    },
  };
}

function normalizedModel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function modelMatchesPreset(preset, model) {
  const actual = normalizedModel(model);
  const patterns = [preset.model, ...(preset.modelPatterns || [])].map(normalizedModel).filter(Boolean);
  // Local-inference runtimes carry noisy, quantized file names, so match by
  // substring; hosted-inference vendors (Codex, Claude, Hugging Face) use
  // canonical ids, so match exactly.
  return LOCAL_INFERENCE_PROVIDERS.has(preset.provider)
    ? patterns.some((pattern) => actual.includes(pattern))
    : patterns.includes(actual);
}

function findPresetForModel(ctx, provider, model) {
  return (ctx.presets.presets || []).find((preset) => preset.provider === provider && modelMatchesPreset(preset, model)) || null;
}

function discoveryState(ctx, provider) {
  if (!ctx.discovery[provider]) {
    ctx.discovery[provider] = {
      models: [], loading: false, loaded: false, reachable: null,
      source: 'catalog', error: '', requestId: 0,
    };
  }
  return ctx.discovery[provider];
}

function modelEntryFromPreset(preset) {
  return {
    id: preset.model,
    label: preset.label || preset.model,
    description: preset.description || '',
    cost: preset.cost || null,
    contextWindow: preset.limits && preset.limits.contextWindow,
    maxOutputTokens: preset.limits && preset.limits.maxOutputTokens,
    reasoningAdapter: preset.capabilities && preset.capabilities.reasoningAdapter,
    reasoningEfforts: preset.capabilities && preset.capabilities.reasoningEfforts,
    defaultReasoningEffort: preset.parameters && preset.parameters.reasoning && preset.parameters.reasoning.effort,
    source: 'catalog',
    recommended: Boolean(preset.recommended),
    preset,
  };
}

function discoveredModelEntry(ctx, provider, raw, source) {
  const value = typeof raw === 'string' ? { id: raw } : raw || {};
  const id = String(value.id || value.model || '').trim();
  if (!id) return null;
  const preset = findPresetForModel(ctx, provider, id);
  const catalog = preset ? modelEntryFromPreset(preset) : {};
  const modelSource = value.source || source || 'provider';
  return {
    ...catalog,
    ...value,
    id,
    label: value.label || catalog.label || id,
    description: value.description || catalog.description || '',
    reasoningAdapter: value.reasoningAdapter || catalog.reasoningAdapter || 'none',
    reasoningEfforts: Array.isArray(value.reasoningEfforts) ? value.reasoningEfforts : catalog.reasoningEfforts || [],
    defaultReasoningEffort: value.defaultReasoningEffort || catalog.defaultReasoningEffort || 'none',
    source: modelSource,
    available: ['live', 'local', 'provider'].includes(modelSource),
    recommended: value.recommended === undefined ? Boolean(catalog.recommended) : Boolean(value.recommended),
    preset: preset || null,
  };
}

function modelsForProvider(ctx, provider) {
  const entries = new Map();
  for (const preset of (ctx.presets.presets || []).filter((item) => item.provider === provider)) {
    const entry = modelEntryFromPreset(preset);
    entries.set(entry.id, entry);
  }
  const state = discoveryState(ctx, provider);
  for (const entry of state.models) {
    const current = entries.get(entry.id);
    entries.set(entry.id, current ? { ...current, ...entry, preset: entry.preset || current.preset } : entry);
  }
  const configured = currentParameters(ctx.settings, provider).model;
  if (configured && !entries.has(configured)) {
    const preset = findPresetForModel(ctx, provider, configured);
    entries.set(configured, {
      ...(preset ? modelEntryFromPreset(preset) : {}),
      id: configured,
      label: configured,
      source: 'current',
      available: state.models.some((entry) => entry.id === configured),
      preset,
    });
  }
  const values = [...entries.values()].map((entry) => {
    if (provider !== 'codex' || !ctx.codex || ctx.codex.backend !== 'api') return entry;
    const efforts = normalizeReasoningOptions(entry.reasoningEfforts)
      .filter((effort) => effort.value !== 'ultra');
    return {
      ...entry,
      reasoningEfforts: efforts,
      defaultReasoningEffort: efforts.some((effort) => effort.value === entry.defaultReasoningEffort)
        ? entry.defaultReasoningEffort
        : efforts.some((effort) => effort.value === 'medium') ? 'medium' : efforts[0] && efforts[0].value,
    };
  });
  return values.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (Boolean(a.available) !== Boolean(b.available)) return a.available ? -1 : 1;
    return String(a.label || a.id).localeCompare(String(b.label || b.id));
  });
}

function recommendedModelEntry(ctx, provider) {
  const entries = modelsForProvider(ctx, provider);
  const recommendedPreset = (ctx.presets.presets || []).find((preset) => preset.provider === provider && preset.recommended);
  const availableAlias = recommendedPreset && entries.find((entry) => entry.available && modelMatchesPreset(recommendedPreset, entry.id));
  return availableAlias || entries.find((entry) => entry.available) ||
    entries.find((entry) => entry.recommended) || entries[0] || null;
}

function modelSelectControl(entries, current) {
  const option = (entry) => el('option', { value: entry.id, selected: entry.id === current, dataset: { i18nSkip: 'true' } },
    `${entry.recommended ? '★ ' : ''}${entry.label}${entry.label !== entry.id ? ` — ${entry.id}` : ''}${costSuffix(entry.cost)}`);
  const recommended = entries.filter((entry) => entry.recommended);
  const available = entries.filter((entry) => !entry.recommended && entry.available);
  const other = entries.filter((entry) => !entry.recommended && !entry.available);
  const groups = [];
  if (recommended.length) groups.push(el('optgroup', { label: 'Recommended' }, recommended.map(option)));
  if (available.length) groups.push(el('optgroup', { label: 'Available' }, available.map(option)));
  if (other.length) groups.push(el('optgroup', { label: 'Catalog / current' }, other.map(option)));
  return el('select', { class: 'llm-model-select' }, groups);
}

function normalizeReasoningOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.map((item) => {
    const value = typeof item === 'string' ? item : item && item.value;
    if (!value || seen.has(value)) return null;
    seen.add(value);
    const fallback = REASONING_META[value] || {
      label: value[0].toUpperCase() + value.slice(1),
      description: '',
    };
    return {
      value,
      label: typeof item === 'object' && item.label ? item.label : fallback.label,
      description: value === 'ultra'
        ? REASONING_META.ultra.description
        : typeof item === 'object' && item.description ? item.description : fallback.description,
    };
  }).filter(Boolean);
}

function reasoningOptionsFor(entry, preset) {
  if (entry && Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length) {
    return normalizeReasoningOptions(entry.reasoningEfforts);
  }
  return normalizeReasoningOptions(preset && preset.capabilities && preset.capabilities.reasoningEfforts);
}

function defaultReasoningFor(entry, preset) {
  const options = reasoningOptionsFor(entry, preset);
  const preferred = entry && entry.defaultReasoningEffort ||
    preset && preset.parameters && preset.parameters.reasoning && preset.parameters.reasoning.effort;
  return options.some((option) => option.value === preferred)
    ? preferred
    : options[0] ? options[0].value : 'none';
}

function reasoningLabel(value) {
  return (REASONING_META[value] && REASONING_META[value].label) || value || 'Provider default';
}

function reasoningDescription(options, current) {
  const selected = options.find((option) => option.value === current);
  if (selected) return selected.description;
  return options.length
    ? 'Reasoning is not active for the saved configuration; choose a supported level to apply it.'
    : 'This model has no configurable reasoning profile.';
}

async function discoverProviderModels(ctx, role, provider, refresh, rebuild) {
  if (!provider || !ROLE_PROVIDERS[role].includes(provider)) return;
  const state = discoveryState(ctx, provider);
  const requestId = ++state.requestId;
  state.loading = true;
  state.error = '';
  rebuild();
  try {
    const response = await api.getProviderModels(provider, refresh);
    if (requestId !== state.requestId) return;
    const source = response.source || (LOCAL_INFERENCE_PROVIDERS.has(provider) ? 'local' : 'provider');
    state.models = (response.models || [])
      .map((model) => discoveredModelEntry(ctx, provider, model, source))
      .filter(Boolean);
    state.reachable = response.reachable !== false;
    state.source = source;
    state.loaded = true;
  } catch (err) {
    if (requestId !== state.requestId) return;
    state.models = [];
    state.reachable = false;
    state.loaded = true;
    state.error = err.message || 'Model discovery failed.';
  } finally {
    if (requestId !== state.requestId) return;
    state.loading = false;
    if (roleProvider(ctx.settings, role) === provider) rebuild();
  }
}

function modelDiscoveryStatus(ctx, role, provider, model, rebuild) {
  const state = discoveryState(ctx, provider);
  const refresh = el('button', {
    class: 'preset-inline-action llm-refresh-models',
    disabled: state.loading ? 'disabled' : null,
    onclick: () => void discoverProviderModels(ctx, role, provider, true, rebuild),
  }, state.loading ? 'Refreshing…' : 'Refresh models');
  if (state.loading && !state.loaded) {
    return el('div', { class: 'preset-status busy', role: 'status', 'aria-live': 'polite' }, [
      el('span', {}, `Discovering ${PROVIDER_LABELS[provider] || provider} models…`), refresh,
    ]);
  }
  if (!state.loaded) {
    return el('div', { class: 'preset-status busy', role: 'status', 'aria-live': 'polite' }, [
      el('span', {}, 'Model catalog is ready; checking live availability…'), refresh,
    ]);
  }
  if (state.reachable === false) {
    return el('div', { class: 'preset-status warn', role: 'status', 'aria-live': 'polite' }, [
      el('span', {}, `${state.error || `${PROVIDER_LABELS[provider] || provider} is not reachable.`} Showing catalog and current models.`),
      refresh,
    ]);
  }
  const exact = state.models.some((entry) => entry.id === model);
  const count = state.models.length;
  const sourceLabel = state.source === 'fallback' || state.source === 'catalog' ? 'the catalog' : state.source || 'the provider';
  const message = LOCAL_INFERENCE_PROVIDERS.has(provider)
    ? exact
      ? provider === 'omlx' ? `Ready · ${model} available` : `Ready · ${model} detected`
      : `${count} local model${count === 1 ? '' : 's'} available; ${model || 'the selected model'} was not found.`
    : `${count} ${PROVIDER_LABELS[provider] || provider} model${count === 1 ? '' : 's'} loaded from ${sourceLabel}.`;
  const healthy = LOCAL_INFERENCE_PROVIDERS.has(provider)
    ? exact
    : state.source === 'live';
  return el('div', { class: `preset-status ${healthy ? 'ok' : 'warn'}`, role: 'status', 'aria-live': 'polite' }, [
    el('span', {}, message), refresh,
  ]);
}

function currentParameters(settings, provider) {
  if (provider === 'ollama') return {
    host: settings.ollamaHost,
    model: settings.ollamaModel,
    contextWindow: settings.ollamaContextWindow,
    maxOutputTokens: settings.ollamaNumTokens,
    temperature: settings.ollamaTemperature,
    topP: settings.ollamaTopP,
    topK: settings.ollamaTopK,
    repeatPenalty: settings.ollamaRepeatPenalty,
    reasoningEffort: settings.ollamaReasoningEffort || 'none',
    jsonMode: settings.ollamaJsonMode || 'json',
    contextMode: null,
  };
  if (provider === 'lmstudio') return {
    host: settings.lmstudioHost,
    model: settings.lmstudioModel,
    contextWindow: settings.lmstudioContextWindow,
    maxOutputTokens: settings.lmstudioNumTokens,
    temperature: settings.lmstudioTemperature,
    topP: settings.lmstudioTopP,
    topK: settings.lmstudioTopK,
    repeatPenalty: settings.lmstudioRepeatPenalty,
    reasoningEffort: settings.lmstudioReasoningEffort || 'none',
    jsonMode: settings.lmstudioJsonMode || 'text',
    contextMode: settings.lmstudioContextMode || 'summarize',
  };
  if (provider === 'omlx') return {
    host: settings.omlxHost,
    model: settings.omlxModel,
    contextWindow: settings.omlxContextWindow,
    maxOutputTokens: settings.omlxNumTokens,
    temperature: settings.omlxTemperature,
    topP: settings.omlxTopP,
    topK: settings.omlxTopK,
    repeatPenalty: settings.omlxRepeatPenalty,
    reasoningEffort: settings.omlxReasoningEffort || 'none',
    jsonMode: settings.omlxJsonMode || 'json_schema',
    contextMode: settings.omlxContextMode || 'summarize',
  };
  if (provider === 'codex') return {
    model: settings.codexModel || 'gpt-5.5',
    contextWindow: settings.codexContextWindow || 1050000,
    maxOutputTokens: settings.codexMaxTokens || 65536,
    temperature: settings.codexTemperature,
    topP: null, topK: null, repeatPenalty: null,
    reasoningEffort: settings.codexReasoningEffort || 'high',
    jsonMode: null,
    contextMode: null,
  };
  if (provider === 'huggingface') return {
    host: settings.huggingfaceHost,
    model: settings.huggingfaceModel,
    contextWindow: settings.huggingfaceContextWindow || 32768,
    maxOutputTokens: settings.huggingfaceMaxTokens || 8192,
    temperature: settings.huggingfaceTemperature,
    topP: null, topK: null, repeatPenalty: null,
    reasoningEffort: settings.huggingfaceReasoningEffort || 'none',
    jsonMode: null,
    contextMode: null,
  };
  return {
    model: settings.claudeModel || 'claude-opus-4-8',
    contextWindow: settings.claudeContextWindow || 1000000,
    maxOutputTokens: settings.claudeMaxTokens || 65536,
    streaming: settings.claudeStreaming !== false,
    temperature: settings.claudeTemperature,
    topP: null, topK: null, repeatPenalty: null,
    reasoningEffort: settings.claudeReasoningEffort || 'xhigh',
    jsonMode: null,
    contextMode: null,
  };
}

function configuredReasoningAdapter(settings, provider) {
  if (provider === 'ollama') return settings.ollamaReasoningAdapter || 'none';
  if (provider === 'lmstudio') return settings.lmstudioReasoningAdapter || 'none';
  if (provider === 'omlx') return settings.omlxReasoningAdapter || 'none';
  if (provider === 'codex') return settings.codexReasoningAdapter || 'none';
  if (provider === 'huggingface') return settings.huggingfaceReasoningAdapter || 'none';
  return settings.claudeReasoningAdapter || 'none';
}

function presetCustomized(preset, params) {
  const defaults = preset.parameters;
  return !modelMatchesPreset(preset, params.model) ||
    Number(params.contextWindow) !== Number(defaults.contextWindow) ||
    Number(params.maxOutputTokens) !== Number(defaults.maxOutputTokens) ||
    (params.temperature ?? null) !== (defaults.temperature ?? null) ||
    (params.topP ?? null) !== (defaults.topP ?? null) ||
    (params.topK ?? null) !== (defaults.topK ?? null) ||
    (params.repeatPenalty ?? null) !== (defaults.repeatPenalty ?? null) ||
    params.reasoningEffort !== defaults.reasoning.effort ||
    params.jsonMode !== defaults.jsonMode ||
    params.contextMode !== defaults.contextMode ||
    (defaults.streaming !== undefined && (params.streaming !== false) !== (defaults.streaming !== false));
}

function compactTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000000) return `${Number((n / 1000000).toFixed(2))}M`;
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}K`;
  return String(n);
}

function parameterSummary(params, reasoningOptions = [], effectiveReasoning = params.reasoningEffort, cost = null) {
  const temperature = typeof params.temperature === 'number' ? params.temperature : 'managed';
  const reasoning = reasoningOptions.some((option) => option.value === effectiveReasoning)
    ? reasoningLabel(effectiveReasoning)
    : 'Not selected';
  const costChip = costChipText(cost);
  return el('div', { class: 'preset-params' }, [
    el('span', { class: 'param-chip' }, `Context ${compactTokens(params.contextWindow)}`),
    el('span', { class: 'param-chip' }, `Output ${compactTokens(params.maxOutputTokens)}`),
    el('span', { class: 'param-chip' }, `Reasoning ${reasoning}`),
    el('span', { class: 'param-chip' }, `Temperature ${temperature}`),
    costChip ? el('span', { class: 'param-chip cost' }, costChip) : null,
  ]);
}

/** Indicative price, e.g. "$3 in · $15 out /1M". Empty when unpriced (BYoM/varies). */
function costChipText(cost) {
  if (!cost || !Number.isFinite(cost.inputPer1M) || !Number.isFinite(cost.outputPer1M)) return '';
  if (cost.inputPer1M === 0 && cost.outputPer1M === 0) return 'Free (self-hosted)';
  return `$${cost.inputPer1M} in · $${cost.outputPer1M} out /1M`;
}

/** Compact per-option cost suffix for a model dropdown; empty when unpriced. */
function costSuffix(cost) {
  const text = costChipText(cost);
  return text ? `  ·  ${text}` : '';
}

function optionSelect(options, current) {
  return el('select', {}, options.map(([value, label]) => el('option', { value, selected: value === current }, label)));
}

function localConnectionEditor(ctx, role, preset, params, rebuild) {
  const provider = preset.provider;
  const isOmlx = provider === 'omlx';
  const meta = {
    ollama: {
      placeholder: 'http://127.0.0.1:11434',
      apiPath: '/api/tags',
      hint: 'Address of the Ollama server that exposes your installed models.',
    },
    lmstudio: {
      placeholder: 'http://127.0.0.1:1234',
      apiPath: '/v1/models',
      hint: 'Address of the LM Studio local server. Start the server before testing.',
    },
    omlx: {
      placeholder: 'http://127.0.0.1:8000',
      apiPath: '/v1/models',
      hint: 'Use the oMLX server origin or its /v1 API URL. The saved address is normalized automatically.',
    },
  }[provider];
  if (!meta) return null;

  const hostInput = el('input', {
    type: 'url',
    value: params.host || '',
    placeholder: meta.placeholder,
    autocomplete: 'url',
    spellcheck: 'false',
  });
  const endpoint = el('code', { class: 'local-endpoint-value', dataset: { i18nSkip: 'true' } });
  const refreshEndpoint = () => {
    let base = hostInput.value.trim().replace(/\/$/, '');
    if (isOmlx) base = base.replace(/\/v1$/i, '');
    endpoint.textContent = `${base || meta.placeholder}${meta.apiPath}`;
  };
  hostInput.addEventListener('input', refreshEndpoint);
  refreshEndpoint();

  const keyInput = isOmlx
    ? pwd(ctx.settings.hasOmlxApiKey ? `Saved: ${ctx.settings.maskedOmlxApiKey}` : 'Optional API key')
    : null;
  const clearKey = isOmlx && ctx.settings.hasOmlxApiKey
    ? el('input', { type: 'checkbox', style: 'width:auto' })
    : null;
  if (clearKey) {
    clearKey.addEventListener('change', () => {
      keyInput.disabled = clearKey.checked;
      if (clearKey.checked) keyInput.value = '';
    });
  }

  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });
  const save = el('button', { class: 'primary', type: 'button' }, 'Save & test');
  save.addEventListener('click', async () => {
    if (!hostInput.value.trim() || !hostInput.checkValidity()) {
      hostInput.reportValidity();
      return;
    }
    save.disabled = true;
    save.textContent = 'Testing…';
    info.textContent = 'Saving connection and refreshing models…';
    const overrides = {
      model: params.model,
      contextWindow: params.contextWindow,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      repeatPenalty: params.repeatPenalty,
      reasoningEffort: params.reasoningEffort,
      jsonMode: params.jsonMode,
      contextMode: params.contextMode,
      host: hostInput.value.trim(),
      ...(isOmlx && keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
      ...(isOmlx && clearKey && clearKey.checked ? { clearApiKey: true } : {}),
    };
    try {
      const next = await api.applyLlmPreset({
        role: role === 'byom' ? 'byom' : 'global',
        presetId: preset.id,
        provider,
        overrides,
      });
      Object.assign(ctx.settings, next);
      await discoverProviderModels(ctx, role, provider, true, rebuild);
      const live = discoveryState(ctx, provider);
      toast(
        live.reachable === false
          ? 'Connection saved, but the model server is not reachable.'
          : 'Connection saved and models refreshed.',
        live.reachable === false ? 'err' : 'ok'
      );
    } catch (err) {
      info.textContent = err.message;
      info.style.color = 'var(--red)';
      toast(err.message, 'err');
      save.disabled = false;
      save.textContent = 'Save & test';
    }
  });

  const fields = [
    field('Server address', hostInput, meta.hint),
    isOmlx ? field('API key', keyInput, 'Optional. It is stored server-side and is never returned to this page.') : null,
  ];
  return el('div', { class: 'local-connection' }, [
    el('div', { class: 'local-connection-head' }, [
      el('div', {}, [
        el('strong', {}, `${PROVIDER_LABELS[provider]} connection`),
        el('span', { class: 'muted' }, ' Configure the server before tuning model parameters.'),
      ]),
      isOmlx ? el('a', {
        class: 'detail-link', href: 'https://github.com/jundot/omlx', target: '_blank', rel: 'noopener',
      }, 'oMLX setup ↗') : null,
    ]),
    el('div', { class: 'local-connection-grid' }, fields),
    clearKey ? el('label', { class: 'row local-key-clear' }, [clearKey, el('span', {}, 'Remove saved API key')]) : null,
    el('div', { class: 'local-endpoint' }, [
      el('span', {}, 'Model discovery'), endpoint,
    ]),
    el('div', { class: 'row local-connection-actions' }, [save, info]),
  ]);
}

function parameterEditor(ctx, role, preset, params, rebuild) {
  const contextInput = el('input', {
    type: 'number', min: '512', max: String(preset.limits.contextWindow), value: String(params.contextWindow),
    ...(preset.capabilities.contextWindowConfigurable ? {} : { disabled: 'disabled' }),
  });
  const outputInput = el('input', {
    type: 'number', min: preset.provider === 'lmstudio' || preset.provider === 'omlx' ? '256' : '128',
    max: String(preset.limits.maxOutputTokens), value: String(params.maxOutputTokens),
  });
  // Streaming toggle — only where the provider lets it vary (Claude). Codex's
  // Responses API and the local providers force streaming on regardless. Gate on
  // provider so it shows for both the catalog preset and the client-built custom
  // preset paths (streamingConfigurable is set on both, but provider is surest).
  const streamingConfigurable = preset.provider === 'claude' || (preset.capabilities && preset.capabilities.streamingConfigurable);
  const streamingInput = streamingConfigurable
    ? optionSelect([['on', 'On'], ['off', 'Off']], params.streaming === false ? 'off' : 'on')
    : null;
  const temperatureInput = preset.capabilities.temperature
    ? el('input', { type: 'number', min: '0', max: '2', step: '0.1', value: String(params.temperature ?? 0) })
    : el('input', { value: 'Provider managed', disabled: 'disabled' });
  const topPInput = preset.parameters.topP !== null
    ? el('input', { type: 'number', min: '0', max: '1', step: '0.05', value: String(params.topP ?? preset.parameters.topP) })
    : null;
  const topKInput = preset.parameters.topK !== null
    ? el('input', { type: 'number', min: '1', max: '1000', step: '1', value: String(params.topK ?? preset.parameters.topK) })
    : null;
  const repeatPenaltyInput = preset.parameters.repeatPenalty !== null
    ? el('input', { type: 'number', min: '0', max: '2', step: '0.01', value: String(params.repeatPenalty ?? preset.parameters.repeatPenalty) })
    : null;
  const jsonInput = preset.provider === 'ollama'
    ? optionSelect([['json', 'Constrained JSON'], ['text', 'Prompt-only text']], params.jsonMode)
    : preset.provider === 'lmstudio' || preset.provider === 'omlx'
      ? optionSelect([['text', 'Prompt-only text'], ['json_object', 'OpenAI json_object'], ['json_schema', 'Structured json_schema']], params.jsonMode)
      : null;
  const contextModeInput = preset.provider === 'lmstudio' || preset.provider === 'omlx'
    ? optionSelect([['summarize', 'Summarize old turns'], ['trim', 'Trim old turns'], ['none', 'None']], params.contextMode)
    : null;
  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });

  const syncLocalOutputLimit = () => {
    const fraction = preset.requestLimits && preset.requestLimits.maxOutputContextFraction;
    if (!Number.isFinite(fraction)) return;
    const minimum = preset.provider === 'lmstudio' || preset.provider === 'omlx' ? 256 : 128;
    const contextCap = Math.max(minimum, Math.floor(Number(contextInput.value) * fraction));
    const cap = Math.min(preset.limits.maxOutputTokens, contextCap);
    outputInput.max = String(cap);
    if (Number(outputInput.value) > cap) outputInput.value = String(cap);
  };
  contextInput.addEventListener('input', syncLocalOutputLimit);
  syncLocalOutputLimit();

  const save = async (reset = false) => {
    const numericInputs = [contextInput, outputInput, temperatureInput, topPInput, topKInput, repeatPenaltyInput]
      .filter((input) => input && !input.disabled);
    if (!reset && numericInputs.some((input) => input.value === '' || !input.checkValidity())) {
      const invalid = numericInputs.find((input) => input.value === '' || !input.checkValidity());
      if (invalid) invalid.reportValidity();
      toast('Check the highlighted parameter value.', 'err');
      return;
    }
    const overrides = reset ? undefined : {
      model: params.model,
      contextWindow: Number(contextInput.value),
      maxOutputTokens: Number(outputInput.value),
      temperature: preset.capabilities.temperature ? Number(temperatureInput.value) : null,
      topP: topPInput ? Number(topPInput.value) : null,
      topK: topKInput ? Number(topKInput.value) : null,
      repeatPenalty: repeatPenaltyInput ? Number(repeatPenaltyInput.value) : null,
      reasoningEffort: params.reasoningEffort,
      jsonMode: jsonInput ? jsonInput.value : null,
      contextMode: contextModeInput ? contextModeInput.value : null,
      ...(streamingInput ? { streaming: streamingInput.value !== 'off' } : {}),
    };
    info.textContent = 'Saving…';
    try {
      const next = await api.applyLlmPreset({
        role,
        presetId: preset.id,
        provider: preset.provider,
        overrides,
      });
      Object.assign(ctx.settings, next);
      toast(reset ? 'Recommended parameters restored.' : 'Custom LLM parameters saved.', 'ok');
      rebuild();
    } catch (err) {
      info.textContent = err.message;
      info.style.color = 'var(--red)';
      toast(err.message, 'err');
    }
  };

  const fields = [
    field('Context window', contextInput, preset.capabilities.contextWindowConfigurable
      ? preset.provider === 'lmstudio'
        ? 'Match the context used when loading the model in LM Studio.'
        : preset.provider === 'omlx'
          ? 'Keep this within the model context reported by oMLX.'
          : 'Maximum prompt and response context for this local model.'
      : 'Model capability; hosted providers do not change it per request.'),
    field('Max output tokens', outputInput,
      preset.provider === 'codex'
        ? 'Saved for API mode; the ChatGPT subscription backend manages this limit.'
        : preset.requestLimits && preset.requestLimits.maxOutputContextFraction === 0.5
          ? 'Capped at half the configured context so prompt and output fit together.'
          : preset.requestLimits && preset.requestLimits.maxOutputContextFraction === 1
            ? 'Cannot exceed the configured context window.'
            : null),
    streamingInput ? field('Streaming', streamingInput,
      'Keep on. Turning it off re-triggers the 10-minute request guard for large max output.') : null,
    field('Temperature', temperatureInput, preset.capabilities.temperature ? null : 'Omitted because this model/provider does not accept sampling overrides.'),
    topPInput ? field('Top P', topPInput) : null,
    topKInput ? field('Top K', topKInput) : null,
    repeatPenaltyInput ? field('Repeat penalty', repeatPenaltyInput) : null,
    jsonInput ? field('JSON output mode', jsonInput) : null,
    contextModeInput ? field('Context overflow', contextModeInput) : null,
  ];

  return el('details', { class: 'preset-customize' }, [
    el('summary', {}, 'Customize parameters'),
    el('div', { class: 'preset-customize-body' }, [
      el('div', { class: 'preset-param-grid' }, fields),
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', onclick: () => save(false) }, 'Save customization'),
        preset.id !== 'custom' ? el('button', { onclick: () => save(true) }, 'Reset to recommended') : null,
      ]),
      info,
    ]),
  ]);
}

function hostedConnection(ctx, provider) {
  return provider === 'codex' ? codexConnection(ctx) : claudeConnection(ctx);
}

function codexConnection(ctx) {
  const c = ctx.codex || { connected: false };
  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });
  const status = c.connected
    ? `Connected${c.credentialSource ? ` · ${c.credentialSource}` : ''}`
    : 'Not connected. An organization admin must import Codex credentials with `adlc admin codex import`.';
  // Browser OAuth and browser deletion were removed. Import/delete are direct,
  // IAM-gated operator actions against the settings service.
  const buttons = [];
  if (c.connected) {
    buttons.push(
      el('button', { onclick: async () => {
        info.textContent = 'Testing…';
        try { const r = await api.testCodex(); info.textContent = `Connection OK · ${r.model || c.model}`; info.style.color = 'var(--green)'; }
        catch (err) { info.textContent = err.message; info.style.color = 'var(--red)'; }
      } }, 'Test connection')
    );
  }
  return el('div', { class: 'preset-connection' }, [
    el('div', { class: `preset-status ${c.connected ? 'ok' : 'warn'}` }, status),
    el('div', { class: 'row' }, buttons),
    info,
  ]);
}

function claudeConnection(ctx) {
  const c = ctx.claude || { connected: false };
  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });
  const codeInput = el('input', { placeholder: 'Paste code#state from Anthropic', style: 'flex:1;min-width:200px' });
  const status = c.connected
    ? `Connected · token ${c.maskedToken || '••••'}${c.expiresAt ? ` · expires ${new Date(c.expiresAt).toLocaleString()}` : ''}`
    : 'Not connected. Sign in to use this hosted preset.';
  const signIn = el('button', { class: 'primary', onclick: async () => {
    const popup = window.open('about:blank', '_blank');
    if (!popup) return toast('Popup blocked. Allow popups for this app and try again.', 'err');
    popup.opener = null;
    try {
      const { authorizeUrl } = await api.startClaudeLogin();
      popup.location.href = authorizeUrl;
      info.textContent = 'Approve in the opened tab, then paste the returned code below.';
    } catch (err) { popup.close(); toast(err.message, 'err'); }
  } }, c.connected ? 'Re-authenticate' : 'Sign in with Claude');
  const buttons = [signIn];
  if (c.connected) {
    buttons.push(
      el('button', { onclick: async () => {
        info.textContent = 'Testing…';
        try { const r = await api.testClaude(); info.textContent = `Connection OK · ${r.model}`; info.style.color = 'var(--green)'; }
        catch (err) { info.textContent = err.message; info.style.color = 'var(--red)'; }
      } }, 'Test connection'),
      el('button', { class: 'danger', onclick: async () => {
        try { await api.logoutClaude(); toast('Signed out of Claude.'); renderSettings(clear(ctx.view)); }
        catch (err) { toast(err.message, 'err'); }
      } }, 'Sign out')
    );
  }
  return el('div', { class: 'preset-connection' }, [
    el('div', { class: `preset-status ${c.connected ? 'ok' : 'warn'}` }, status),
    el('div', { class: 'row' }, buttons),
    el('div', { class: 'row claude-code-row' }, [
      codeInput,
      el('button', { onclick: async () => {
        if (!codeInput.value.trim()) return toast('Paste the code first.', 'err');
        info.textContent = 'Completing sign-in…';
        try { await api.exchangeClaude(codeInput.value.trim()); toast('Signed in to Claude.', 'ok'); renderSettings(clear(ctx.view)); }
        catch (err) { info.textContent = err.message; info.style.color = 'var(--red)'; }
      } }, 'Complete sign-in'),
    ]),
    info,
  ]);
}

// Hosted provider configured with an API token (not OAuth): router base URL,
// an arbitrary model id, and a Hugging Face access token. The token is stored
// server-side (masked here) and cleared via the checkbox.
function huggingfaceConnection(ctx, role, preset, params, rebuild) {
  const s = ctx.settings;
  const hostInput = el('input', {
    type: 'url', value: s.huggingfaceHost || 'https://router.huggingface.co',
    placeholder: 'https://router.huggingface.co', autocomplete: 'url', spellcheck: 'false',
  });
  const modelInput = el('input', {
    type: 'text', value: params.model || '',
    placeholder: 'meta-llama/Llama-3.3-70B-Instruct', spellcheck: 'false',
  });
  const keyInput = pwd(s.hasHuggingfaceApiKey ? `Saved: ${s.maskedHuggingfaceApiKey}` : 'hf_… access token');
  const clearKey = s.hasHuggingfaceApiKey ? el('input', { type: 'checkbox', style: 'width:auto' }) : null;
  if (clearKey) {
    clearKey.addEventListener('change', () => {
      keyInput.disabled = clearKey.checked;
      if (clearKey.checked) keyInput.value = '';
    });
  }
  const info = el('div', { class: 'muted preset-save-info', role: 'status', 'aria-live': 'polite' });
  const save = el('button', { class: 'primary', type: 'button' }, 'Save connection');
  save.addEventListener('click', async () => {
    const model = modelInput.value.trim();
    if (!model) {
      info.textContent = 'Enter a model id (e.g. meta-llama/Llama-3.3-70B-Instruct).';
      info.style.color = 'var(--red)';
      return;
    }
    if (!s.hasHuggingfaceApiKey && !keyInput.value.trim()) {
      info.textContent = 'A Hugging Face access token is required.';
      info.style.color = 'var(--red)';
      return;
    }
    save.disabled = true;
    save.textContent = 'Saving…';
    info.style.color = '';
    info.textContent = 'Saving Hugging Face connection…';
    const matched = findPresetForModel(ctx, 'huggingface', model);
    const overrides = {
      model,
      contextWindow: params.contextWindow,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      reasoningEffort: params.reasoningEffort,
      host: hostInput.value.trim(),
      ...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
      ...(clearKey && clearKey.checked ? { clearApiKey: true } : {}),
    };
    try {
      const next = await api.applyLlmPreset({
        role,
        presetId: matched ? matched.id : 'custom',
        provider: 'huggingface',
        overrides,
      });
      Object.assign(ctx.settings, next);
      toast('Hugging Face connection saved.', 'ok');
      rebuild();
    } catch (err) {
      info.textContent = err.message;
      info.style.color = 'var(--red)';
      toast(err.message, 'err');
      save.disabled = false;
      save.textContent = 'Save connection';
    }
  });
  return el('div', { class: 'local-connection' }, [
    el('div', { class: 'local-connection-head' }, [
      el('div', {}, [
        el('strong', {}, 'Hugging Face connection'),
        el('span', { class: 'muted' }, ' Router base URL, model, and access token.'),
      ]),
      el('a', { class: 'detail-link', href: 'https://huggingface.co/settings/tokens', target: '_blank', rel: 'noopener' }, 'Create a token ↗'),
    ]),
    el('div', { class: 'local-connection-grid' }, [
      field('Router base URL', hostInput, 'Default is the Hugging Face router. Change only for a custom or proxied endpoint.'),
      field('Model', modelInput, 'Any model routable via HF Inference Providers, e.g. meta-llama/Llama-3.3-70B-Instruct.'),
      field('Access token', keyInput, 'Stored server-side and never returned to this page. Required.'),
    ]),
    clearKey ? el('label', { class: 'row local-key-clear' }, [clearKey, el('span', {}, 'Remove saved token')]) : null,
    el('div', { class: 'row local-connection-actions' }, [save, info]),
  ]);
}

/* ------------------------------- Role ----------------------------------- */

function roleSection({ members, assumedRole, view }) {
  const select = el(
    'select',
    {},
    [el('option', { value: '' }, '— select a member —')].concat(
      members.map((m) => el('option', { value: m.id, selected: assumedRole && assumedRole.id === m.id, dataset: { userContent: 'true' } }, `${m.name} (${m.email})`))
    )
  );

  const notify = () => window.dispatchEvent(new Event('lm:role-changed'));

  const assumeBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      if (!select.value) return toast('Pick a member first.', 'err');
      try {
        await api.assumeRole(select.value);
        toast('Role assumed.', 'ok');
        notify();
        renderSettings(clear(view));
      } catch (err) {
        toast(err.message, 'err');
      }
    },
  }, 'Assume role');

  const clearBtn = el('button', {
    onclick: async () => {
      await api.clearRole();
      toast('Role cleared.');
      notify();
      renderSettings(clear(view));
    },
  }, 'Clear');

  return section('Assume Role', assumedRole ? `Acting as ${assumedRole.name}` : 'No role assumed', Boolean(!assumedRole), [
    el('p', { class: 'muted', style: 'font-size:13px;margin-top:0' }, 'Act as a workspace member. Enrichment claims open projects for the assumed role, which also shows in the top toolbar.'),
    assumedRole
      ? el('div', { class: 'row', style: 'margin-bottom:12px' }, [
          el('span', { class: 'avatar' }, (assumedRole.name || '?').slice(0, 2).toUpperCase()),
          el('div', { dataset: { userContent: 'true' } }, [el('div', { style: 'font-weight:600' }, assumedRole.name), el('div', { class: 'muted', style: 'font-size:12px' }, assumedRole.email || '')]),
        ])
      : null,
    field('Member', select),
    el('div', { class: 'row' }, [assumeBtn, assumedRole ? clearBtn : null]),
  ]);
}

/* --------------------------- Multi-label dropdown ----------------------- */

function labelDropdown(available, selected) {
  const sel = new Set(selected);
  // Include any already-selected labels that aren't in the fetched list.
  const options = [...new Set([...available, ...selected])].sort((a, b) => a.localeCompare(b));

  const panelId = `settings-labels-${++fieldSequence}`;
  const trigger = el('button', {
    type: 'button', class: 'ms-trigger', 'aria-haspopup': 'true',
    'aria-expanded': 'false', 'aria-controls': panelId, dataset: { userContent: 'true' },
  }, '');
  const panel = el('div', { class: 'ms-panel', id: panelId, hidden: true, role: 'group', 'aria-label': 'Project labels' });
  const wrap = el('div', { class: 'ms' }, [trigger, panel]);

  const refresh = () => {
    trigger.textContent = sel.size ? [...sel].join(', ') : 'Any label (all open projects)';
  };

  if (!options.length) {
    panel.append(el('div', { class: 'muted', style: 'padding:8px' }, 'No project labels found in Linear.'));
  }
  for (const name of options) {
    const cb = el('input', { type: 'checkbox', style: 'width:auto', ...(sel.has(name) ? { checked: 'checked' } : {}) });
    cb.addEventListener('change', () => {
      if (cb.checked) sel.add(name);
      else sel.delete(name);
      refresh();
    });
    panel.append(el('label', { class: 'ms-item', dataset: { userContent: 'true' } }, [cb, el('span', {}, name)]));
  }

  const setOpen = (open) => {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };
  trigger.addEventListener('click', () => {
    setOpen(panel.hidden);
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      trigger.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (wrap.isConnected && !wrap.contains(e.target)) setOpen(false);
  });

  refresh();
  return { element: wrap, get: () => [...sel] };
}

/* ---------------------------- Deep Agent config ------------------------- */

function agentSection({ config, intervals, labels, view }) {
  const inputs = {};
  const num = (key, label, min, max) => {
    const input = el('input', { type: 'number', min: String(min), max: String(max), value: String(config[key]) });
    inputs[key] = () => Number(input.value);
    return field(label, input);
  };
  const toggle = (key, label) => {
    const input = el('input', { type: 'checkbox', style: 'width:auto', ...(config[key] ? { checked: 'checked' } : {}) });
    inputs[key] = () => input.checked;
    return el('label', { class: 'row', style: 'gap:8px;cursor:pointer;margin-bottom:8px' }, [input, el('span', {}, label)]);
  };

  const intervalSelect = el(
    'select',
    {},
    intervals.map((m) => el('option', { value: String(m), selected: Number(m) === Number(config.intervalMinutes) }, `${m} minutes`))
  );
  const labelsCtl = labelDropdown(labels, config.enrichLabels || []);

  const saveBtn = el('button', { class: 'primary' }, 'Save agent config');
  saveBtn.addEventListener('click', async () => {
    const payload = {
      enrichLabels: labelsCtl.get(),
      intervalMinutes: Number(intervalSelect.value),
      parallelProcessing: inputs.parallelProcessing(),
      maxConcurrentCoders: inputs.maxConcurrentCoders(),
      maxProjectsPerRun: inputs.maxProjectsPerRun(),
      maxMilestones: inputs.maxMilestones(),
      maxIssuesPerMilestone: inputs.maxIssuesPerMilestone(),
      scheduleEnabled: inputs.scheduleEnabled(),
      autoAssignLead: inputs.autoAssignLead(),
      autoLabelNewProjects: inputs.autoLabelNewProjects(),
      createIssues: inputs.createIssues(),
      addDependencies: inputs.addDependencies(),
    };
    try {
      await api.saveAgentConfig(payload);
      toast('Agent config saved.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  return section('Deep Agent', 'Labels, schedule & limits', false, [
    field('Enrich projects with labels', labelsCtl.element, 'Open (no-lead) projects carrying ANY selected label are auto-enriched. Select none to enrich all open projects.'),
    el('div', { class: 'grid settings-agent-grid' }, [
      field('Run scheduler every', intervalSelect),
      num('parallelProcessing', 'Parallel processing', 1, 8),
      num('maxConcurrentCoders', 'Max concurrent coders', 1, 8),
      num('maxProjectsPerRun', 'Max projects / run', 1, 20),
      num('maxMilestones', 'Max milestones', 1, 12),
      num('maxIssuesPerMilestone', 'Max issues / milestone', 0, 12),
    ]),
    el('div', { style: 'margin:6px 0 12px' }, [
      toggle('scheduleEnabled', 'Run scheduler'),
      toggle('autoAssignLead', 'Assign assumed role as project lead'),
      toggle('autoLabelNewProjects', 'Auto-attach enrich labels to new projects'),
      toggle('createIssues', 'Create issues per milestone'),
      toggle('addDependencies', 'Add issue dependencies (LLM)'),
    ]),
    saveBtn,
  ]);
}
