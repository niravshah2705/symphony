'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileStacks, retargetReview } = require('./stack-reconcile');

const SILENT = { info: () => {}, warn: () => {} };

function harness(overrides = {}) {
  const removed = [];
  const updated = [];
  const retargets = [];
  const base = {
    resolveSelection: () => ({ provider: 'github', repoRef: 'acme/app', token: 'tok' }),
    repoPartsImpl: () => ({ provider: 'github', owner: 'acme', name: 'app', fullName: 'acme/app', https: 'https://github.com/acme/app.git' }),
    validateRepositoryImpl: (parts) => parts,
    retarget: async (args) => { retargets.push(args); },
    removeLink: (id) => { removed.push(id); return true; },
    updateLink: (id, patch) => { updated.push({ id, patch }); return { id, ...patch }; },
    logger: SILENT,
  };
  return { opts: { ...base, ...overrides }, removed, updated, retargets };
}

const LINK = {
  id: 'stk_1',
  projectId: 'proj_1',
  provider: 'github',
  repoFullName: 'acme/app',
  dependentBranch: 'eng-2',
  blockerBranch: 'eng-1',
  defaultBase: 'main',
  dependentReviewId: null,
  createdAt: '2026-07-01T00:00:00Z',
};

test('retargets the dependent PR and clears the link once the blocker has merged', async () => {
  const findReview = async ({ branch }) => branch === 'eng-1'
    ? { id: 1, state: 'merged', sourceBranch: 'eng-1', targetBranch: 'main', url: 'u1' }
    : { id: 2, state: 'open', sourceBranch: 'eng-2', targetBranch: 'eng-1', url: 'u2' };
  const { opts, removed, retargets } = harness({ findReview });

  const summary = await reconcileStacks({ ...opts, links: [LINK] });

  assert.equal(retargets.length, 1);
  assert.equal(retargets[0].base, 'main');
  assert.equal(retargets[0].review.id, 2);
  assert.deepEqual(removed, ['stk_1']);
  assert.equal(summary.retargeted, 1);
});

test('leaves the link and records the dependent review id while the blocker is unmerged', async () => {
  const findReview = async ({ branch }) => branch === 'eng-1'
    ? { id: 1, state: 'open', sourceBranch: 'eng-1', targetBranch: 'main', url: 'u1' }
    : { id: 2, state: 'open', sourceBranch: 'eng-2', targetBranch: 'eng-1', url: 'u2' };
  const { opts, removed, updated, retargets } = harness({ findReview });

  const summary = await reconcileStacks({ ...opts, links: [LINK] });

  assert.equal(retargets.length, 0);
  assert.deepEqual(removed, []);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].patch.dependentReviewId, 2);
  assert.equal(summary.skipped, 1);
});

test('clears the link when the dependent PR already targets the default base', async () => {
  const findReview = async ({ branch }) => branch === 'eng-2'
    ? { id: 2, state: 'open', sourceBranch: 'eng-2', targetBranch: 'main', url: 'u2' }
    : { id: 1, state: 'open', sourceBranch: 'eng-1', targetBranch: 'main' };
  const { opts, removed, retargets } = harness({ findReview });

  const summary = await reconcileStacks({ ...opts, links: [LINK] });

  assert.equal(retargets.length, 0);
  assert.deepEqual(removed, ['stk_1']);
  assert.equal(summary.cleared, 1);
});

test('clears the link when the dependent PR is itself merged or closed', async () => {
  const findReview = async ({ branch }) => branch === 'eng-2'
    ? { id: 2, state: 'merged', sourceBranch: 'eng-2', targetBranch: 'eng-1' }
    : null;
  const { opts, removed } = harness({ findReview });

  const summary = await reconcileStacks({ ...opts, links: [LINK] });

  assert.deepEqual(removed, ['stk_1']);
  assert.equal(summary.cleared, 1);
});

test('leaves the link untouched when the dependent PR is not open yet', async () => {
  const findReview = async () => null;
  const { opts, removed, retargets } = harness({ findReview });

  // Link is fresh (createdAt recent relative to `now`) → kept for a later tick.
  const summary = await reconcileStacks({ ...opts, links: [LINK], now: () => Date.parse('2026-07-02T00:00:00Z') });

  assert.equal(retargets.length, 0);
  assert.deepEqual(removed, []);
  assert.equal(summary.skipped, 1);
});

test('retires a stale link whose dependent PR never appeared', async () => {
  const findReview = async () => null;
  const { opts, removed } = harness({ findReview });

  // now is > 14 days past the link createdAt → GC it so the store cannot grow forever.
  const summary = await reconcileStacks({ ...opts, links: [LINK], now: () => Date.parse('2026-08-01T00:00:00Z') });

  assert.deepEqual(removed, ['stk_1']);
  assert.equal(summary.cleared, 1);
});

test('pins the repo to the link identity, not the current business fallback', async () => {
  const seen = [];
  const findReview = async ({ repository }) => { seen.push(repository.fullName); return null; };
  // resolveSelection returns a DIFFERENT repo (as a deleted business would, via global fallback).
  const resolveSelection = () => ({ provider: 'github', repoRef: 'other/fallback', token: 'tok' });
  const repoPartsImpl = (repoRef) => ({ provider: 'github', owner: repoRef.split('/')[0], name: repoRef.split('/')[1], fullName: repoRef, https: `https://github.com/${repoRef}.git` });
  const { opts } = harness({ findReview, resolveSelection, repoPartsImpl });

  await reconcileStacks({ ...opts, links: [LINK], now: () => Date.parse('2026-07-02T00:00:00Z') });

  assert.deepEqual(seen, ['acme/app'], 'used the link repo, not the fallback');
});

test('a provider error on one link is swallowed and does not throw', async () => {
  const findReview = async () => { throw new Error('502 upstream'); };
  const { opts, removed } = harness({ findReview });

  const summary = await reconcileStacks({ ...opts, links: [LINK] });

  assert.deepEqual(removed, []);
  assert.equal(summary.skipped, 1);
});

test('reconcileStacks requires a resolveSelection function', async () => {
  await assert.rejects(() => reconcileStacks({ links: [LINK] }), /resolveSelection/);
});

test('retargetReview PATCHes the base for GitHub and PUTs target_branch for GitLab', async () => {
  const calls = [];
  const forgeRequest = async (args) => { calls.push(args); };
  const repository = { provider: 'github', owner: 'acme', name: 'app', fullName: 'acme/app' };
  await retargetReview({ provider: 'github', repository, token: 't', review: { id: 7 }, base: 'main', forgeRequest });
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].endpoint, /\/repos\/acme\/app\/pulls\/7$/);
  assert.deepEqual(calls[0].body, { base: 'main' });

  const glRepo = { provider: 'gitlab', owner: 'acme/team', name: 'app', fullName: 'acme/team/app' };
  await retargetReview({ provider: 'gitlab', repository: glRepo, token: 't', review: { id: 9 }, base: 'main', forgeRequest });
  assert.equal(calls[1].method, 'PUT');
  assert.match(calls[1].endpoint, /\/merge_requests\/9$/);
  assert.deepEqual(calls[1].body, { target_branch: 'main' });
});
