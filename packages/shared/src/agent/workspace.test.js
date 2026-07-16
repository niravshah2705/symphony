'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGitAuthEnv, GIT_CREDENTIAL_HELPER, GIT_TOKEN_ENV, repoParts, sanitizeBranch, sanitizeSlug } = require('./workspace');

test('buildGitAuthEnv keeps the stored GitHub token private to git', () => {
  const env = buildGitAuthEnv(
    {
      PATH: '/usr/bin',
      GH_TOKEN: 'ambient-gh-token',
      GITHUB_TOKEN: 'ambient-github-token',
      OTHER: 'kept',
    },
    'stored-token'
  );

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OTHER, 'kept');
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env[GIT_TOKEN_ENV], 'stored-token');
});

test('buildGitAuthEnv leaves GitHub CLI env untouched when no stored token is configured', () => {
  const env = buildGitAuthEnv({ GH_TOKEN: 'ambient-gh-token' }, '');

  assert.equal(env.GH_TOKEN, 'ambient-gh-token');
  assert.equal(env[GIT_TOKEN_ENV], undefined);
});

test('git credential helper reads the private token env var, not gh cli token names', () => {
  assert.match(GIT_CREDENTIAL_HELPER, new RegExp(`\\$${GIT_TOKEN_ENV}`));
  assert.doesNotMatch(GIT_CREDENTIAL_HELPER, /\$GH_TOKEN\b/);
  assert.doesNotMatch(GIT_CREDENTIAL_HELPER, /\$GITHUB_TOKEN\b/);
});

test('repoParts accepts owner/name and normalizes to GitHub https URL', () => {
  assert.deepEqual(repoParts('acme/widgets'), {
    owner: 'acme',
    name: 'widgets',
    https: 'https://github.com/acme/widgets.git',
  });
});

test('workspace name sanitizers remove unsafe path characters', () => {
  assert.equal(sanitizeSlug('../My Project!'), 'my-project');
  assert.equal(sanitizeBranch('../NIR 508?'), 'NIR-508');
});
