'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DOMAINS,
  globToRegExp,
  applyScope,
  resolveDomain,
  resolveEffective,
  filterByPolicy,
} = require('./settings-policy');

const HARNESS = ['deepagent', 'codex-sdk', 'claude-agent-sdk'];

function dp(include = [], exclude = []) {
  return { include, exclude };
}

test('DOMAINS are the four settings domains', () => {
  assert.deepEqual([...DOMAINS], ['harness', 'tools', 'skills', 'plugins']);
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
