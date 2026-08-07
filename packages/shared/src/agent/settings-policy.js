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

// Allow-listed config value keys (mirror of services/settings
// app/models/policy.py CONFIG_VALUE_KEYS). These are write-only secrets.
const CONFIG_VALUE_KEYS = Object.freeze(['geminiApiKey']);

/**
 * Resolve each allow-listed config value with user > project > org precedence
 * (a lower scope overrides a higher one — the opposite of the include/exclude
 * narrowing, because config values are overrides, not restrictions). Mirrors
 * services/settings resolver.resolve_effective_values.
 * @returns {Record<string,string>} only keys with a non-empty value.
 */
function resolveEffectiveValues({ org, project, user } = {}) {
  const byScope = [user, project, org].map((p) => (p && p.values) || {});
  const out = {};
  for (const key of CONFIG_VALUE_KEYS) {
    for (const values of byScope) {
      if (values[key]) {
        out[key] = values[key];
        break;
      }
    }
  }
  return out;
}

/** True when `domain`'s effective set is present in the resolved policy. */
function hasDomain(effective, domain) {
  return Boolean(effective && effective[domain] && Array.isArray(effective[domain].effective));
}

/**
 * Filter a workflow's TOOL names by the effective ``tools`` policy. The tools
 * universe is the tool-registry DOMAIN names (docker/build/…), while a workflow
 * lists individual tool names, so a tool is kept when it is ungoverned (no known
 * domain, e.g. web_search) OR its domain is in the allowed set. `toolDomains` is
 * the tool-name → domain map (packages/shared/src/agent/tools/index.js
 * TOOL_DOMAIN); without it, tools are left unchanged.
 */
function filterToolsByPolicy(toolNames, allowedDomains, toolDomains) {
  if (!toolDomains) return toolNames || [];
  const allowed = new Set(allowedDomains || []);
  return (toolNames || []).filter((name) => {
    const domain = toolDomains[name];
    return !domain || allowed.has(domain);
  });
}

/**
 * Return a workflow with its `tools` and `skills` pruned to the caller's
 * effective policy. Skills match the universe by id directly; tools are filtered
 * by their registry domain (see filterToolsByPolicy). When no policy is threaded
 * through (local single-user) the workflow is returned unchanged — allow-all, no
 * regression.
 */
function applyPolicyToWorkflow(workflow, effective, { toolDomains } = {}) {
  if (!workflow || !effective) return workflow;
  const next = { ...workflow };
  if (hasDomain(effective, 'tools') && Array.isArray(workflow.tools)) {
    next.tools = filterToolsByPolicy(workflow.tools, effective.tools.effective, toolDomains);
  }
  if (hasDomain(effective, 'skills') && Array.isArray(workflow.skills)) {
    next.skills = filterByPolicy(workflow.skills, effective.skills.effective);
  }
  return next;
}

/** The skill name inside an installed skill path like `/.agent-skills/<name>/`. */
function skillNameFromPath(skillPath) {
  const parts = String(skillPath || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * Prune already-installed skill directory paths to the effective skills policy.
 * Allow-all when no skills policy is present.
 */
function filterSkillPaths(skillPaths, effective) {
  if (!Array.isArray(skillPaths) || !hasDomain(effective, 'skills')) return skillPaths;
  const allowed = new Set(effective.skills.effective);
  return skillPaths.filter((p) => allowed.has(skillNameFromPath(p)));
}

/**
 * Enforce the harness policy on a chosen runtime id. If the runtime is excluded,
 * fall back to the first allowed harness (preferring `deepagent`, the
 * provider-neutral default). When no harness policy is present, or nothing is
 * allowed, the runtime is returned unchanged (fail-open — no regression).
 * @returns {string} the effective (possibly downgraded) runtime id.
 */
function enforceHarness(runtimeId, effective, { preferred = 'deepagent' } = {}) {
  if (!hasDomain(effective, 'harness')) return runtimeId;
  const allowed = effective.harness.effective;
  if (!allowed.length) return runtimeId; // policy allows nothing → don't brick the run
  if (allowed.includes(runtimeId)) return runtimeId;
  if (allowed.includes(preferred)) return preferred;
  return allowed[0];
}

module.exports = {
  DOMAINS,
  CONFIG_VALUE_KEYS,
  globToRegExp,
  matchesAny,
  applyScope,
  resolveDomain,
  resolveEffective,
  resolveEffectiveValues,
  filterByPolicy,
  filterToolsByPolicy,
  applyPolicyToWorkflow,
  filterSkillPaths,
  skillNameFromPath,
  enforceHarness,
};
