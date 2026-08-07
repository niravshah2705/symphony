'use strict';

/**
 * Settings-policy cascade resolver (JS mirror of services/settings
 * app/domain/resolver.py). This is the helper the gateway/planner calls to
 * enforce a workflow's effective harness/tools/skills/plugins at build time.
 *
 * Rule: exclude at org blocks project AND user; exclude at project blocks user;
 * a lower scope can only NARROW, never re-include what a higher scope excluded;
 * exclude always wins downward. Enforced structurally — each scope filters the
 * set the scope above already allowed, so a lower include can never re-add a
 * higher-excluded item.
 *
 * Policy shape (matches the settings service PolicyResponse):
 *   { domains: { harness: { include: [], exclude: [] }, tools: {...}, ... } }
 * Patterns are globs (fnmatch-style): `*`, `?`, `[seq]`, `[!seq]` — e.g.
 * `security:*`.
 */

const DOMAINS = Object.freeze(['harness', 'tools', 'skills', 'plugins']);

const EMPTY_SCOPE = Object.freeze({ include: [], exclude: [] });

/** Translate a fnmatch-style glob into an anchored, case-sensitive RegExp. */
function globToRegExp(pattern) {
  let out = '';
  const chars = String(pattern);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else if (ch === '[') {
      // Character class — copy through the closing ']'. `[!...]` negates.
      let j = i + 1;
      let negate = false;
      if (chars[j] === '!') {
        negate = true;
        j += 1;
      }
      let cls = '';
      while (j < chars.length && chars[j] !== ']') {
        const c = chars[j];
        cls += /[\\^\]]/.test(c) ? `\\${c}` : c;
        j += 1;
      }
      if (j >= chars.length) {
        // No closing bracket — treat '[' literally (fnmatch behaviour).
        out += '\\[';
      } else {
        out += `[${negate ? '^' : ''}${cls}]`;
        i = j;
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(item, patterns) {
  return (patterns || []).some((pattern) => globToRegExp(pattern).test(item));
}

/**
 * Narrow `candidates` by one scope's include/exclude (order-preserving). Empty
 * include keeps all candidates (before exclusions); a non-empty include keeps
 * only matches; exclude always removes and wins over include.
 */
function applyScope(candidates, scope) {
  const s = scope || EMPTY_SCOPE;
  const include = s.include || [];
  const exclude = s.exclude || [];
  const base = include.length ? candidates.filter((c) => matchesAny(c, include)) : candidates.slice();
  return base.filter((c) => !matchesAny(c, exclude));
}

/** Cascade one domain: universe → org → project → user. */
function resolveDomain(universe, org, project, user) {
  const orgAllowed = applyScope(universe || [], org);
  const projectAllowed = applyScope(orgAllowed, project);
  const userAllowed = applyScope(projectAllowed, user);
  return { org: orgAllowed, project: projectAllowed, user: userAllowed, effective: userAllowed };
}

function scopeFor(policy, domain) {
  if (!policy || !policy.domains) return EMPTY_SCOPE;
  return policy.domains[domain] || EMPTY_SCOPE;
}

/**
 * Resolve every domain's cascade from three policy documents. Missing policies
 * are treated as empty (no restriction at that scope).
 * @returns {Record<string,{org:string[],project:string[],user:string[],effective:string[]}>}
 */
function resolveEffective(universeByDomain, { org, project, user } = {}) {
  const result = {};
  for (const domain of DOMAINS) {
    const universe = (universeByDomain && universeByDomain[domain]) || [];
    result[domain] = resolveDomain(universe, scopeFor(org, domain), scopeFor(project, domain), scopeFor(user, domain));
  }
  return result;
}

/**
 * Filter a workflow's requested items down to the effective allowed set. Used by
 * the enforcement point to prune harness/tools/skills/plugins before an agent is
 * built. Order-preserving on `items`.
 */
function filterByPolicy(items, allowed) {
  const set = new Set(allowed || []);
  return (items || []).filter((item) => set.has(item));
}

module.exports = {
  DOMAINS,
  globToRegExp,
  matchesAny,
  applyScope,
  resolveDomain,
  resolveEffective,
  filterByPolicy,
};
