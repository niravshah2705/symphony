'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrateBusinessRepositories } = require('./store');
const { resolvePlannedRepository, CoderError } = require('./agent/coder');

test('legacy business repositories migrate to their original GitHub contract', () => {
  const [legacy, existing] = migrateBusinessRepositories([
    { id: 'legacy', repo: 'acme/widgets' },
    { id: 'gitlab', repo: 'acme/platform/widgets', repoProvider: 'gitlab' },
  ]);
  assert.equal(legacy.repoProvider, 'github');
  assert.equal(existing.repoProvider, 'gitlab');
});

test('planned repository uses the business provider and matching token after a global switch', () => {
  const tokenRequests = [];
  const selected = resolvePlannedRepository({
    business: { repo: 'acme/platform/widgets', repoProvider: 'gitlab' },
    globalRepository: { provider: 'github', url: 'other/default', token: 'github-global-token' },
    repositoryProvider: 'github',
    repositoryToken: 'github-snapshot-token',
    tokenForProvider(provider) {
      tokenRequests.push(provider);
      return `${provider}-stored-token`;
    },
  });

  assert.deepEqual(selected, {
    repoRef: 'acme/platform/widgets',
    provider: 'gitlab',
    token: 'gitlab-stored-token',
  });
  assert.deepEqual(tokenRequests, ['gitlab']);
});

test('legacy planned repositories stay GitHub and unknown providers fail closed', () => {
  const legacy = resolvePlannedRepository({
    business: { repo: 'acme/widgets' },
    globalRepository: { provider: 'gitlab', url: 'other/default', token: 'gitlab-token' },
    tokenForProvider: (provider) => `${provider}-token`,
  });
  assert.equal(legacy.provider, 'github');
  assert.equal(legacy.token, 'github-token');

  assert.throws(
    () => resolvePlannedRepository({
      business: { repo: 'acme/widgets', repoProvider: 'bitbucket' },
      globalRepository: { provider: 'github' },
    }),
    (error) => error instanceof CoderError && /GitHub or GitLab/.test(error.message)
  );
});
