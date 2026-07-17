'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const {
  RepositoryBroker,
  buildSafeAgentEnv,
  validateRepository,
} = require('./repository-broker');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const execFileP = promisify(execFile);

function response(status, data, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (data === null ? '' : JSON.stringify(data)),
    headers: {
      get: (name) => headers[String(name).toLowerCase()] || null,
    },
  };
}

function createScope(t, {
  provider = 'github',
  token = 'stored-secret-token',
  fetchImpl,
  reportedRemote,
  statusOutput = '',
  headSha = SHA,
  treeMatchesBase = true,
  remoteBranchNames = [],
  indexFlags = '',
  fsmonitorFlags = '',
  dangerousConfig = '',
  branchShas = {},
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-broker-test-'));
  const workDir = path.join(root, 'ticket');
  fs.mkdirSync(path.join(workDir, '.git'), { recursive: true });
  const repository = provider === 'github'
    ? {
        provider,
        owner: 'acme',
        name: 'widgets',
        fullName: 'acme/widgets',
        https: 'https://github.com/acme/widgets.git',
      }
    : {
        provider,
        owner: 'acme/platform',
        name: 'widgets',
        fullName: 'acme/platform/widgets',
        https: 'https://gitlab.com/acme/platform/widgets.git',
      };
  fs.writeFileSync(
    path.join(workDir, '.git', 'config'),
    `[remote "origin"]\n\turl = ${repository.https}\n`,
    'utf8'
  );

  const gitCalls = [];
  let currentBranch = 'task-123';
  const localBranches = new Set([currentBranch]);
  const remoteBranches = new Set(remoteBranchNames);
  const heads = new Map([[currentBranch, headSha], ...Object.entries(branchShas)]);
  const execFileImpl = async (command, args, options) => {
    gitCalls.push({ command, args: [...args], options });
    const joined = args.join('\u0000');
    if (joined.includes('remote\u0000get-url\u0000origin')) return { stdout: reportedRemote || repository.https };
    if (joined.includes('config\u0000--local\u0000--get-regexp')) {
      if (dangerousConfig) return { stdout: dangerousConfig };
      throw new Error('not found');
    }
    if (joined.includes('branch\u0000--show-current')) return { stdout: currentBranch };
    const checkoutIndex = args.indexOf('checkout');
    if (checkoutIndex >= 0 && args[checkoutIndex + 1] === '-b') {
      const previousSha = heads.get(currentBranch) || headSha;
      currentBranch = args[checkoutIndex + 2];
      localBranches.add(currentBranch);
      if (!heads.has(currentBranch)) heads.set(currentBranch, previousSha);
      return { stdout: '' };
    }
    if (checkoutIndex >= 0) {
      currentBranch = args[checkoutIndex + 1];
      return { stdout: '' };
    }
    const showRefIndex = args.indexOf('show-ref');
    if (showRefIndex >= 0) {
      const ref = args[args.length - 1];
      if (ref.startsWith('refs/heads/') && localBranches.has(ref.slice('refs/heads/'.length))) return { stdout: '' };
      if (ref.startsWith('refs/remotes/origin/') && remoteBranches.has(ref.slice('refs/remotes/origin/'.length))) {
        return { stdout: '' };
      }
      throw new Error('not found');
    }
    if (joined.includes('rev-parse\u0000HEAD')) return { stdout: heads.get(currentBranch) || headSha };
    if (joined.includes('rev-parse\u0000refs/heads/') || joined.includes('rev-parse\u0000refs/remotes/origin/')) {
      const ref = args[args.length - 1];
      const branch = ref.replace(/^refs\/(?:heads|remotes\/origin)\//, '');
      return { stdout: heads.get(branch) || headSha };
    }
    if (joined.includes('ls-files\u0000-v')) return { stdout: indexFlags };
    if (joined.includes('ls-files\u0000-f')) return { stdout: fsmonitorFlags };
    if (joined.includes('status\u0000--porcelain')) {
      return { stdout: typeof statusOutput === 'function' ? statusOutput() : statusOutput };
    }
    if (joined.includes('diff\u0000--quiet')) {
      if (treeMatchesBase) return { stdout: '' };
      throw new Error('trees differ');
    }
    const pushIndex = args.indexOf('push');
    if (pushIndex >= 0) {
      const refspec = args[args.length - 1];
      const match = String(refspec).match(/^refs\/heads\/([^:]+):refs\/heads\/([^:]+)$/);
      if (match && match[1] === match[2]) remoteBranches.add(match[1]);
    }
    return { stdout: '' };
  };

  const broker = new RepositoryBroker({
    provider,
    repository,
    token,
    workspaceRoot: root,
    workDir,
    branch: 'task-123',
    label: 'techsymphony',
    fetchImpl: fetchImpl || (async () => response(500, { message: 'unexpected request' })),
    execFileImpl,
  });
  broker.baseBranch = 'main';
  t.after(() => {
    broker.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { broker, gitCalls, repository, token, workDir };
}

test('safe shell environment allowlists operational values and drops all ambient secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-agent-env-'));
  try {
    const env = buildSafeAgentEnv(
      {
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        HOME: '/Users/operator',
        GH_TOKEN: 'github-secret',
        GITLAB_TOKEN: 'gitlab-secret',
        TECHSYMPHONY_BROKER_GIT_TOKEN: 'broker-secret',
        LINEAR_API_KEY: 'linear-secret',
        AWS_SECRET_ACCESS_KEY: 'cloud-secret',
        OTHER: 'not-allowlisted',
      },
      root
    );

    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.LANG, 'en_US.UTF-8');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.notEqual(env.HOME, '/Users/operator');
    assert.ok(env.HOME.startsWith(path.join(os.tmpdir(), 'techsymphony-agent-home')));
    for (const key of [
      'GH_TOKEN',
      'GITLAB_TOKEN',
      'TECHSYMPHONY_BROKER_GIT_TOKEN',
      'LINEAR_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'OTHER',
    ]) {
      assert.equal(env[key], undefined, `${key} must not reach LocalShellBackend`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository scope rejects cross-provider hosts and nested GitHub namespaces', () => {
  assert.throws(
    () => validateRepository({
      provider: 'github',
      owner: 'acme',
      name: 'widgets',
      fullName: 'acme/widgets',
      https: 'https://gitlab.com/acme/widgets.git',
    }, 'github'),
    /outside the selected provider host/
  );
  assert.throws(
    () => validateRepository({
      provider: 'github',
      owner: 'acme/platform',
      name: 'widgets',
      fullName: 'acme/platform/widgets',
      https: 'https://github.com/acme/platform/widgets.git',
    }, 'github'),
    /namespace is invalid/
  );
  assert.throws(
    () => validateRepository({
      provider: 'gitlab',
      owner: 'acme',
      name: 'widgets',
      fullName: 'another/widgets',
      https: 'https://gitlab.com/acme/widgets.git',
    }, 'gitlab'),
    /namespace is invalid/
  );
});

test('broker push fixes the refspec and keeps the token out of argv and workspace config', async (t) => {
  const { broker, gitCalls, token, workDir } = createScope(t);
  const result = await broker.execute({ action: 'push' });

  assert.equal(result.pushed, true);
  assert.equal(result.branch, 'task-123');
  const push = gitCalls.find((call) => call.args.includes('push'));
  assert.ok(push, 'expected an authenticated staging push');
  assert.ok(push.args.includes('refs/heads/task-123:refs/heads/task-123'));
  assert.equal(push.args.some((arg) => String(arg).includes('--force')), false);
  assert.equal(push.args.some((arg) => String(arg).includes(token)), false);
  assert.ok(Object.values(push.options.env).includes(token), 'token is limited to the broker-owned child process');
  assert.doesNotMatch(fs.readFileSync(path.join(workDir, '.git', 'config'), 'utf8'), /stored-secret-token/);
  assert.doesNotMatch(JSON.stringify(gitCalls.map(({ command, args }) => ({ command, args }))), /stored-secret-token/);
  const status = gitCalls.find((call) => call.args.includes('status'));
  assert.ok(status.args.includes('status.showUntrackedFiles=all'));
  assert.ok(status.args.includes('--untracked-files=all'));
  assert.ok(status.args.includes('--ignore-submodules=none'));
});

test('clean-workspace checks fail closed on hidden index state and unsafe local status config', async (t) => {
  const hidden = createScope(t, { indexFlags: 'S src/hidden.js' });
  await assert.rejects(
    () => hidden.broker.execute({ action: 'push' }),
    (error) => error && error.code === 'unsafe_index_flags'
  );

  const fsmonitor = createScope(t, { fsmonitorFlags: 'h src/cached.js' });
  await assert.rejects(
    () => fsmonitor.broker.execute({ action: 'push' }),
    (error) => error && error.code === 'unsafe_index_flags'
  );

  const configured = createScope(t, { dangerousConfig: 'status.showuntrackedfiles no' });
  await assert.rejects(
    () => configured.broker.execute({ action: 'push' }),
    (error) => error && error.code === 'unsafe_git_config'
  );

  const excluded = createScope(t);
  fs.mkdirSync(path.join(excluded.workDir, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(excluded.workDir, '.git', 'info', 'exclude'), 'private-output.log\n', 'utf8');
  await assert.rejects(
    () => excluded.broker.execute({ action: 'push' }),
    (error) => error && error.code === 'unsafe_git_config'
  );
});

test('broker rejects a reused checkout whose origin is a different repository', async (t) => {
  const { broker } = createScope(t, { reportedRemote: 'https://github.com/other/project.git' });
  await assert.rejects(
    () => broker.execute({ action: 'push' }),
    (error) => error && error.code === 'origin_mismatch'
  );
});

test('prepared checkout excludes framework-owned skills without hiding project changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-broker-prepare-'));
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  const workspaceRoot = path.join(root, 'workspaces');
  const workDir = path.join(workspaceRoot, 'ticket');
  fs.mkdirSync(seed, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: seed });
  fs.writeFileSync(path.join(seed, 'README.md'), '# fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: seed });
  execFileSync('git', ['checkout', '-b', 'task-123'], { cwd: seed });
  fs.writeFileSync(path.join(seed, 'remote-work.txt'), 'published by an earlier run\n', 'utf8');
  execFileSync('git', ['add', 'remote-work.txt'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'remote task work'], { cwd: seed });
  execFileSync('git', ['checkout', 'main'], { cwd: seed });
  execFileSync('git', ['clone', '--bare', seed, remote], { cwd: root });

  // Replace only broker-private network reads with a local fixture. All other
  // Git commands execute unchanged, including clone/export/checkout/status.
  const execFileImpl = async (command, inputArgs, options) => {
    const args = [...inputArgs];
    const privateBareCommand = args.some((arg) => String(arg).startsWith('--git-dir='));
    if (args.includes('ls-remote') || (privateBareCommand && args.includes('fetch'))) {
      const origin = args.indexOf('origin');
      if (origin >= 0) args[origin] = remote;
    }
    return execFileP(command, args, options);
  };
  const broker = new RepositoryBroker({
    provider: 'github',
    repository: {
      provider: 'github',
      owner: 'acme',
      name: 'widgets',
      fullName: 'acme/widgets',
      https: 'https://github.com/acme/widgets.git',
    },
    workspaceRoot,
    workDir,
    branch: 'task-123',
    execFileImpl,
  });
  t.after(() => {
    broker.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await broker.prepare();
  assert.equal(fs.readFileSync(path.join(workDir, 'remote-work.txt'), 'utf8'), 'published by an earlier run\n');
  fs.mkdirSync(path.join(workDir, '.agent-skills'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.agent-skills', 'SKILL.md'), 'framework data\n', 'utf8');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: workDir, encoding: 'utf8' }), '');

  fs.writeFileSync(path.join(workDir, 'project-change.txt'), 'must remain visible\n', 'utf8');
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: workDir, encoding: 'utf8' }), /project-change\.txt/);
});

test('GitHub review creation uses the official API and a server-scoped branch', async (t) => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'GET' && url.includes('/pulls?')) return response(200, []);
    if (options.method === 'POST' && url.endsWith('/pulls')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(
        { head: body.head, base: body.base, draft: body.draft },
        { head: 'task-123', base: 'main', draft: false }
      );
      return response(201, {
        number: 17,
        html_url: 'https://github.com/acme/widgets/pull/17',
        state: 'open',
        title: body.title,
        head: { ref: 'task-123', sha: SHA },
        base: { ref: 'main' },
      });
    }
    if (options.method === 'POST' && url.endsWith('/issues/17/labels')) return response(200, {});
    return response(500, { message: 'unexpected request' });
  };
  const { broker, token } = createScope(t, { fetchImpl });
  const tool = broker.createTool();
  const output = JSON.parse(await tool.invoke({ action: 'open_review', title: 'Fix widgets', body: 'Validated.' }));

  assert.equal(output.ok, true);
  assert.equal(output.url, 'https://github.com/acme/widgets/pull/17');
  assert.ok(requests.every(({ url }) => url.startsWith('https://api.github.com/repos/acme/widgets/')));
  assert.ok(requests.every(({ options }) => options.redirect === 'error'));
  assert.ok(requests.every(({ options }) => options.headers.Authorization === `Bearer ${token}`));
  assert.ok(requests.every(({ options }) => options.headers['X-GitHub-Api-Version'] === '2022-11-28'));
  await assert.rejects(() => tool.invoke({ action: 'push', branch: 'another-branch' }));
});

test('existing GitHub review is reused only after reapplying the required label', async (t) => {
  let labelCalls = 0;
  const existing = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'open',
    title: 'Fix widgets',
    labels: [],
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) return response(200, [existing]);
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, existing);
    if (options.method === 'POST' && url.endsWith('/issues/17/labels')) {
      labelCalls += 1;
      return response(200, { labels: [{ name: 'techsymphony' }] });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, { fetchImpl });
  const result = await broker.execute({ action: 'open_review', title: 'Fix widgets' });

  assert.equal(result.reused, true);
  assert.equal(result.labelApplied, true);
  assert.equal(labelCalls, 1);
});

test('a terminal review is recovered on a deterministic fresh server-scoped retry branch', async (t) => {
  const closed = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'closed',
    title: 'Old attempt',
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  const createdHeads = [];
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) {
      const head = new URL(url).searchParams.get('head');
      return response(200, head === 'acme:task-123' ? [closed] : []);
    }
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, { ...closed, merged: false });
    if (options.method === 'POST' && url.endsWith('/pulls')) {
      const body = JSON.parse(options.body);
      createdHeads.push(body.head);
      return response(201, {
        number: 18,
        html_url: 'https://github.com/acme/widgets/pull/18',
        state: 'open',
        title: body.title,
        head: { ref: body.head, sha: SHA },
        base: { ref: body.base },
      });
    }
    if (options.method === 'POST' && url.endsWith('/issues/18/labels')) return response(200, {});
    return response(500, { message: 'unexpected request' });
  };
  const { broker, gitCalls } = createScope(t, { fetchImpl });
  const result = await broker.execute({ action: 'open_review', title: 'Retry widgets' });

  assert.equal(result.state, 'open');
  assert.deepEqual(createdHeads, ['task-123-retry-17']);
  assert.equal(broker.publicInfo().branch, 'task-123-retry-17');
  const checkout = gitCalls.find((call) => {
    const index = call.args.indexOf('checkout');
    return index >= 0 && call.args[index + 1] === '-b';
  });
  assert.equal(checkout.args[checkout.args.indexOf('checkout') + 2], 'task-123-retry-17');
  const push = gitCalls.find((call) => call.args.includes('refs/heads/task-123-retry-17:refs/heads/task-123-retry-17'));
  assert.ok(push, 'the derived retry branch must be published with a fixed non-force refspec');
  assert.equal(gitCalls.some((call) => call.args.some((arg) => String(arg).includes('--force'))), false);
});

test('a fresh broker run resumes the matching open retry review instead of creating retry-2', async (t) => {
  const retrySha = '89abcdef0123456789abcdef0123456789abcdef';
  const closed = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'closed',
    title: 'Old attempt',
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  const retry = {
    number: 18,
    html_url: 'https://github.com/acme/widgets/pull/18',
    state: 'open',
    title: 'Retry widgets',
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123-retry-17', sha: retrySha },
    base: { ref: 'main' },
  };
  let createCalls = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) {
      const head = new URL(url).searchParams.get('head');
      if (head === 'acme:task-123') return response(200, [closed]);
      if (head === 'acme:task-123-retry-17') return response(200, [retry]);
      return response(200, []);
    }
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, { ...closed, merged: false });
    if (options.method === 'GET' && url.endsWith('/pulls/18')) return response(200, retry);
    if (options.method === 'POST' && url.endsWith('/issues/18/labels')) return response(200, {});
    if (options.method === 'POST' && url.endsWith('/pulls')) {
      createCalls += 1;
      return response(500, { message: 'duplicate review must not be created' });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, {
    fetchImpl,
    remoteBranchNames: ['task-123-retry-17'],
    branchShas: { 'task-123-retry-17': retrySha },
  });
  const result = await broker.execute({ action: 'open_review', title: 'Retry widgets' });

  assert.equal(result.reused, true);
  assert.equal(result.resumed, true);
  assert.equal(result.id, 18);
  assert.equal(result.branch, 'task-123-retry-17');
  assert.equal(broker.publicInfo().branch, 'task-123-retry-17');
  assert.equal(createCalls, 0);
});

test('new committed work on the original branch is preserved on a fresh retry instead of being switched away', async (t) => {
  const newSha = 'abcdef0123456789abcdef0123456789abcdef01';
  const retrySha = '89abcdef0123456789abcdef0123456789abcdef';
  const closed = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'closed',
    title: 'Old attempt',
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  const retry = {
    number: 18,
    html_url: 'https://github.com/acme/widgets/pull/18',
    state: 'open',
    title: 'Existing retry',
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123-retry-17', sha: retrySha },
    base: { ref: 'main' },
  };
  const createdHeads = [];
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) {
      const head = new URL(url).searchParams.get('head');
      if (head === 'acme:task-123') return response(200, [closed]);
      if (head === 'acme:task-123-retry-17') return response(200, [retry]);
      return response(200, []);
    }
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, { ...closed, merged: false });
    if (options.method === 'GET' && url.endsWith('/pulls/18')) return response(200, retry);
    if (options.method === 'POST' && url.endsWith('/pulls')) {
      const body = JSON.parse(options.body);
      createdHeads.push(body.head);
      return response(201, {
        number: 19,
        html_url: 'https://github.com/acme/widgets/pull/19',
        state: 'open',
        title: body.title,
        head: { ref: body.head, sha: newSha },
        base: { ref: body.base },
      });
    }
    if (options.method === 'POST' && url.endsWith('/issues/19/labels')) return response(200, {});
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, {
    fetchImpl,
    headSha: newSha,
    treeMatchesBase: false,
    remoteBranchNames: ['task-123-retry-17'],
    branchShas: { 'task-123-retry-17': retrySha },
  });
  const result = await broker.execute({ action: 'open_review', title: 'Preserve new work' });

  assert.equal(result.reused, false);
  assert.deepEqual(createdHeads, ['task-123-retry-17-2']);
  assert.equal(result.branch, 'task-123-retry-17-2');
  assert.equal(result.headSha, newSha);
});

test('an already-merged review with no new local work is reused without opening a duplicate', async (t) => {
  const listed = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'closed',
    title: 'Completed widgets',
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  let createCalls = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) return response(200, [listed]);
    if (options.method === 'GET' && url.endsWith('/pulls/17')) {
      return response(200, { ...listed, merged: true, merged_at: '2026-07-16T08:00:00Z' });
    }
    if (options.method === 'POST' && url.endsWith('/issues/17/labels')) return response(200, {});
    if (options.method === 'POST' && url.endsWith('/pulls')) {
      createCalls += 1;
      return response(500, { message: 'duplicate review must not be created' });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker, gitCalls } = createScope(t, { fetchImpl });
  const result = await broker.execute({ action: 'open_review', title: 'Completed widgets' });

  assert.equal(result.state, 'merged');
  assert.equal(result.reused, true);
  assert.equal(result.alreadyMerged, true);
  assert.equal(result.url, listed.html_url);
  assert.equal(createCalls, 0);
  assert.equal(broker.publicInfo().branch, 'task-123');
  assert.equal(gitCalls.some((call) => call.args.includes('checkout')), false);
});

test('an already-merged review with new effective local work rotates to a retry branch', async (t) => {
  const newSha = 'abcdef0123456789abcdef0123456789abcdef01';
  const merged = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'closed',
    merged: true,
    title: 'Completed widgets',
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  const createdHeads = [];
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) {
      const head = new URL(url).searchParams.get('head');
      return response(200, head === 'acme:task-123' ? [merged] : []);
    }
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, merged);
    if (options.method === 'POST' && url.endsWith('/pulls')) {
      const body = JSON.parse(options.body);
      createdHeads.push(body.head);
      return response(201, {
        number: 18,
        html_url: 'https://github.com/acme/widgets/pull/18',
        state: 'open',
        title: body.title,
        head: { ref: body.head, sha: newSha },
        base: { ref: body.base },
      });
    }
    if (options.method === 'POST' && url.endsWith('/issues/18/labels')) return response(200, {});
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, { fetchImpl, headSha: newSha, treeMatchesBase: false });
  const result = await broker.execute({ action: 'open_review', title: 'More widget work' });

  assert.equal(result.state, 'open');
  assert.deepEqual(createdHeads, ['task-123-retry-17']);
  assert.equal(broker.publicInfo().branch, 'task-123-retry-17');
});

test('review status exposes every feedback item through bounded cursor windows', async (t) => {
  const review = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'open',
    title: 'Fix widgets',
    mergeable: true,
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  const comments = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    body: `feedback ${index + 1}`,
    user: { login: 'reviewer' },
    html_url: `https://github.com/comment/${index + 1}`,
  }));
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) return response(200, [review]);
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, review);
    if (options.method === 'GET' && url.includes('/check-runs?')) {
      return response(200, { total_count: 0, check_runs: [] });
    }
    if (options.method === 'GET' && url.includes('/status?')) {
      return response(200, { total_count: 0, state: 'success', statuses: [] });
    }
    if (options.method === 'GET' && url.includes('/issues/17/comments?')) return response(200, comments);
    if (options.method === 'GET' && /\/pulls\/17\/(reviews|comments)\?/.test(url)) return response(200, []);
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, { fetchImpl });
  const first = await broker.execute({ action: 'review_status', cursor: 0 });
  const second = await broker.execute({ action: 'review_status', cursor: first.nextFeedbackCursor });

  assert.equal(first.feedbackTotal, 25);
  assert.equal(first.feedback.length, 20);
  assert.equal(first.nextFeedbackCursor, 20);
  assert.equal(first.feedbackReadComplete, false);
  assert.equal(second.feedback.length, 5);
  assert.equal(second.nextFeedbackCursor, null);
  assert.equal(second.feedbackReadComplete, true);
  assert.equal(second.feedback[0].body, 'feedback 21');
});

test('GitHub merge requires every feedback cursor window to be consumed in this broker run', async (t) => {
  const review = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'open',
    title: 'Fix widgets',
    mergeable: true,
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  const comments = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    body: `feedback ${index + 1}`,
    user: { login: 'reviewer' },
  }));
  let mergeCalls = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) return response(200, [review]);
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, review);
    if (options.method === 'GET' && url.includes('/check-runs?')) {
      return response(200, { total_count: 0, check_runs: [] });
    }
    if (options.method === 'GET' && url.includes('/status?')) {
      return response(200, { total_count: 0, state: 'success', statuses: [] });
    }
    if (options.method === 'GET' && url.includes('/issues/17/comments?')) return response(200, comments);
    if (options.method === 'GET' && /\/pulls\/17\/(reviews|comments)\?/.test(url)) return response(200, []);
    if (options.method === 'PUT' && url.endsWith('/pulls/17/merge')) {
      mergeCalls += 1;
      return response(200, { merged: true, sha: SHA, message: 'merged' });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, { fetchImpl });
  const outOfOrder = await broker.execute({ action: 'review_status', cursor: 20 });
  assert.equal(outOfOrder.feedbackReadComplete, false);
  assert.equal(outOfOrder.expectedFeedbackCursor, 0);

  await assert.rejects(
    () => broker.execute({ action: 'merge_review' }),
    (error) => error && error.code === 'feedback_unread'
  );
  assert.equal(mergeCalls, 0);

  const first = await broker.execute({ action: 'review_status', cursor: 0 });
  assert.equal(first.feedbackReadComplete, false);
  assert.equal(first.expectedFeedbackCursor, 20);
  await assert.rejects(
    () => broker.execute({ action: 'merge_review' }),
    (error) => error && error.code === 'feedback_unread'
  );
  assert.equal(mergeCalls, 0);

  const final = await broker.execute({ action: 'review_status', cursor: first.nextFeedbackCursor });
  assert.equal(final.feedbackReadComplete, true);
  const merged = await broker.execute({ action: 'merge_review' });
  assert.equal(merged.merged, true);
  assert.equal(mergeCalls, 1);
});

test('GitHub merge requires an explicit public status read even for one feedback page', async (t) => {
  const review = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'open',
    title: 'Fix widgets',
    mergeable: true,
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  const comment = { id: 1, body: 'Please verify the edge case.', user: { login: 'reviewer' } };
  let mergeCalls = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) return response(200, [review]);
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, review);
    if (options.method === 'GET' && url.includes('/check-runs?')) {
      return response(200, { total_count: 0, check_runs: [] });
    }
    if (options.method === 'GET' && url.includes('/status?')) {
      return response(200, { total_count: 0, state: 'success', statuses: [] });
    }
    if (options.method === 'GET' && url.includes('/issues/17/comments?')) return response(200, [comment]);
    if (options.method === 'GET' && /\/pulls\/17\/(reviews|comments)\?/.test(url)) return response(200, []);
    if (options.method === 'PUT' && url.endsWith('/pulls/17/merge')) {
      mergeCalls += 1;
      return response(200, { merged: true, sha: SHA, message: 'merged' });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, { fetchImpl });

  await assert.rejects(
    () => broker.execute({ action: 'merge_review' }),
    (error) => error && error.code === 'feedback_unread'
  );
  assert.equal(mergeCalls, 0);

  const status = await broker.execute({ action: 'review_status', cursor: 0 });
  assert.equal(status.feedbackReadComplete, true);
  const merged = await broker.execute({ action: 'merge_review' });
  assert.equal(merged.merged, true);
  assert.equal(mergeCalls, 1);
});

test('merge fails closed when provider detail retargets the review outside the scoped base', async (t) => {
  const listed = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'open',
    title: 'Fix widgets',
    mergeable: true,
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  let mergeCalled = false;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) return response(200, [listed]);
    if (options.method === 'GET' && url.endsWith('/pulls/17')) {
      return response(200, { ...listed, base: { ref: 'release' } });
    }
    if (options.method === 'PUT') {
      mergeCalled = true;
      return response(200, { merged: true, sha: SHA });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, { fetchImpl });

  await assert.rejects(
    () => broker.execute({ action: 'merge_review' }),
    (error) => error && error.code === 'review_scope'
  );
  assert.equal(mergeCalled, false);
});

test('merge is blocked when the scoped workspace has uncommitted changes', async (t) => {
  const review = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'open',
    title: 'Fix widgets',
    mergeable: true,
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  let mergeCalled = false;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) return response(200, [review]);
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, review);
    if (options.method === 'GET' && url.includes('/check-runs?')) {
      return response(200, { total_count: 0, check_runs: [] });
    }
    if (options.method === 'GET' && url.includes('/status?')) {
      return response(200, { total_count: 0, state: 'success', statuses: [] });
    }
    if (options.method === 'GET' && /\/(reviews|comments)\?/.test(url)) return response(200, []);
    if (options.method === 'PUT') {
      mergeCalled = true;
      return response(200, { merged: true, sha: SHA });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, { fetchImpl, statusOutput: ' M src/index.js' });

  await assert.rejects(
    () => broker.execute({ action: 'merge_review' }),
    (error) => error && error.code === 'workspace_dirty'
  );
  assert.equal(mergeCalled, false);
});

test('GitHub merge blocks startup-failed and truncated check results', async (t) => {
  const review = {
    number: 17,
    html_url: 'https://github.com/acme/widgets/pull/17',
    state: 'open',
    title: 'Fix widgets',
    mergeable: true,
    labels: [{ name: 'techsymphony' }],
    head: { ref: 'task-123', sha: SHA },
    base: { ref: 'main' },
  };
  let mergeCalled = false;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?')) return response(200, [review]);
    if (options.method === 'GET' && url.endsWith('/pulls/17')) return response(200, review);
    if (options.method === 'GET' && url.includes('/check-runs?')) {
      return response(200, {
        total_count: 101,
        check_runs: [{ name: 'build', status: 'completed', conclusion: 'startup_failure' }],
      });
    }
    if (options.method === 'GET' && url.includes('/status?')) {
      return response(200, { total_count: 0, state: 'success', statuses: [] });
    }
    if (options.method === 'GET' && /\/(reviews|comments)\?/.test(url)) return response(200, []);
    if (options.method === 'PUT') {
      mergeCalled = true;
      return response(200, { merged: true, sha: SHA });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, { fetchImpl });
  await assert.rejects(
    () => broker.execute({ action: 'merge_review' }),
    (error) => error && error.code === 'review_blocked'
  );
  assert.equal(mergeCalled, false);
});

test('GitLab status and merge use official project-scoped APIs without gh/glab', async (t) => {
  const requests = [];
  const mr = {
    iid: 9,
    web_url: 'https://gitlab.com/acme/platform/widgets/-/merge_requests/9',
    state: 'opened',
    title: 'Fix widgets',
    source_branch: 'task-123',
    target_branch: 'main',
    sha: SHA,
    detailed_merge_status: 'mergeable',
    labels: ['techsymphony'],
    blocking_discussions_resolved: true,
    head_pipeline: { id: 4, sha: SHA, status: 'success', web_url: 'https://gitlab.com/pipeline/4' },
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'GET' && url.includes('/merge_requests?')) return response(200, [mr]);
    if (options.method === 'GET' && url.includes('/merge_requests/9?')) return response(200, mr);
    if (options.method === 'GET' && url.includes('/merge_requests/9/pipelines?')) return response(200, [mr.head_pipeline]);
    if (options.method === 'GET' && url.includes('/merge_requests/9/discussions?')) return response(200, []);
    if (options.method === 'PUT' && url.endsWith('/merge_requests/9/merge')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(
        { sha: body.sha, squash: body.squash, should_remove_source_branch: body.should_remove_source_branch },
        { sha: SHA, squash: true, should_remove_source_branch: true }
      );
      return response(200, { ...mr, state: 'merged', squash_commit_sha: SHA });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker, token } = createScope(t, { provider: 'gitlab', fetchImpl });
  const output = await broker.execute({ action: 'merge_review' });

  assert.equal(output.merged, true);
  assert.equal(output.provider, 'gitlab');
  assert.ok(requests.every(({ url }) =>
    url.startsWith('https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fwidgets/')));
  assert.ok(requests.every(({ options }) => options.headers['PRIVATE-TOKEN'] === token));
  assert.ok(requests.every(({ options }) => options.redirect === 'error'));
  assert.equal(requests.some(({ url }) => /api\.github|\/gh\b|\/glab\b/.test(url)), false);
});

test('GitLab merge blocks manual or stale-head pipelines', async (t) => {
  const staleSha = 'abcdef0123456789abcdef0123456789abcdef01';
  const mr = {
    iid: 9,
    web_url: 'https://gitlab.com/acme/platform/widgets/-/merge_requests/9',
    state: 'opened',
    title: 'Fix widgets',
    source_branch: 'task-123',
    target_branch: 'main',
    sha: SHA,
    detailed_merge_status: 'mergeable',
    labels: ['techsymphony'],
    blocking_discussions_resolved: true,
    head_pipeline: { id: 3, sha: staleSha, status: 'success' },
  };
  let mergeCalled = false;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET' && url.includes('/merge_requests?')) return response(200, [mr]);
    if (options.method === 'GET' && url.includes('/merge_requests/9?')) return response(200, mr);
    if (options.method === 'GET' && url.includes('/pipelines?')) {
      return response(200, [{ id: 4, sha: SHA, status: 'manual' }, mr.head_pipeline]);
    }
    if (options.method === 'GET' && url.includes('/discussions?')) return response(200, []);
    if (options.method === 'PUT') {
      mergeCalled = true;
      return response(200, { ...mr, state: 'merged' });
    }
    return response(500, { message: 'unexpected request' });
  };
  const { broker } = createScope(t, { provider: 'gitlab', fetchImpl });
  await assert.rejects(
    () => broker.execute({ action: 'merge_review' }),
    (error) => error && error.code === 'review_blocked'
  );
  assert.equal(mergeCalled, false);
});

test('tool-facing provider errors are redacted', async (t) => {
  const token = 'token-that-must-not-leak';
  const fetchImpl = async () => response(401, { message: `bad credential ${token}` });
  const { broker } = createScope(t, { token, fetchImpl });
  const output = await broker.createTool().invoke({ action: 'review_status' });

  assert.doesNotMatch(output, new RegExp(token));
  assert.match(output, /\*\*\*/);
  assert.equal(broker.availabilityError().code, 'provider_error');
  assert.doesNotMatch(broker.availabilityError().message, new RegExp(token));
});

test('ordinary review workflow errors are not reported as repository outages', async (t) => {
  const { broker } = createScope(t, { fetchImpl: async () => response(200, []) });
  const output = await broker.createTool().invoke({ action: 'merge_review' });

  assert.match(output, /review_missing/);
  assert.equal(broker.availabilityError(), null);
});
