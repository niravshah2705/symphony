'use strict';

const fs = require('fs');
const path = require('path');
const { execTool, resolveWorkdir, commandExists, platformCmd, defineTool } = require('./exec');

/**
 * Quality tools — lint/format and run tests by delegating to the project's own
 * linters and test runners (ESLint, Prettier, Ruff, Black, npm test, pytest,
 * Gradle, Go, Cargo, Maven). Detection is by project files; no runner logic is
 * re-implemented.
 */

const anyFile = (dir, names) => names.some((n) => fs.existsSync(path.join(dir, n)));

/** Choose a linter/formatter for a directory. */
async function pickLinter(dir, mode, requested) {
  const fix = mode === 'fix';
  const linters = {
    eslint: { command: platformCmd('npx'), args: ['--no-install', 'eslint', '.', ...(fix ? ['--fix'] : [])], hint: 'Add ESLint to the project (npm i -D eslint).' },
    prettier: { command: platformCmd('npx'), args: ['--no-install', 'prettier', fix ? '--write' : '--check', '.'], hint: 'Add Prettier (npm i -D prettier).' },
    ruff: { command: 'ruff', args: fix ? ['check', '--fix', '.'] : ['check', '.'], hint: 'pip install ruff.' },
    black: { command: 'black', args: fix ? ['.'] : ['--check', '.'], hint: 'pip install black.' },
  };
  if (requested && requested !== 'auto') return { key: requested, ...linters[requested] };
  if (anyFile(dir, ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.mjs'])) return { key: 'eslint', ...linters.eslint };
  if (anyFile(dir, ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js']) || fs.existsSync(path.join(dir, 'package.json'))) return { key: 'prettier', ...linters.prettier };
  if (anyFile(dir, ['pyproject.toml', 'ruff.toml', '.ruff.toml']) && (await commandExists('ruff'))) return { key: 'ruff', ...linters.ruff };
  if (anyFile(dir, ['pyproject.toml', 'setup.py', 'requirements.txt'])) return { key: 'black', ...linters.black };
  return { key: 'prettier', ...linters.prettier };
}

/** Choose a test runner (pure). */
function pickTestRunner(dir, requested) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const readPkg = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch (_) {
      return null;
    }
  };
  const runners = {
    npm: () => ({ command: platformCmd('npm'), args: ['test'], hint: 'Install Node.js (bundles npm).' }),
    pytest: () => ({ command: 'pytest', args: ['-q'], hint: 'pip install pytest.' }),
    gradle: () => ({ command: process.platform === 'win32' ? 'gradlew.bat' : './gradlew', args: ['test'], hint: 'Use the Gradle wrapper (gradlew).' }),
    maven: () => ({ command: has('mvnw') ? (process.platform === 'win32' ? 'mvnw.cmd' : './mvnw') : 'mvn', args: ['-q', 'test'], hint: 'Use the Maven wrapper (mvnw) or install Maven.' }),
    go: () => ({ command: 'go', args: ['test', './...'], hint: 'Install Go.' }),
    cargo: () => ({ command: 'cargo', args: ['test'], hint: 'Install the Rust toolchain (rustup).' }),
  };
  if (requested && requested !== 'auto' && runners[requested]) return { key: requested, ...runners[requested]() };
  const pkg = readPkg();
  if (pkg && pkg.scripts && pkg.scripts.test) return { key: 'npm', ...runners.npm() };
  if (has('pytest.ini') || has('tox.ini') || has('pyproject.toml') || has('setup.py')) return { key: 'pytest', ...runners.pytest() };
  if (has('gradlew') || has('build.gradle') || has('build.gradle.kts')) return { key: 'gradle', ...runners.gradle() };
  if (has('pom.xml')) return { key: 'maven', ...runners.maven() };
  if (has('go.mod')) return { key: 'go', ...runners.go() };
  if (has('Cargo.toml')) return { key: 'cargo', ...runners.cargo() };
  return null;
}

const lintFormatTool = defineTool(
  {
    name: 'lint_format',
    description:
      'Lint and/or format the workspace using the project\'s configured tools (ESLint, Prettier, Ruff, Black). ' +
      'mode "check" (default) reports issues; mode "fix" applies safe autofixes. Prefer this over manual formatting.',
    schema: (z) =>
      z.object({
        dir: z.string().optional().describe('workspace-relative directory'),
        mode: z.enum(['check', 'fix']).optional().describe('default: check'),
        tool: z.enum(['auto', 'eslint', 'prettier', 'ruff', 'black']).optional().describe('force a tool (default: auto)'),
      }),
  },
  async (input, ctx) => {
    const dir = resolveWorkdir(ctx, input.dir);
    const l = await pickLinter(dir, input.mode || 'check', input.tool);
    return execTool({ ctx, label: `lint/format (${l.key}, ${input.mode || 'check'})`, command: l.command, args: l.args, dir: input.dir, notFoundHint: l.hint });
  }
);

const testRunTool = defineTool(
  {
    name: 'test_run',
    description:
      'Run the project test suite using its native runner (npm test, pytest, Gradle, Maven, Go, Cargo), ' +
      'auto-detected from the workspace. Prefer this over guessing the test command.',
    schema: (z) =>
      z.object({
        dir: z.string().optional().describe('workspace-relative directory'),
        system: z.enum(['auto', 'npm', 'pytest', 'gradle', 'maven', 'go', 'cargo']).optional().describe('force a runner (default: auto)'),
      }),
  },
  async (input, ctx) => {
    const dir = resolveWorkdir(ctx, input.dir);
    const r = pickTestRunner(dir, input.system);
    if (!r) return `No known test runner detected in ${dir} (looked for npm test / pytest / Gradle / Maven / Go / Cargo).`;
    return execTool({ ctx, label: `tests (${r.key})`, command: r.command, args: r.args, dir: input.dir, notFoundHint: r.hint });
  }
);

const FACTORIES = Object.freeze({ lint_format: lintFormatTool, test_run: testRunTool });

module.exports = { FACTORIES, pickLinter, pickTestRunner };
