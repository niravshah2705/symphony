// Router + shell wiring. Hash-based navigation between the four views.

import { api } from './api.js';
import { state } from './state.js';
import { el, clear } from './dom.js';
import { renderProjects } from './views/projects.js';
import { renderBoard } from './views/board.js';
import { renderBusiness } from './views/business.js';
import { renderAgent } from './views/agent.js';
import { renderSettings } from './views/settings.js';
import { initThemeToggle } from './theme.js';

const routes = {
  projects: renderProjects,
  board: renderBoard,
  business: renderBusiness,
  agent: renderAgent,
  settings: renderSettings,
};

function currentRoute() {
  const hash = window.location.hash.replace(/^#\//, '');
  const [name] = hash.split('/');
  return routes[name] ? name : 'business';
}

function setActiveTab(name) {
  document.querySelectorAll('#tabs a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === name);
  });
}

async function refreshConnection() {
  const conn = document.getElementById('conn');
  const text = document.getElementById('conn-text');
  try {
    const settings = await api.getSettings();
    state.hasKey = settings.hasKey;
    if (!settings.hasKey) {
      conn.className = 'conn';
      text.textContent = 'No API key';
      return;
    }
    await api.validate();
    conn.className = 'conn ok';
    text.textContent = 'Connected';
  } catch (err) {
    conn.className = 'conn bad';
    text.textContent = 'Not connected';
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

async function render() {
  const name = currentRoute();
  setActiveTab(name);
  const view = clear(document.getElementById('view'));

  // Nudge users to Settings before anything can load.
  if (!state.hasKey && name !== 'settings') {
    view.append(
      el('div', { class: 'empty' }, [
        el('h2', {}, 'Connect to Linear'),
        el('p', { class: 'muted' }, 'Add your Linear API key in Settings to load projects and issues.'),
        el('a', { class: 'btn primary', href: '#/settings' }, 'Open Settings'),
      ])
    );
    return;
  }

  try {
    await routes[name](view);
  } catch (err) {
    view.append(el('div', { class: 'error-banner' }, err.message || 'Failed to load view.'));
  }
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', async () => {
  initThemeToggle(document.getElementById('theme-toggle'));
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
