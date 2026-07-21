'use strict';

const fs = require('fs');
const path = require('path');
const { execTool, resolveWorkdir, runSequence, commandExists, platformCmd, defineTool } = require('./exec');

/**
 * Environment tools — create a working local dev environment by delegating to
 * the standard toolchain managers (uv / python venv, npm / pnpm / yarn, Docker
 * Compose) rather than hand-rolling setup scripts. Also scaffolds a
 * devcontainer.json so the same setup is reproducible in a container.
 */

/** Marker-file project detection for a directory (pure, side-effect free). */
function detectProjectTypes(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  return {
    node: has('package.json'),
    python: has('requirements.txt') || has('pyproject.toml') || has('Pipfile') || has('setup.py'),
    go: has('go.mod'),
    java: has('pom.xml') || has('build.gradle') || has('build.gradle.kts'),
    compose: has('docker-compose.yml') || has('docker-compose.yaml') || has('compose.yml') || has('compose.yaml'),
    android: has('gradlew') && (has('settings.gradle') || has('settings.gradle.kts')),
  };
}

/** Choose the Node package manager and install command from lockfiles present. */
function pickNodeManager(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('pnpm-lock.yaml')) return { manager: 'pnpm', args: ['install', '--frozen-lockfile'] };
  if (has('yarn.lock')) return { manager: 'yarn', args: ['install', '--frozen-lockfile'] };
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return { manager: 'npm', args: ['ci'] };
  return { manager: 'npm', args: ['install'] };
}

/** Choose the Python environment manager from the files present. */
function pickPythonManager(dir, { uvAvailable = false } = {}) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('poetry.lock')) return 'poetry';
  if (has('Pipfile')) return 'pipenv';
  if (uvAvailable) return 'uv';
  return 'venv';
}

/** Build the Node install step list. */
function nodeInstallSteps(dir) {
  const { manager, args } = pickNodeManager(dir);
  return [{ label: `${manager} install`, command: platformCmd(manager), args, notFoundHint: `Install Node.js (bundles npm) or ${manager}.` }];
}

/** Build the Python environment step list for a chosen manager. */
function pythonSteps(dir, manager) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const hasReq = has('requirements.txt');
  const hasProject = has('pyproject.toml') || has('setup.py');
  if (manager === 'poetry') return [{ label: 'poetry install', command: 'poetry', args: ['install'], notFoundHint: 'Install Poetry (https://python-poetry.org).' }];
  if (manager === 'pipenv') return [{ label: 'pipenv install', command: 'pipenv', args: ['install', '--dev'], notFoundHint: 'Install pipenv (pip install pipenv).' }];
  if (manager === 'uv') {
    const install = hasProject
      ? { label: 'uv sync', command: 'uv', args: ['sync'] }
      : { label: 'uv pip install', command: 'uv', args: ['pip', 'install', '-r', 'requirements.txt'] };
    return [{ label: 'uv venv', command: 'uv', args: ['venv'], notFoundHint: 'Install uv (https://docs.astral.sh/uv).' }, install];
  }
  // Plain venv + pip fallback.
  const pip = process.platform === 'win32' ? path.join('.venv', 'Scripts', 'pip.exe') : path.join('.venv', 'bin', 'pip');
  const install = hasReq
    ? { label: 'pip install -r requirements.txt', command: pip, args: ['install', '-r', 'requirements.txt'] }
    : { label: 'pip install -e .', command: pip, args: ['install', '-e', '.'] };
  return [
    { label: 'python -m venv .venv', command: platformCmd('python3'), args: ['-m', 'venv', '.venv'], notFoundHint: 'Install Python 3.' },
    ...(hasReq || hasProject ? [install] : []),
  ];
}

/** Render a devcontainer.json for a language preset. */
function renderDevcontainer(spec = {}) {
  const language = String(spec.language || 'generic').toLowerCase();
  const presets = {
    node: { name: 'node-dev', image: 'mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm', postCreateCommand: 'npm ci', remoteUser: 'node' },
    python: { name: 'python-dev', image: 'mcr.microsoft.com/devcontainers/python:1-3.12-bookworm', postCreateCommand: 'pip install --user -r requirements.txt', remoteUser: 'vscode' },
    go: { name: 'go-dev', image: 'mcr.microsoft.com/devcontainers/go:1-1.23-bookworm', postCreateCommand: 'go mod download', remoteUser: 'vscode' },
    java: { name: 'java-dev', image: 'mcr.microsoft.com/devcontainers/java:1-21-bookworm', postCreateCommand: './gradlew build -x test || mvn -q -DskipTests package', remoteUser: 'vscode' },
    generic: { name: 'dev', image: 'mcr.microsoft.com/devcontainers/base:bookworm', remoteUser: 'vscode' },
  };
  const config = presets[language] || presets.generic;
  if (spec.port) config.forwardPorts = [spec.port];
  return `${JSON.stringify(config, null, 2)}\n`;
}

// ---- Tool factories -------------------------------------------------------

const setupPythonEnvTool = defineTool(
  {
    name: 'setup_python_env',
    description:
      'Create a Python virtual environment and install dependencies using the best available manager ' +
      '(uv, Poetry, Pipenv, or python -m venv + pip), auto-detected from the project files. ' +
      'Prefer this over manual venv commands.',
    schema: (z) =>
      z.object({
        dir: z.string().optional().describe('workspace-relative project directory'),
        manager: z.enum(['auto', 'uv', 'poetry', 'pipenv', 'venv']).optional().describe('force a manager (default: auto)'),
      }),
  },
  async (input, ctx) => {
    const dir = resolveWorkdir(ctx, input.dir);
    const requested = input.manager && input.manager !== 'auto' ? input.manager : null;
    const manager = requested || pickPythonManager(dir, { uvAvailable: await commandExists('uv') });
    const { output } = await runSequence({ ctx, dir: input.dir, steps: pythonSteps(dir, manager) });
    return `Python environment (${manager}) in ${dir}\n\n${output}`;
  }
);

const setupNodeEnvTool = defineTool(
  {
    name: 'setup_node_env',
    description:
      'Install Node.js dependencies using the detected package manager (npm ci / pnpm / yarn, chosen from the ' +
      'lockfile). Reports the active Node version and any .nvmrc mismatch. Prefer this over manual install commands.',
    schema: (z) =>
      z.object({ dir: z.string().optional().describe('workspace-relative project directory') }),
  },
  async (input, ctx) => {
    const dir = resolveWorkdir(ctx, input.dir);
    const nvmrc = path.join(dir, '.nvmrc');
    let note = '';
    if (fs.existsSync(nvmrc)) {
      const want = fs.readFileSync(nvmrc, 'utf8').trim();
      note = `\nℹ️ .nvmrc requests Node ${want}; ensure your shell selected it (nvm/fnm use) before relying on this.`;
    }
    const { output } = await runSequence({ ctx, dir: input.dir, steps: nodeInstallSteps(dir) });
    return `Node environment in ${dir}${note}\n\n${output}`;
  }
);

const setupLocalEnvTool = defineTool(
  {
    name: 'setup_local_env',
    description:
      'Detect the project type(s) in the workspace and set up a complete local dev environment: install Node ' +
      'and/or Python dependencies, and (optionally) start Docker Compose services. One call to bootstrap a repo.',
    schema: (z) =>
      z.object({
        dir: z.string().optional().describe('workspace-relative project directory'),
        startServices: z.boolean().optional().describe('if a compose file exists, run `docker compose up -d`'),
      }),
  },
  async (input, ctx) => {
    const dir = resolveWorkdir(ctx, input.dir);
    const types = detectProjectTypes(dir);
    const steps = [
      ...(types.node ? nodeInstallSteps(dir) : []),
      ...(types.python ? pythonSteps(dir, pickPythonManager(dir, { uvAvailable: await commandExists('uv') })) : []),
      ...(types.go ? [{ label: 'go mod download', command: 'go', args: ['mod', 'download'], notFoundHint: 'Install Go.' }] : []),
    ];
    const detected = Object.entries(types).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';
    if (!steps.length && !(input.startServices && types.compose)) {
      return `No Node/Python/Go project detected in ${dir} (found: ${detected}). Nothing to install.`;
    }
    const { ok, output } = steps.length ? await runSequence({ ctx, dir: input.dir, steps }) : { ok: true, output: '(no dependency install steps)' };
    let composeOut = '';
    if (ok && input.startServices && types.compose) {
      composeOut = `\n\n${await execTool({ ctx, label: 'docker compose up', command: 'docker', args: ['compose', 'up', '-d'], dir: input.dir, notFoundHint: 'Install Docker Desktop.' })}`;
    }
    return `Local environment in ${dir} (detected: ${detected})\n\n${output}${composeOut}`;
  }
);

const devcontainerGenerateTool = defineTool(
  {
    name: 'devcontainer_generate',
    description: 'Scaffold a .devcontainer/devcontainer.json (pinned image, non-root remote user) for a language preset.',
    schema: (z) =>
      z.object({
        language: z.enum(['node', 'python', 'go', 'java', 'generic']).describe('runtime preset'),
        port: z.number().int().positive().optional().describe('port to forward'),
        dir: z.string().optional().describe('workspace-relative directory (default: root)'),
      }),
  },
  async (input, ctx) => {
    const dir = resolveWorkdir(ctx, input.dir);
    const target = path.join(dir, '.devcontainer');
    fs.mkdirSync(target, { recursive: true });
    const json = renderDevcontainer(input);
    fs.writeFileSync(path.join(target, 'devcontainer.json'), json, 'utf8');
    return `✅ Wrote ${path.join(target, 'devcontainer.json')}\n\n${json}`;
  }
);

const FACTORIES = Object.freeze({
  setup_python_env: setupPythonEnvTool,
  setup_node_env: setupNodeEnvTool,
  setup_local_env: setupLocalEnvTool,
  devcontainer_generate: devcontainerGenerateTool,
});

module.exports = {
  FACTORIES,
  detectProjectTypes,
  pickNodeManager,
  pickPythonManager,
  nodeInstallSteps,
  pythonSteps,
  renderDevcontainer,
};
