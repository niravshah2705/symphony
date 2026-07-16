'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { repoParts, sanitizeBranch, sanitizeSlug, scopedProjectSlug } = require('./workspace');

test('repoParts accepts owner/name and normalizes to GitHub https URL', () => {
  assert.deepEqual(repoParts('acme/widgets'), {
    provider: 'github',
    owner: 'acme',
    name: 'widgets',
    fullName: 'acme/widgets',
    https: 'https://github.com/acme/widgets.git',
  });
});

test('repoParts supports GitLab groups and rejects unrelated hosts', () => {
  assert.deepEqual(repoParts('acme/platform/widgets', 'gitlab'), {
    provider: 'gitlab',
    owner: 'acme/platform',
    name: 'widgets',
    fullName: 'acme/platform/widgets',
    https: 'https://gitlab.com/acme/platform/widgets.git',
  });
  assert.equal(repoParts('https://example.com/acme/widgets.git', 'github'), null);
  assert.equal(repoParts('https://gitlab.com/acme/widgets.git', 'github'), null);
  assert.equal(repoParts('git@github.com:acme/widgets.git', 'gitlab'), null);
});

test('repoParts enforces provider-specific namespace shape and host matching', () => {
  assert.equal(repoParts('acme/platform/widgets', 'github'), null);
  assert.equal(repoParts('https://gitlab.com/acme/widgets.git', 'github'), null);
  assert.equal(repoParts('https://github.com/acme/widgets.git', 'gitlab'), null);
  assert.equal(repoParts('acme/../widgets', 'gitlab'), null);
  assert.equal(repoParts('acme/widgets', 'bitbucket'), null);
});

test('workspace name sanitizers remove unsafe path characters', () => {
  assert.equal(sanitizeSlug('../My Project!'), 'my-project');
  assert.equal(sanitizeSlug('..'), 'project');
  assert.equal(sanitizeBranch('../NIR 508?'), 'NIR-508');
});

test('planned workspace slug includes project identity to prevent same-name collisions', () => {
  assert.match(scopedProjectSlug('Payments', 'project-a'), /^payments-[a-f0-9]{10}$/);
  assert.notEqual(scopedProjectSlug('Payments', 'project-a'), scopedProjectSlug('Payments', 'project-b'));
  assert.equal(scopedProjectSlug('Payments', 'project-a'), scopedProjectSlug('Payments', 'project-a'));
});
