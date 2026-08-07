import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';

// The four settings domains, in display order (mirrors services/settings
// app/models/policy.py DOMAINS and packages/shared/src/agent/settings-policy.js).
const DOMAINS = ['harness', 'tools', 'skills', 'plugins'];
const DOMAIN_LABELS = {
  harness: 'Harness (agent runtimes)',
  tools: 'Tools (developer-tool registry)',
  skills: 'Skills (workflow skills)',
  plugins: 'Plugins',
};

function banner(message) {
  return el('div', { class: 'error-banner' }, message || 'Something went wrong.');
}

function pageHead() {
  return el('div', { class: 'page-head' }, [
    el('h1', {}, 'Settings Policy'),
    el(
      'p',
      { class: 'muted' },
      'Include/exclude harness, tools, skills and plugins per scope. Lower scopes only narrow — an exclude higher up always wins.'
    ),
  ]);
}

function parseList(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatList(values) {
  return (values || []).join('\n');
}

/** Read the four domain editors back into a PolicyUpdate body. */
function collectDomains(editors) {
  const domains = {};
  for (const domain of DOMAINS) {
    const { include, exclude } = editors[domain];
    domains[domain] = { include: parseList(include.value), exclude: parseList(exclude.value) };
  }
  return { domains };
}

/** One domain block: a universe hint + include/exclude textareas. */
function domainEditor(domain, policy, universe, editors) {
  const dp = (policy && policy.domains && policy.domains[domain]) || { include: [], exclude: [] };
  const items = (universe && universe[domain]) || [];

  const include = el('textarea', {
    class: 'policy-input',
    rows: '2',
    placeholder: 'Empty = all. ids or globs, one per line (e.g. security:*)',
  });
  include.value = formatList(dp.include);
  const exclude = el('textarea', { class: 'policy-input', rows: '2', placeholder: 'ids or globs to block' });
  exclude.value = formatList(dp.exclude);

  editors[domain] = { include, exclude };

  return el('fieldset', { class: 'policy-domain' }, [
    el('legend', {}, DOMAIN_LABELS[domain] || domain),
    el('div', { class: 'policy-universe muted' }, [
      el('span', {}, 'Available: '),
      ...(items.length ? items.map((id) => el('code', { class: 'policy-chip' }, id)) : [el('em', {}, 'none')]),
    ]),
    el('label', {}, ['Include', include]),
    el('label', {}, ['Exclude', exclude]),
  ]);
}

// Allow-listed config value (provider secret) keys — mirror of the settings
// service CONFIG_VALUE_KEYS. Write-only from the browser (masked on read).
const CONFIG_VALUE_KEYS = ['geminiApiKey'];
const CONFIG_VALUE_LABELS = { geminiApiKey: 'Gemini API key (Antigravity harness)' };

/**
 * Write-only provider-key editor for one scope. The policy response only tells
 * us whether each key is `set` (never the secret), so we show a status and take
 * a new plaintext value to store — or an empty value to clear. `saveConfig`
 * persists `{ [key]: value }` alone (domains untouched).
 */
function providerKeysEditor(policy, saveConfig) {
  const values = (policy && policy.values) || {};
  const fieldset = el('fieldset', { class: 'policy-domain' }, [
    el('legend', {}, 'Provider keys (write-only)'),
    el('p', { class: 'muted' }, 'Stored server-side and never shown again. Lower scopes override higher ones.'),
  ]);
  for (const key of CONFIG_VALUE_KEYS) {
    const isSet = Boolean(values[key] && values[key].set);
    const status = el('span', { class: 'muted' }, isSet ? 'Configured' : 'Not set');
    const input = el('input', {
      type: 'password',
      class: 'policy-input',
      autocomplete: 'off',
      placeholder: isSet ? 'Configured — enter a new value to replace' : 'Not set — paste a key to configure',
    });
    const saveKeyBtn = el('button', { type: 'button', class: 'btn' }, 'Save key');
    const clearBtn = el('button', { type: 'button', class: 'btn' }, 'Clear');
    const persist = async (value, okMessage, newStatus, button) => {
      button.disabled = true;
      try {
        await saveConfig({ [key]: value });
        input.value = '';
        status.textContent = newStatus;
        toast(okMessage);
      } catch (err) {
        toast(err.message || 'Could not update key.', 'error');
      } finally {
        button.disabled = false;
      }
    };
    saveKeyBtn.addEventListener('click', () => {
      const value = input.value.trim();
      if (!value) {
        toast('Enter a key value to save.', 'error');
        return;
      }
      persist(value, 'Key saved.', 'Configured', saveKeyBtn);
    });
    clearBtn.addEventListener('click', () => persist('', 'Key cleared.', 'Not set', clearBtn));
    fieldset.append(
      el('label', {}, [CONFIG_VALUE_LABELS[key] || key, ' — ', status, input]),
      el('div', { class: 'policy-controls' }, [saveKeyBtn, clearBtn])
    );
  }
  return fieldset;
}

/**
 * A per-scope editing card. `load()` returns a policy (or throws), `save(body)`
 * persists the include/exclude domains, and (optional) `saveConfig(values)`
 * persists provider keys. `enabled` false renders a disabled explanation.
 */
async function scopeCard(section, { title, hint, load, save, saveConfig, universe, enabled, disabledReason }) {
  clear(section).append(el('h2', {}, title), hint ? el('p', { class: 'muted' }, hint) : null);
  if (!enabled) {
    section.append(el('p', { class: 'muted' }, disabledReason || 'Not available for your role.'));
    return;
  }

  let policy;
  try {
    policy = await load();
  } catch (err) {
    section.append(banner(err.message));
    return;
  }

  const editors = {};
  const form = el('form', { class: 'policy-form' });
  for (const domain of DOMAINS) form.append(domainEditor(domain, policy, universe, editors));

  const saveBtn = el('button', { type: 'submit', class: 'btn' }, 'Save policy');
  form.append(saveBtn);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    saveBtn.disabled = true;
    try {
      await save(collectDomains(editors));
      toast('Policy saved.');
    } catch (err) {
      toast(err.message || 'Could not save policy.', 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });
  section.append(form);
  if (saveConfig) section.append(providerKeysEditor(policy, saveConfig));
}

/** The resolved effective set for the caller (org → project → user cascade). */
async function effectiveCard(section, projectId) {
  clear(section).append(el('h2', {}, 'Effective policy'), el('p', { class: 'muted' }, 'What you are actually granted after the cascade.'));

  let data;
  try {
    data = await api.settingsPolicy.getEffective(projectId || undefined);
  } catch (err) {
    section.append(banner(err.message));
    return;
  }

  for (const domain of DOMAINS) {
    const res = (data.domains && data.domains[domain]) || { effective: [] };
    section.append(
      el('div', { class: 'policy-effective' }, [
        el('strong', {}, DOMAIN_LABELS[domain] || domain),
        el(
          'div',
          { class: 'policy-chips' },
          res.effective.length
            ? res.effective.map((id) => el('code', { class: 'policy-chip ok' }, id))
            : [el('em', { class: 'muted' }, 'nothing allowed')]
        ),
      ])
    );
  }

  // Effective provider keys (masked — presence only, never the secret).
  const values = data.values || {};
  section.append(
    el('div', { class: 'policy-effective' }, [
      el('strong', {}, 'Provider keys'),
      el(
        'div',
        { class: 'policy-chips' },
        CONFIG_VALUE_KEYS.map((key) =>
          el(
            'code',
            { class: `policy-chip ${values[key] && values[key].set ? 'ok' : ''}` },
            `${CONFIG_VALUE_LABELS[key] || key}: ${values[key] && values[key].set ? 'set' : 'not set'}`
          )
        )
      ),
    ])
  );
}

export async function renderSettingsPolicy(view) {
  clear(view).append(loading('Loading settings policy…'));

  let universe;
  try {
    universe = (await api.settingsPolicy.getUniverse()).domains;
  } catch (err) {
    clear(view).append(pageHead(), banner(err.message || 'Sign in to manage settings policy.'));
    return;
  }

  // The org role decides which tenant scopes are editable. Degrade gracefully if
  // the org service is unavailable — the user + effective surfaces still work.
  let me = null;
  try {
    me = await api.org.getMe();
  } catch (_) {
    me = null;
  }
  const isOrgAdmin = Boolean(me && me.org_role === 'ORG_ADMIN');
  const hasOrg = Boolean(me && me.has_organization);

  const userSection = el('section', { class: 'org-block' });
  const orgSection = el('section', { class: 'org-block' });
  const projectSection = el('section', { class: 'org-block' });
  const effectiveSection = el('section', { class: 'org-block' });

  // Project scope: an id input drives which project's policy loads/saves.
  const projectInput = el('input', { class: 'policy-input', placeholder: 'Project ID (UUID)' });
  const projectControls = el('div', { class: 'policy-controls' }, [
    el('label', {}, ['Project', projectInput]),
    el(
      'button',
      {
        class: 'btn',
        onClick: () => {
          const id = projectInput.value.trim();
          if (!id) {
            toast('Enter a project ID.', 'error');
            return;
          }
          renderProjectScope(id);
          effectiveCard(effectiveSection, id);
        },
      },
      'Load project'
    ),
  ]);

  const renderProjectScope = (projectId) =>
    scopeCard(projectSection, {
      title: 'Project scope',
      hint: 'Narrows the org policy for one project (project admins / org admins).',
      universe,
      enabled: Boolean(projectId),
      disabledReason: 'Enter a project ID above to load its policy.',
      load: () => api.settingsPolicy.getProjectPolicy(projectId),
      save: (body) => api.settingsPolicy.setProjectPolicy(projectId, body),
      saveConfig: (values) => api.settingsPolicy.setProjectConfig(projectId, values),
    });

  clear(view).append(
    pageHead(),
    userSection,
    orgSection,
    hasOrg ? el('section', { class: 'org-block' }, [el('h2', {}, 'Project scope'), projectControls]) : null,
    hasOrg ? projectSection : null,
    effectiveSection
  );

  await Promise.all([
    scopeCard(userSection, {
      title: 'My settings (user scope)',
      hint: 'Your personal narrowing — applied last, on top of org and project.',
      universe,
      enabled: true,
      load: () => api.settingsPolicy.getMyPolicy(),
      save: (body) => api.settingsPolicy.setMyPolicy(body),
      saveConfig: (values) => api.settingsPolicy.setMyConfig(values),
    }),
    scopeCard(orgSection, {
      title: 'Organization scope',
      hint: 'Applies to everyone in the org. An exclude here blocks project and user.',
      universe,
      enabled: isOrgAdmin,
      disabledReason: 'Organization admins only.',
      load: () => api.settingsPolicy.getOrgPolicy(),
      save: (body) => api.settingsPolicy.setOrgPolicy(body),
      saveConfig: (values) => api.settingsPolicy.setOrgConfig(values),
    }),
    effectiveCard(effectiveSection),
  ]);
}
