'use strict';

/**
 * Application authorization model (RBAC).
 *
 * Roles are carried as a Firebase custom claim (`role`) on the ID token; the
 * gateway resolves the claim to a fixed set of per-domain permissions. This is
 * the SERVER-SIDE source of truth — the SPA mirrors the same map only to hide
 * menu items, and every /api route is guarded by requirePermission (see
 * services/gateway/src/auth.js). Never treat the UI as the boundary.
 *
 * A "domain" groups the endpoints a feature area needs:
 *   workspace → agent + coder surfaces (agent/agent-jobs/calls/traces views)
 *   planning  → projects + issues + businesses (business/projects/board views)
 *   insights  → observability (analytics/workflows/troubleshooting views)
 *   settings  → settings config + provider OAuth + role members (settings view)
 *
 * Each domain is granted at a level: 'read' (GET) or 'write' (mutations).
 */

const DOMAINS = Object.freeze(['workspace', 'planning', 'insights', 'settings', 'org']);
const ROLES = Object.freeze(['admin', 'operator', 'viewer']);
const LEVEL_RANK = Object.freeze({ read: 1, write: 2 });

// `org` gates the Organization service (services/org) reached via /api/org/*.
const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze({ workspace: 'write', planning: 'write', insights: 'write', settings: 'write', org: 'write' }),
  operator: Object.freeze({ workspace: 'write', planning: 'write', insights: 'write', settings: 'read', org: 'write' }),
  viewer: Object.freeze({ workspace: 'read', planning: 'read', insights: 'read', settings: 'read', org: 'read' }),
});

// Everything an UNAUTHENTICATED visitor may do: read-only Agent workspace only.
const PUBLIC_PERMISSIONS = Object.freeze({ workspace: 'read' });

// Local dev (AUTH_MODE=disabled) is a single trusted operator → full access.
const ADMIN_PERMISSIONS = ROLE_PERMISSIONS.admin;

/** Read for safe methods, write for anything that can mutate state. */
function requiredLevel(method) {
  return /^(GET|HEAD|OPTIONS)$/i.test(String(method || '')) ? 'read' : 'write';
}

/** Does this permission set grant `domain` at (at least) `level`? */
function permitted(permissions, domain, level) {
  const have = permissions && permissions[domain];
  if (!have) return false;
  return (LEVEL_RANK[have] || 0) >= (LEVEL_RANK[level] || 0);
}

function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.viewer;
}

/**
 * Resolve a signed-in identity to a role. Precedence:
 *   1. bootstrap admins (config.adminEmails — env/terraform, NOT hardcoded)
 *   2. the `role` custom claim (only if it names a known role)
 *   3. config.defaultRole (least-privilege fallback, default 'viewer')
 * An unknown/absent claim never yields more than the default role.
 */
function resolveRole(decoded, config = {}) {
  const email = String((decoded && decoded.email) || '').trim().toLowerCase();
  const adminEmails = config.adminEmails || [];
  if (email && adminEmails.includes(email)) return 'admin';
  const claimed = String((decoded && decoded.role) || '').trim().toLowerCase();
  if (ROLES.includes(claimed)) return claimed;
  return ROLES.includes(config.defaultRole) ? config.defaultRole : 'viewer';
}

module.exports = {
  DOMAINS,
  ROLES,
  ROLE_PERMISSIONS,
  PUBLIC_PERMISSIONS,
  ADMIN_PERMISSIONS,
  requiredLevel,
  permitted,
  permissionsForRole,
  resolveRole,
};
