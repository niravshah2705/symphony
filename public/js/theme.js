// Theme control: light / dark / system, persisted in localStorage and applied as
// a `data-theme` attribute on <html>. The no-flash bootstrap in index.html applies
// the saved theme before first paint; this module keeps it in sync and renders the
// header toggle. `system` follows the OS preference live via matchMedia.

import { el } from './dom.js';

const KEY = 'lm:theme';
const PREFS = ['system', 'light', 'dark'];

// 16px inline SVGs (stroke = currentColor) so icons inherit the header text color.
const ICONS = {
  sun: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
  system: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
};

const OPTIONS = [
  { pref: 'system', icon: 'system', label: 'System' },
  { pref: 'light', icon: 'sun', label: 'Light' },
  { pref: 'dark', icon: 'moon', label: 'Dark' },
];

const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function savedPref() {
  const v = localStorage.getItem(KEY);
  return PREFS.includes(v) ? v : 'system';
}

/** Resolve a preference to the concrete theme actually applied. */
function resolve(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return media && media.matches ? 'dark' : 'light';
}

/** Apply the given preference to <html> and persist it. */
function apply(pref) {
  document.documentElement.setAttribute('data-theme', resolve(pref));
  try {
    localStorage.setItem(KEY, pref);
  } catch (e) {
    /* localStorage may be unavailable; theme still applies for this session. */
  }
}

/** Build the header theme toggle (icon button + popup menu) into `container`. */
export function initThemeToggle(container) {
  if (!container) return;
  container.replaceChildren();

  const btn = el('button', { class: 'theme-btn', type: 'button', 'aria-label': 'Theme', title: 'Theme' });
  const menu = el('div', { class: 'theme-menu', hidden: true });
  const optionEls = new Map();

  const syncIcons = () => {
    const pref = savedPref();
    // The button shows the icon of the theme currently in effect.
    btn.innerHTML = ICONS[resolve(pref) === 'dark' ? 'moon' : 'sun'];
    for (const [pref2, node] of optionEls) node.classList.toggle('active', pref2 === pref);
  };

  for (const opt of OPTIONS) {
    const item = el('button', { class: 'theme-item', type: 'button' }, [
      el('span', { class: 'theme-item-icon', html: ICONS[opt.icon] }),
      el('span', {}, opt.label),
    ]);
    item.addEventListener('click', () => {
      apply(opt.pref);
      menu.hidden = true;
      syncIcons();
    });
    optionEls.set(opt.pref, item);
    menu.append(item);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (container.isConnected && !container.contains(e.target)) menu.hidden = true;
  });

  // When the OS theme changes and the user is on "system", re-resolve live.
  if (media) {
    const onChange = () => {
      if (savedPref() === 'system') {
        apply('system');
        syncIcons();
      }
    };
    media.addEventListener ? media.addEventListener('change', onChange) : media.addListener(onChange);
  }

  container.append(btn, menu);
  syncIcons();
}
