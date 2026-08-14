'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const checksScript = path.join(repoRoot, 'scripts', 'run-checks.sh');
const releaseScript = path.join(repoRoot, 'scripts', 'release-cli.sh');

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function run(filePath, args = [], options = {}) {
  return spawnSync('/bin/bash', [filePath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeFakeTools(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fleet-script-tools-'));
  const binDir = path.join(tempRoot, 'bin');
  const commandLog = path.join(tempRoot, 'commands.log');
  const venvPython = path.join(tempRoot, 'venv-python');
  fs.mkdirSync(binDir);
  fs.writeFileSync(commandLog, '');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  writeExecutable(venvPython, `#!/bin/sh
printf 'venv-python|%s|%s\\n' "$PWD" "$*" >> "$COMMAND_LOG"
exit 0
`);

  writeExecutable(path.join(binDir, 'node'), `#!/bin/sh
printf 'node|%s|%s\\n' "$PWD" "$*" >> "$COMMAND_LOG"
if [ "\${1:-}" = "--version" ]; then
  printf 'v22.14.0\\n'
  exit 0
fi
if [ "\${1:-}" = "--test" ]; then
  exit 0
fi
exec ${shellQuote(process.execPath)} "$@"
`);

  writeExecutable(path.join(binDir, 'npm'), `#!/bin/sh
printf 'npm|%s|%s\\n' "$PWD" "$*" >> "$COMMAND_LOG"
printf 'npm-token|%s\\n' "\${GH_TOKEN:-}" >> "$COMMAND_LOG"
if [ "\${1:-}" = "pack" ]; then
  destination=''
  previous=''
  for argument in "$@"; do
    if [ "$previous" = "--pack-destination" ]; then
      destination=$argument
    fi
    previous=$argument
  done
  [ -n "$destination" ] || exit 31
  mkdir -p "$destination"
  printf 'fake npm tarball\\n' > "$destination/ai-fleet-cli-1.2.3.tgz"
fi
exit 0
`);

  writeExecutable(path.join(binDir, 'npx'), `#!/bin/sh
printf 'npx|%s|%s\\n' "$PWD" "$*" >> "$COMMAND_LOG"
printf 'npx-token|%s\\n' "\${GH_TOKEN:-}" >> "$COMMAND_LOG"
outfile=''
for argument in "$@"; do
  case "$argument" in
    --outfile=*) outfile=\${argument#--outfile=} ;;
  esac
done
if [ -n "$outfile" ]; then
  mkdir -p "$(dirname "$outfile")"
  printf '%s\\n' '#!/usr/bin/env node' "if (process.argv.includes('--help')) console.log('adlc help');" > "$outfile"
fi
exit 0
`);

  writeExecutable(path.join(binDir, 'python3.12'), `#!/bin/sh
printf 'python3.12|%s|%s\\n' "$PWD" "$*" >> "$COMMAND_LOG"
if [ "\${1:-}" = "--version" ]; then
  printf 'Python 3.12.8\\n'
  exit 0
fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "venv" ]; then
  mkdir -p "$3/bin"
  cp "$VENV_PYTHON" "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
fi
exit 32
`);

  writeExecutable(path.join(binDir, 'gh'), `#!/bin/sh
printf 'gh|%s|%s\\n' "$PWD" "$*" >> "$COMMAND_LOG"
printf 'gh-token|%s\\n' "\${GH_TOKEN:-}" >> "$COMMAND_LOG"
printf 'gh-repo-env|%s\\n' "\${GH_REPO:-}" >> "$COMMAND_LOG"
case "$*" in
  *'/git/matching-refs/tags/'*)
    if [ -n "\${FAKE_REMOTE_TAG_SHA:-}" ]; then
      printf 'refs/tags/adlc-v1.2.3\\n'
    fi
    ;;
  *'/commits/adlc-v1.2.3'*)
    printf '%s\\n' "\${FAKE_REMOTE_TAG_SHA:-}"
    ;;
esac
exit 0
`);

  writeExecutable(path.join(binDir, 'uname'), `#!/bin/sh
printf '%s\\n' "\${FAKE_UNAME:-Darwin}"
`);

  return {
    commandLog,
    env: {
      COMMAND_LOG: commandLog,
      VENV_PYTHON: venvPython,
      FAKE_REMOTE_TAG_SHA: '',
      PATH: `${binDir}:${process.env.PATH}`,
    },
    readLog() {
      return fs.readFileSync(commandLog, 'utf8');
    },
  };
}

function makeReleaseRepo(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adlc-release-repo-'));
  const scriptDir = path.join(fixtureRoot, 'scripts');
  const cliDir = path.join(fixtureRoot, 'packages', 'cli');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(path.join(cliDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(cliDir, 'src'), { recursive: true });
  fs.copyFileSync(releaseScript, path.join(scriptDir, 'release-cli.sh'));
  fs.chmodSync(path.join(scriptDir, 'release-cli.sh'), 0o755);
  fs.writeFileSync(path.join(fixtureRoot, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
    name: 'release-fixture',
    private: true,
    workspaces: ['packages/*'],
  }));
  fs.writeFileSync(path.join(fixtureRoot, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(cliDir, 'package.json'), JSON.stringify({
    name: '@ai-fleet/cli',
    version: '1.0.0',
  }));
  fs.writeFileSync(path.join(cliDir, 'bin', 'adlc.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(cliDir, 'src', 'cli.test.js'), "'use strict';\n");

  runGit(fixtureRoot, ['init', '-q']);
  runGit(fixtureRoot, ['config', 'user.email', 'tests@example.invalid']);
  runGit(fixtureRoot, ['config', 'user.name', 'Script Tests']);
  runGit(fixtureRoot, ['add', '.']);
  runGit(fixtureRoot, ['commit', '-qm', 'fixture']);
  runGit(fixtureRoot, ['remote', 'add', 'origin', 'https://github.com/ai-fleet-tests/release-fixture.git']);
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  return {
    fixtureRoot,
    script: path.join(scriptDir, 'release-cli.sh'),
    head: runGit(fixtureRoot, ['rev-parse', 'HEAD']),
    repository: 'github.com/ai-fleet-tests/release-fixture',
  };
}

test('run-checks validates suite names before invoking tools', () => {
  const result = run(checksScript, ['--suite', 'unknown']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid suite 'unknown'/);
});

test('run-checks dispatches each suite to the matching local commands', async (t) => {
  const tools = makeFakeTools(t);
  const expectations = {
    node: [/npm\|.*\|ci/, /node\|.*\|--test packages\/shared-core\/src\/\*\*\/\*\.test\.js/],
    e2e: [/npm\|.*\|ci/, /npx\|.*\|playwright install chrome/, /npm\|.*\|run test:e2e/],
    org: [/python3\.12\|.*\|-m venv /, /venv-python\|.*services\/org\|-m pytest -q -p no:cacheprovider/],
    settings: [/python3\.12\|.*\|-m venv /, /venv-python\|.*services\/settings\|-m pytest -q -p no:cacheprovider/],
  };

  for (const [suite, patterns] of Object.entries(expectations)) {
    fs.writeFileSync(tools.commandLog, '');
    const result = run(checksScript, ['--suite', suite], { env: tools.env });
    assert.equal(result.status, 0, `${suite}: ${result.stderr}`);
    const log = tools.readLog();
    for (const pattern of patterns) assert.match(log, pattern, suite);
  }
});

test('run-checks all installs Node dependencies once and runs every suite', (t) => {
  const tools = makeFakeTools(t);
  const result = run(checksScript, ['--suite=all'], { env: tools.env });
  assert.equal(result.status, 0, result.stderr);
  const log = tools.readLog();
  assert.equal((log.match(/npm\|.*\|ci$/gm) || []).length, 1);
  assert.match(log, /node\|.*\|--test packages\/shared-core\/src\/\*\*\/\*\.test\.js/);
  assert.match(log, /npx\|.*\|playwright install chrome/);
  assert.match(log, /services\/org\|-m pytest/);
  assert.match(log, /services\/settings\|-m pytest/);
});

test('run-checks installs Playwright system dependencies on Linux', (t) => {
  const tools = makeFakeTools(t);
  const result = run(checksScript, ['--suite', 'e2e'], {
    env: { ...tools.env, FAKE_UNAME: 'Linux' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(tools.readLog(), /npx\|.*\|playwright install --with-deps chrome/);
});

test('run-checks node suite excludes ignored third-party test payloads', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fleet-checks-fixture-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'registry-bundle-out'), { recursive: true });
  fs.copyFileSync(checksScript, path.join(fixture, 'scripts', 'run-checks.sh'));
  fs.chmodSync(path.join(fixture, 'scripts', 'run-checks.sh'), 0o755);
  fs.writeFileSync(path.join(fixture, 'registry-bundle-out', 'sentinel.test.js'), 'throw new Error("must not run")\n');

  const tools = makeFakeTools(t);
  const result = run(path.join(fixture, 'scripts', 'run-checks.sh'), ['--suite', 'node'], {
    cwd: fixture,
    env: tools.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const log = tools.readLog();
  assert.match(log, /node\|.*\|--test packages\/shared-core\/src\/\*\*\/\*\.test\.js/);
  assert.match(log, /services\/provisioner\/src\/\*\*\/\*\.test\.js/);
  assert.match(log, /scripts\/\*\.test\.js/);
  assert.doesNotMatch(log, /registry-bundle-out|sentinel/);
});

test('release-cli rejects malformed semver before doing release work', () => {
  const result = run(releaseScript, ['--version', '01.2.3']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid semver/);
});

test('release-cli requires a clean committed worktree', (t) => {
  const fixture = makeReleaseRepo(t);
  fs.writeFileSync(path.join(fixture.fixtureRoot, 'dirty.txt'), 'dirty\n');
  const result = run(fixture.script, ['--version', '1.2.3', '--dry-run'], {
    cwd: fixture.fixtureRoot,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /worktree must be clean and fully committed/);
});

test('release-cli dry-run builds staged artifacts without publishing', (t) => {
  const fixture = makeReleaseRepo(t);
  const tools = makeFakeTools(t);
  const result = run(fixture.script, ['--version', '1.2.3', '--dry-run'], {
    cwd: fixture.fixtureRoot,
    env: tools.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run complete/);

  const artifactDir = path.join(fixture.fixtureRoot, 'dist', 'adlc-v1.2.3');
  assert.ok(fs.statSync(path.join(artifactDir, 'adlc.js')).mode & 0o100);
  assert.ok(fs.existsSync(path.join(artifactDir, 'ai-fleet-cli-1.2.3.tgz')));
  const sums = fs.readFileSync(path.join(artifactDir, 'SHA256SUMS'), 'utf8');
  assert.match(sums, /adlc\.js/);
  assert.match(sums, /ai-fleet-cli-1\.2\.3\.tgz/);

  const log = tools.readLog();
  assert.match(log, /npm\|.*\|ci/);
  assert.match(log, /node\|.*\|--test packages\/cli\/src\/\*\*\/\*\.test\.js/);
  assert.match(log, /npm\|.*\|version 1\.2\.3 .* -w @ai-fleet\/cli/);
  assert.match(log, /npm\|.*\|pack -w @ai-fleet\/cli --pack-destination/);
  assert.match(log, /npx\|.*\|--yes esbuild@0\.24\.2 .*--target=node22/);
  assert.doesNotMatch(log, /^gh\|/m);
  assert.equal(runGit(fixture.fixtureRoot, ['status', '--porcelain']), '');
});

test('release-cli publishes all artifacts at the full HEAD SHA', (t) => {
  const fixture = makeReleaseRepo(t);
  const tools = makeFakeTools(t);
  const result = run(fixture.script, ['--version=1.2.3'], {
    cwd: fixture.fixtureRoot,
    env: { ...tools.env, GH_TOKEN: 'write-scoped-token' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Published GitHub release adlc-v1\.2\.3/);

  const ghLine = tools.readLog().split('\n')
    .find((line) => line.startsWith('gh|') && line.includes('|release create '));
  assert.ok(ghLine);
  assert.match(ghLine, /release create adlc-v1\.2\.3/);
  assert.match(ghLine, new RegExp(`--repo ${fixture.repository}`));
  assert.match(ghLine, new RegExp(`--target ${fixture.head}`));
  assert.match(ghLine, /adlc\.js .*ai-fleet-cli-1\.2\.3\.tgz .*SHA256SUMS/);
  assert.doesNotMatch(tools.readLog(), /^(npm|npx)-token\|write-scoped-token$/m);
  assert.match(tools.readLog(), /^gh-token\|write-scoped-token$/m);
});

test('release-cli targets its own repository when invoked from another checkout', (t) => {
  const fixture = makeReleaseRepo(t);
  const tools = makeFakeTools(t);
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'adlc-release-caller-'));
  t.after(() => fs.rmSync(caller, { recursive: true, force: true }));
  runGit(caller, ['init', '-q']);

  const result = run(fixture.script, ['--version', '1.2.3'], {
    cwd: caller,
    env: {
      ...tools.env,
      GH_TOKEN: 'write-scoped-token',
      GH_REPO: 'github.com/unrelated/wrong-repository',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const ghLine = tools.readLog().split('\n')
    .find((line) => line.startsWith('gh|') && line.includes('|release create '));
  assert.ok(ghLine);
  const canonicalRoot = fs.realpathSync(fixture.fixtureRoot);
  assert.match(ghLine, new RegExp(`^gh\\|${canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`));
  assert.match(ghLine, new RegExp(`--repo ${fixture.repository}`));
  assert.doesNotMatch(tools.readLog(), /wrong-repository/);
  assert.doesNotMatch(tools.readLog(), /^gh-repo-env\|.+$/m);
});

test('release-cli rejects an existing remote tag that points away from HEAD', (t) => {
  const fixture = makeReleaseRepo(t);
  const tools = makeFakeTools(t);
  const otherSha = 'b'.repeat(40);
  const result = run(fixture.script, ['--version', '1.2.3'], {
    cwd: fixture.fixtureRoot,
    env: {
      ...tools.env,
      GH_TOKEN: 'write-scoped-token',
      FAKE_REMOTE_TAG_SHA: otherSha,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`existing remote tag adlc-v1\\.2\\.3 points to ${otherSha}`));
  assert.match(result.stderr, new RegExp(`not release commit ${fixture.head}`));
  assert.doesNotMatch(tools.readLog(), /\|release create /);
});

test('release-cli accepts an existing remote tag only when it resolves to HEAD', (t) => {
  const fixture = makeReleaseRepo(t);
  const tools = makeFakeTools(t);
  const result = run(fixture.script, ['--version', '1.2.3'], {
    cwd: fixture.fixtureRoot,
    env: {
      ...tools.env,
      GH_TOKEN: 'write-scoped-token',
      FAKE_REMOTE_TAG_SHA: fixture.head,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`Verified existing remote tag adlc-v1\\.2\\.3 at ${fixture.head}`),
  );
  const ghLine = tools.readLog().split('\n')
    .find((line) => line.startsWith('gh|') && line.includes('|release create '));
  assert.ok(ghLine);
  assert.match(ghLine, new RegExp(`--repo ${fixture.repository}`));
});
