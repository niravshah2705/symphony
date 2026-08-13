// Client-side view of the authorization model. This ONLY hides menu items and
// gates views for UX — the gateway independently enforces the same rules on
// every /api route (services/gateway/src/auth.js requirePermission), so a
// hidden item is never a security control. Keep the domains/levels in sync with
// packages/shared/src/authz.js.

// Each route → the permission its view needs to be usable. `read` = viewable;
// `write` = the view performs actions (so read-only roles don't see it).
export const MENU_PERMISSIONS = Object.freeze({
  agent: { domain: 'workspace', level: 'read' },
  workflows: { domain: 'org', level: 'read' },
  'agent-jobs': { domain: 'workspace', level: 'read' },
  calls: { domain: 'workspace', level: 'write' },
  business: { domain: 'planning', level: 'read' },
  projects: { domain: 'planning', level: 'read' },
  board: { domain: 'planning', level: 'read' },
  analytics: { domain: 'insights', level: 'read' },
  cost: { domain: 'insights', level: 'read' },
  troubleshooting: { domain: 'insights', level: 'read' },
  // Signed-in viewers already have settings:read. The view renders a scoped
  // policy-only surface for them, so selected ORG_ADMIN/PROJECT_ADMIN roles can
  // administer their active context without requiring a global Firebase admin
  // claim. Global operational controls remain settings:write-only.
  settings: { domain: 'settings', level: 'read' },
  // Personal projects + organization (org service). org:read → visible to any
  // signed-in user (even org-less); hidden for anonymous visitors. Create
  // actions inside are auth-only (/api/org/me/*), enforced server-side.
  organization: { domain: 'org', level: 'read' },
  // The settings-policy surface was merged into the Settings page (see
  // views/settings.js policyGroup); the gateway still gates /api/settings-policy
  // with requirePermission('org') for org scope and auth-only for the /me scope.
});

// Where an unauthenticated visitor (or a signed-out session) lands.
export const DEFAULT_PUBLIC_ROUTE = 'agent';
const AUTHENTICATED_ONLY_ROUTES = new Set(['agent-jobs']);

const LEVEL_RANK = { read: 1, write: 2 };

export function permitted(permissions, domain, level) {
  const have = permissions && permissions[domain];
  if (!have) return false;
  return (LEVEL_RANK[have] || 0) >= (LEVEL_RANK[level] || 0);
}

export function canAccessRoute(session, route) {
  if (AUTHENTICATED_ONLY_ROUTES.has(route) && !session?.authenticated) return false;
  const permissions = session?.permissions || {};
  const need = MENU_PERMISSIONS[route];
  if (!need) return true; // routes without an entry are not permission-gated
  return permitted(permissions, need.domain, need.level);
}
