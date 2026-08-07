// Client-side view of the authorization model. This ONLY hides menu items and
// gates views for UX — the gateway independently enforces the same rules on
// every /api route (services/gateway/src/auth.js requirePermission), so a
// hidden item is never a security control. Keep the domains/levels in sync with
// packages/shared/src/authz.js.

// Each route → the permission its view needs to be usable. `read` = viewable;
// `write` = the view performs actions (so read-only roles don't see it).
export const MENU_PERMISSIONS = Object.freeze({
  agent: { domain: 'workspace', level: 'read' },
  'agent-jobs': { domain: 'workspace', level: 'read' },
  calls: { domain: 'workspace', level: 'write' },
  traces: { domain: 'workspace', level: 'write' },
  business: { domain: 'planning', level: 'read' },
  projects: { domain: 'planning', level: 'read' },
  board: { domain: 'planning', level: 'read' },
  analytics: { domain: 'insights', level: 'read' },
  workflows: { domain: 'insights', level: 'read' },
  troubleshooting: { domain: 'insights', level: 'read' },
  settings: { domain: 'settings', level: 'write' },
});

// Where an unauthenticated visitor (or a signed-out session) lands.
export const DEFAULT_PUBLIC_ROUTE = 'agent';

const LEVEL_RANK = { read: 1, write: 2 };

export function permitted(permissions, domain, level) {
  const have = permissions && permissions[domain];
  if (!have) return false;
  return (LEVEL_RANK[have] || 0) >= (LEVEL_RANK[level] || 0);
}

export function canAccessRoute(permissions, route) {
  const need = MENU_PERMISSIONS[route];
  if (!need) return true; // routes without an entry are not permission-gated
  return permitted(permissions, need.domain, need.level);
}
