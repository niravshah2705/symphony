'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRepo, repositoryFields } = require('./businesses');

test('business repository normalization preserves provider-specific namespaces', () => {
  assert.equal(normalizeRepo('acme/widgets', 'github'), 'acme/widgets');
  assert.equal(normalizeRepo('https://gitlab.com/acme/platform/widgets.git', 'gitlab'), 'acme/platform/widgets');
  assert.equal(normalizeRepo('git@gitlab.com:acme/platform/widgets.git', 'gitlab'), 'acme/platform/widgets');
});

test('business repository validation rejects provider/host mismatches', () => {
  assert.match(
    repositoryFields({ repoProvider: 'github', repo: 'https://gitlab.com/acme/widgets.git' }).error,
    /GitHub/
  );
  assert.match(repositoryFields({ repoProvider: 'github', repo: 'acme/platform/widgets' }).error, /GitHub/);
  assert.match(repositoryFields({ repoProvider: 'bitbucket', repo: 'acme/widgets' }).error, /GitHub or GitLab/);
});

test('business repository updates retain their stored provider', () => {
  assert.deepEqual(
    repositoryFields({ repo: 'acme/platform/new-widgets' }, {
      repo: 'acme/platform/widgets',
      repoProvider: 'gitlab',
    }),
    { repo: 'acme/platform/new-widgets', repoProvider: 'gitlab' }
  );
  assert.deepEqual(repositoryFields({ repo: 'acme/widgets' }), {
    repo: 'acme/widgets',
    repoProvider: 'github',
  });
});
