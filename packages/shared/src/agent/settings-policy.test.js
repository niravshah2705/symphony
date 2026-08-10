'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DOMAINS,
  CONFIG_VALUE_KEYS,
  globToRegExp,
  applyScope,
  resolveDomain,
  resolveEffective,
  resolveEffectiveValues,
  filterByPolicy,
  filterToolsByPolicy,
  applyPolicyToWorkflow,
  filterSkillPaths,
  filterHooksByPolicy,
  enforceHarness,
} = require('./settings-policy');

const HARNESS = ['deepagent', 'codex-sdk', 'claude-agent-sdk'];

function dp(include = [], exclude = []) {
  return { include, exclude };
}

test('DOMAINS are the five settings domains', () => {
  assert.deepEqual([...DOMAINS], ['harness', 'tools', 'skills', 'plugins', 'hooks']);
});

test('filterHooksByPolicy prunes hook ids to the effective hooks policy', () => {
  const effective = { hooks: { effective: ['pre-code', 'post-code'] } };
  assert.deepEqual(filterHooksByPolicy(['pre-code', 'pre-pr', 'post-code'], effective), ['pre-code', 'post-code']);
  // Allow-all (no regression) when no hooks policy is present.
  assert.deepEqual(filterHooksByPolicy(['pre-code'], {}), ['pre-code']);
});

test('globToRegExp matches literal, wildcard and char class', () => {
  assert.ok(globToRegExp('security:*').test('security:raven'));
  assert.ok(!globToRegExp('security:*').test('web-research'));
  assert.ok(globToRegExp('codex-sdk').test('codex-sdk'));
  assert.ok(!globToRegExp('codex-sdk').test('codex'));
  assert.ok(globToRegExp('file?').test('file1'));
  assert.ok(globToRegExp('[!x]y').test('ay'));
  assert.ok(!globToRegExp('[!x]y').test('xy'));
});

test('applyScope: empty include keeps all, exclude removes and wins', () => {
  assert.deepEqual(applyScope(HARNESS, dp()), HARNESS);
  assert.deepEqual(applyScope(HARNESS, dp(['deepagent'])), ['deepagent']);
  assert.deepEqual(applyScope(HARNESS, dp(['deepagent', 'codex-sdk'], ['codex-sdk'])), ['deepagent']);
});

test('exclude at org blocks project AND user (no re-include downward)', () => {
  const res = resolveDomain(
    HARNESS,
    dp([], ['codex-sdk']),
    dp(['codex-sdk']),
    dp(['codex-sdk', 'deepagent'])
  );
  assert.ok(!res.org.includes('codex-sdk'));
  assert.ok(!res.project.includes('codex-sdk'));
  assert.ok(!res.user.includes('codex-sdk'));
  assert.deepEqual(res.effective, res.user);
});

test('exclude at project blocks user', () => {
  const res = resolveDomain(HARNESS, dp(), dp([], ['deepagent']), dp(['deepagent']));
  assert.ok(res.org.includes('deepagent'));
  assert.ok(!res.project.includes('deepagent'));
  assert.ok(!res.user.includes('deepagent'));
});

test('project narrows within org-allowed; a non-candidate include is a no-op', () => {
  const res = resolveDomain(
    HARNESS,
    dp(['deepagent', 'codex-sdk']),
    dp(['claude-agent-sdk']),
    dp()
  );
  assert.deepEqual(res.org, ['deepagent', 'codex-sdk']);
  assert.deepEqual(res.project, []);
  assert.deepEqual(res.user, []);
});

test('resolveEffective covers every domain and treats missing policies as empty', () => {
  const universe = {
    harness: HARNESS,
    tools: ['docker', 'security', 'build'],
    skills: ['security:raven', 'linear', 'commit'],
    plugins: ['security', 'ecc'],
  };
  const org = { domains: { tools: dp([], ['security']), skills: dp([], ['security:*']) } };
  const user = { domains: { tools: dp(['security', 'docker']) } };
  const res = resolveEffective(universe, { org, user });

  assert.deepEqual(res.harness.effective, HARNESS);
  assert.deepEqual(res.tools.effective, ['docker']); // user cannot re-add org-excluded security
  assert.deepEqual(res.skills.effective, ['linear', 'commit']);
  assert.deepEqual(res.plugins.effective, ['security', 'ecc']); // no policy → full
});

test('resolveEffective with no policies returns the full universe', () => {
  const res = resolveEffective({ harness: HARNESS }, {});
  assert.deepEqual(res.harness.effective, HARNESS);
});

test('filterByPolicy prunes requested items to the allowed set (order-preserving)', () => {
  assert.deepEqual(filterByPolicy(['docker', 'security', 'build'], ['build', 'docker']), ['docker', 'build']);
  assert.deepEqual(filterByPolicy([], ['docker']), []);
});

// ---- config values (user > project > org override precedence) --------------

test('CONFIG_VALUE_KEYS is the allow-list starting with geminiApiKey', () => {
  assert.ok([...CONFIG_VALUE_KEYS].includes('geminiApiKey'));
});

test('resolveEffectiveValues resolves user over project over org', () => {
  const org = { values: { geminiApiKey: 'org-key' } };
  const project = { values: { geminiApiKey: 'project-key' } };
  const user = { values: { geminiApiKey: 'user-key' } };
  assert.deepEqual(resolveEffectiveValues({ org, project, user }), { geminiApiKey: 'user-key' });
  assert.deepEqual(resolveEffectiveValues({ org, project }), { geminiApiKey: 'project-key' });
  assert.deepEqual(resolveEffectiveValues({ org }), { geminiApiKey: 'org-key' });
  assert.deepEqual(resolveEffectiveValues({}), {});
});

// ---- enforcement: tools (domain-aware), skills, harness --------------------

const TOOL_DOMAINS = { docker_build: 'docker', run_pytest: 'quality', web_search: undefined };

test('filterToolsByPolicy drops governed tools whose domain is excluded, keeps ungoverned', () => {
  // Only the 'quality' domain is allowed; 'docker' is excluded; web_search is ungoverned.
  const kept = filterToolsByPolicy(['docker_build', 'run_pytest', 'web_search'], ['quality'], TOOL_DOMAINS);
  assert.deepEqual(kept, ['run_pytest', 'web_search']);
});

test('applyPolicyToWorkflow drops excluded tools (by domain) and excluded skills', () => {
  const workflow = {
    name: 'coding',
    tools: ['docker_build', 'run_pytest', 'web_search'],
    skills: ['linear', 'commit', 'push'],
  };
  const effective = {
    tools: { effective: ['quality'] }, // docker excluded
    skills: { effective: ['linear', 'commit'] }, // push excluded
  };
  const out = applyPolicyToWorkflow(workflow, effective, { toolDomains: TOOL_DOMAINS });
  assert.deepEqual(out.tools, ['run_pytest', 'web_search']);
  assert.deepEqual(out.skills, ['linear', 'commit']);
  // Original workflow is not mutated (immutability).
  assert.deepEqual(workflow.tools, ['docker_build', 'run_pytest', 'web_search']);
});

test('applyPolicyToWorkflow with no policy is allow-all (no regression)', () => {
  const workflow = { tools: ['docker_build'], skills: ['linear'] };
  assert.equal(applyPolicyToWorkflow(workflow, null), workflow);
});

test('filterSkillPaths prunes installed skill dirs to the allowed skills', () => {
  const paths = ['/.agent-skills/software-planning/', '/.agent-skills/web-research/'];
  const effective = { skills: { effective: ['software-planning'] } };
  assert.deepEqual(filterSkillPaths(paths, effective), ['/.agent-skills/software-planning/']);
  // No skills policy → unchanged.
  assert.deepEqual(filterSkillPaths(paths, {}), paths);
});

test('enforceHarness downgrades an excluded harness to an allowed one (prefers deepagent)', () => {
  const effective = { harness: { effective: ['deepagent', 'claude-agent-sdk'] } };
  // codex-sdk is excluded → falls back to the preferred deepagent.
  assert.equal(enforceHarness('codex-sdk', effective), 'deepagent');
  // an allowed harness is kept as-is.
  assert.equal(enforceHarness('claude-agent-sdk', effective), 'claude-agent-sdk');
});

test('enforceHarness falls back to the first allowed when deepagent is excluded', () => {
  const effective = { harness: { effective: ['codex-sdk', 'claude-agent-sdk'] } };
  assert.equal(enforceHarness('antigravity-sdk', effective), 'codex-sdk');
});

test('enforceHarness is fail-open: no policy, or nothing allowed, keeps the runtime', () => {
  assert.equal(enforceHarness('codex-sdk', null), 'codex-sdk');
  assert.equal(enforceHarness('codex-sdk', { harness: { effective: [] } }), 'codex-sdk');
});
