'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const { RepositoryBroker } = require('./repository-broker');

const execFileP = promisify(execFile);

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (data === null ? '' : JSON.stringify(data)),
    headers: { get: () => null },
  };
}

/**
 * Seed a bare remote with `main` plus one branch per name in `blockers`, each
 * carrying a commit that is NOT on main (unmerged work). Names in `merged` are
 * additionally fast-forwarded into main so they are contained in the base.
 */
function seedRemote(root, { blockers = [], mergedIntoMain = [] } = {}) {
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(seed, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: seed });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(seed, 'README.md'), '# fixture\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'fixture']);
  for (const branch of blockers) {
    git(['checkout', '-b', branch, 'main']);
    fs.writeFileSync(path.join(seed, `${branch}.txt`), `${branch} work\n`, 'utf8');
    git(['add', `${branch}.txt`]);
    git(['commit', '-m', `${branch} work`]);
    git(['checkout', 'main']);
    if (mergedIntoMain.includes(branch)) git(['merge', '--ff-only', branch]);
  }
  execFileSync('git', ['clone', '--bare', seed, remote], { cwd: root });
  return remote;
}

// Redirect only broker-private network reads/writes to the local bare remote;
// every other Git command runs unchanged (clone/export/checkout/merge-base).
function localGitImpl(remote) {
  return async (command, inputArgs, options) => {
    const args = [...inputArgs];
    const privateBareCommand = args.some((arg) => String(arg).startsWith('--git-dir='));
    if (args.includes('ls-remote') || (privateBareCommand && (args.includes('fetch') || args.includes('push')))) {
      const origin = args.indexOf('origin');
      if (origin >= 0) args[origin] = remote;
    }
    return execFileP(command, args, options);
  };
}

// Forge API stub: `merged` head branches report a merged PR; POST /pulls records
// the created review body so a test can assert the PR base.
function makeFetch({ merged = new Set(), created = [] } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'POST' && /\/pulls(\?|$)/.test(u)) {
      const body = JSON.parse(init.body || '{}');
      created.push(body);
      return response(201, {
        number: 101,
        html_url: 'https://github.com/acme/widgets/pull/101',
        state: 'open',
        title: body.title,
        head: { ref: body.head },
        base: { ref: body.base },
      });
    }
    if (method === 'GET' && /\/pulls\?/.test(u)) {
      const m = u.match(/head=acme%3A([^&]+)/);
      const branch = m ? decodeURIComponent(m[1]) : '';
      if (merged.has(branch)) {
        // Shape returned by the GitHub pulls LIST endpoint for a merged PR:
        // state 'closed' + merged_at set, and NO `merged` boolean (that field
        // only exists on the single-PR detail response).
        return response(200, [{
          number: 1,
          html_url: 'https://github.com/acme/widgets/pull/1',
          state: 'closed',
          merged_at: '2026-02-01T00:00:00Z',
          title: 'blocker',
          head: { ref: branch },
          base: { ref: 'main' },
        }]);
      }
      return response(200, []);
    }
    return response(404, { message: 'not found' });
  };
}

const REPO = {
  provider: 'github',
  owner: 'acme',
  name: 'widgets',
  fullName: 'acme/widgets',
  https: 'https://github.com/acme/widgets.git',
};

function makeBroker(t, { root, remote, branch, stackCandidates, fetchImpl }) {
  const workspaceRoot = path.join(root, 'workspaces');
  const workDir = path.join(workspaceRoot, 'ticket');
  const broker = new RepositoryBroker({
    provider: 'github',
    repository: REPO,
    token: 'test-token',
    workspaceRoot,
    workDir,
    branch,
    stackCandidates,
    fetchImpl,
    execFileImpl: localGitImpl(remote),
  });
  t.after(() => {
    broker.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { broker, workDir };
}

test('stacks a dependent task on the latest unmerged blocker and its PR targets that branch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-stack-'));
  const remote = seedRemote(root, { blockers: ['blk-old', 'blk-new'] });
  const created = [];
  const { broker, workDir } = makeBroker(t, {
    root,
    remote,
    branch: 'task-dep',
    stackCandidates: ['blk-new', 'blk-old'], // latest-first
    fetchImpl: makeFetch({ created }),
  });

  const info = await broker.prepare();

  assert.equal(info.baseBranch, 'blk-new', 'base retargeted to the latest unmerged blocker');
  assert.equal(info.stackedOn.branch, 'blk-new');
  assert.equal(info.stackedOn.defaultBase, 'main');
  // The task branch was forked from the blocker, so the blocker's work is present.
  assert.equal(fs.existsSync(path.join(workDir, 'blk-new.txt')), true, 'forked from the blocker branch');

  const review = await broker.openReview({ title: 'Dependent work' });
  assert.equal(review.targetBranch, 'blk-new');
  assert.equal(created.length, 1);
  assert.equal(created[0].base, 'blk-new', 'PR is opened against the blocker branch');
  assert.equal(created[0].head, 'task-dep');
});

test('skips a merged blocker and stacks on the next unmerged one', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-stack-merged-'));
  const remote = seedRemote(root, { blockers: ['blk-old', 'blk-new'] });
  const { broker } = makeBroker(t, {
    root,
    remote,
    branch: 'task-dep',
    stackCandidates: ['blk-new', 'blk-old'],
    fetchImpl: makeFetch({ merged: new Set(['blk-new']) }), // top candidate already merged
  });

  const info = await broker.prepare();

  assert.equal(info.baseBranch, 'blk-old', 'merged blocker skipped; stacks on the next one');
  assert.equal(info.stackedOn.branch, 'blk-old');
});

test('falls back to the default base when no blocker branch exists on the remote', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-stack-none-'));
  const remote = seedRemote(root, { blockers: [] });
  const { broker } = makeBroker(t, {
    root,
    remote,
    branch: 'task-dep',
    stackCandidates: ['blk-missing'],
    fetchImpl: makeFetch({}),
  });

  const info = await broker.prepare();

  assert.equal(info.baseBranch, 'main');
  assert.equal(info.stackedOn, null);
});

test('skips a blocker already contained in the default base', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-stack-contained-'));
  const remote = seedRemote(root, { blockers: ['blk-landed'], mergedIntoMain: ['blk-landed'] });
  const { broker } = makeBroker(t, {
    root,
    remote,
    branch: 'task-dep',
    stackCandidates: ['blk-landed'],
    fetchImpl: makeFetch({}), // no open PR reported → ancestry decides
  });

  const info = await broker.prepare();

  assert.equal(info.baseBranch, 'main', 'already-landed blocker is not a stack target');
  assert.equal(info.stackedOn, null);
});
