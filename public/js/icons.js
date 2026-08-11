// Shared, dependency-free line icons for the application shell and immersive views.
// All markup is defined locally; callers only select a known icon name.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = Object.freeze({
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  spark: '<path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3ZM5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15Z"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  microphone: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
  graph: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="9" cy="18" r="2"/><path d="m8 7 8 1M7 8l2 8M17 10l-6 6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="m5.6 5.6 4.3 4.3M14.1 14.1l4.3 4.3M18.4 5.6l-4.3 4.3M9.9 14.1l-4.3 4.3"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2"/>',
  folder: '<path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
  file: '<path d="M6 2h8l4 4v16H6V2Z"/><path d="M14 2v5h5M9 12h6M9 16h6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
  code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M14 4l-4 16"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
});

// Filled brand/marker glyphs for provider / harness / tool pickers. These are
// simple original geometric marks (NOT the vendors' trademarked logos), defined
// locally so nothing is ever fetched from a remote host (CSP-safe). `currentColor`
// fill lets them inherit the surrounding text color in light and dark themes.
const BRAND_ICON_PATHS = Object.freeze({
  // Providers
  anthropic: '<path d="M14.4 3h-4L3.5 21h4l1.3-3.6h6.4L16.5 21h4L14.4 3Zm-4.2 11 1.8-5.1L13.8 14h-3.6Z"/>',
  openai: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.5A5.5 5.5 0 1 1 6.5 12 5.5 5.5 0 0 1 12 6.5Zm0 2.6A2.9 2.9 0 1 0 14.9 12 2.9 2.9 0 0 0 12 9.1Z"/>',
  gemini: '<path d="M12 2c.6 4.9 4.5 8.8 9.4 9.4C16.5 12 12.6 15.9 12 20.8 11.4 15.9 7.5 12 2.6 11.4 7.5 10.8 11.4 6.9 12 2Z"/>',
  huggingface: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM8.7 9.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Zm6.6 0a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8ZM8 14.4h8a4 4 0 0 1-8 0Z"/>',
  byom: '<rect x="4" y="4" width="16" height="4.5" rx="1"/><rect x="4" y="9.8" width="16" height="4.5" rx="1"/><rect x="4" y="15.6" width="16" height="4.5" rx="1"/>',
  // Harnesses
  deepagent: '<path d="M12 2 14 9 21 11 14 13 12 20 10 13 3 11 10 9 12 2Z"/>',
  // Project management
  linear: '<path d="M3.2 13.8 10.2 20.8A9 9 0 0 1 3.2 13.8ZM3.6 9.9 14.1 20.4A9 9 0 0 1 11.6 21L3 12.4A9 9 0 0 1 3.6 9.9ZM5.7 6 18 18.3A9 9 0 0 1 16 20L4 8A9 9 0 0 1 5.7 6ZM9.3 3.6A9 9 0 0 1 20.4 14.7Z"/>',
  jira: '<path d="M12 2 3.5 10.8h4.2L12 6.3l4.3 4.5h4.2L12 2Zm0 20 8.5-8.8h-4.2L12 17.7l-4.3-4.5H3.5L12 22Z"/>',
  // Observability
  langsmith: '<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="9" r="2.2"/><circle cx="9.5" cy="18" r="2.2"/><path d="M7.6 8.2 16 8.9M8 9.3l1.2 6.6M16.2 10.8l-5.4 5.6" stroke="currentColor" stroke-width="1.6" fill="none"/>',
});

export const iconNames = Object.freeze(Object.keys(ICON_PATHS));
export const brandIconNames = Object.freeze(Object.keys(BRAND_ICON_PATHS));

/** Build a consistent SVG icon node. Unknown names fall back to `info`. */
export function icon(name, { className = 'icon', label = '', size = null } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICON_PATHS[name] || ICON_PATHS.info;

  if (size !== null) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }

  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }

  return svg;
}

/**
 * Build a filled brand/marker glyph (see BRAND_ICON_PATHS). Unknown names fall
 * back to the neutral `byom` mark. Markup is local and trusted — never derived
 * from user input.
 */
export function brandIcon(name, { className = 'brand-icon', label = '', size = 20 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.innerHTML = BRAND_ICON_PATHS[name] || BRAND_ICON_PATHS.byom;
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  return svg;
}

/** Replace data-icon placeholders with SVGs while retaining their wrapper. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((host) => {
    const name = host.dataset.icon;
    const label = host.dataset.iconLabel || '';
    host.replaceChildren(icon(name, { label }));
    if (!label) host.setAttribute('aria-hidden', 'true');
  });
}
