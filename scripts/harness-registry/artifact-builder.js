'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const registry = require('../../packages/shared-core/src/agent/registry');
const { fetchMarketplace } = require('../../packages/shared-core/src/agent/registry/source-fetcher');
const { readPlugin } = require('../../packages/shared-core/src/agent/registry/native-reader');
const { copyTreeFiltered } = require('../../packages/shared-core/src/agent/registry/secret-filter');
const { parseFrontmatter, skillFields } = require('../../packages/shared-core/src/agent/registry/frontmatter');
const { assertContained, lstatOrNull } = require('../../packages/shared-core/src/agent/registry/fs-guards');
const {
  createDeterministicTarGz,
  extractTarGz,
  listTarGz,
  sha256File,
} = require('./archive');
const { adaptDcodePlugin, normalizeDcodeStateTree } = require('./dcode-adapter');

const SOURCE_SCHEMA_VERSION = 'harness-registry/source-v1';
const INERT_SCHEMA_VERSION = 'harness-registry/inert-v1';
const REGISTRY_VERSION = 'v1';
const MAX_SOURCE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const CHROME_DEVTOOLS_MCP_VERSION = '1.6.0';

const TOOL_VERSIONS = Object.freeze({
  dcode: '0.1.55',
  codex: '0.146.1',
  claude: '2.1.198',
  deepseek: '0.1.0-rc.6',
  pi: '0.84.1',
  omp: '17.2.15',
  'ecc-installer': '2.2.x',
});

const NPM_CLI_PACKAGES = Object.freeze({
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  deepseek: '@deepseek-ai/dsh',
  pi: '@earendil-works/pi-coding-agent',
});

const DISALLOWED_EXACT_NAMES = new Set([
  '.credentials.json',
  '.credentials.yaml',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'auth.json',
  'credentials.json',
  'mcp-tokens',
]);
const DISALLOWED_DIRECTORY_NAMES = new Set(['.git', '.hg', '.svn']);
const DISALLOWED_NAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.(?:jks|key|keystore|p12|pem|pfx)$/i,
  /^id_(?:dsa|ecdsa|ed25519|rsa)(?:\..+)?$/i,
];
const TEXT_SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
];

const STRATEGY_METADATA = Object.freeze({
  deepagent: {
    installer: { name: 'deepagents-code', version: TOOL_VERSIONS.dcode },
    compatibility: 'native-with-adapter',
    capabilities: {
      native: ['skills', 'mcp', 'hooks'],
      companion: ['commands-as-skills', 'subagents', 'instructions'],
    },
    limitations: [
      'DCode does not load Claude command or agent directories directly; commands are converted to skills and agents to DCode AGENTS.md companions.',
    ],
  },
  'codex-sdk': {
    installer: { name: '@openai/codex', version: TOOL_VERSIONS.codex },
    compatibility: 'native-plugin',
    capabilities: { native: ['skills', 'mcp', 'hooks'], companion: [] },
    limitations: ['The artifact configures the Codex CLI plugin surface consumed alongside the Codex SDK; it does not alter the SDK package itself.'],
  },
  'claude-agent-sdk': {
    installer: { name: '@anthropic-ai/claude-code', version: TOOL_VERSIONS.claude },
    compatibility: 'native-plugin',
    capabilities: { native: ['skills', 'commands', 'hooks', 'mcp'], companion: [] },
    limitations: ['The artifact configures Claude Code plugin state consumed by Claude Agent SDK processes; it does not vendor model credentials.'],
  },
  'antigravity-sdk': {
    installer: { name: 'ecc-universal', version: TOOL_VERSIONS['ecc-installer'] },
    compatibility: 'best-fit-adapter',
    capabilities: { native: ['rules', 'workflows', 'skills', 'agents'], companion: [] },
    limitations: [
      'ECC targets the Antigravity .agent compatibility layout, while this repository runtime uses @google/genai rather than an Antigravity IDE plugin API.',
    ],
  },
  opencode: {
    installer: { name: 'ecc-universal', version: TOOL_VERSIONS['ecc-installer'] },
    compatibility: 'full-adapter',
    capabilities: { native: ['plugin', 'tools', 'commands', 'skills', 'hooks', 'mcp'], companion: [] },
    limitations: [],
  },
  pi: {
    installer: { name: NPM_CLI_PACKAGES.pi, version: TOOL_VERSIONS.pi },
    compatibility: 'native-package',
    capabilities: { native: ['extensions', 'skills', 'prompts'], companion: [] },
    limitations: ['Pi exposes ECC command markdown through its prompt package surface and does not activate Claude-specific hooks.'],
  },
  'oh-my-pi': {
    installer: { name: '@oh-my-pi/pi-coding-agent', version: TOOL_VERSIONS.omp },
    compatibility: 'native-marketplace',
    capabilities: { native: ['skills', 'commands', 'hooks', 'mcp'], companion: [] },
    limitations: ['ECC has no dedicated Oh My Pi adapter; this artifact uses its Claude-marketplace-compatible plugin surface.'],
  },
  deepseek: {
    installer: { name: NPM_CLI_PACKAGES.deepseek, version: TOOL_VERSIONS.deepseek },
    compatibility: 'native-skills',
    capabilities: { native: ['skills'], companion: [] },
    limitations: [
      'DeepSeek Harness is a developer preview; this artifact stages ECC SKILL.md bundles only and does not activate ECC commands, agents, hooks, MCP servers, credentials, or profiles.',
    ],
  },
});

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])])
  );
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sortJson(value), null, 2)}\n`, 'utf8');
}

function readJson(file, label = file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.message}`);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactString(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be ${JSON.stringify(expected)}`);
}

function assertLowerSha(value, length, label) {
  const expression = new RegExp(`^[0-9a-f]{${length}}$`);
  if (typeof value !== 'string' || !expression.test(value)) {
    throw new Error(`${label} must be a lowercase ${length}-character digest`);
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function ensureEmptyDirectory(directory, label = 'directory') {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length !== 0) {
    throw new Error(`${label} must be empty: ${directory}`);
  }
  return fs.realpathSync(directory);
}

function safeRemoveGeneratedDirectory(directory, expectedParent) {
  const resolved = path.resolve(directory);
  const parent = path.resolve(expectedParent);
  if (resolved === parent || !resolved.startsWith(`${parent}${path.sep}`)) {
    throw new Error(`Refusing to remove directory outside generated parent: ${directory}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function log(message) {
  process.stdout.write(`[harness-registry] ${message}\n`);
}

function displayCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(String(part))).join(' ');
}

function run(command, args, options = {}) {
  const commandArgs = Array.isArray(args) ? args.map(String) : [];
  log(`run ${displayCommand(command, commandArgs)}`);
  try {
    return execFileSync(command, commandArgs, {
      cwd: options.cwd,
      env: options.env || process.env,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    const stdout = String(error.stdout || '').slice(-8000);
    const stderr = String(error.stderr || '').slice(-8000);
    throw new Error(
      `Command failed: ${displayCommand(command, commandArgs)}\n${stdout}${stderr}`.trimEnd()
    );
  }
}

function parseJsonOutput(output, label) {
  const text = String(output || '').trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    const starts = [];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '{' || text[index] === '[') starts.push(index);
    }
    for (const start of starts) {
      try {
        return JSON.parse(text.slice(start));
      } catch (_) { /* try the next possible JSON boundary */ }
    }
    throw new Error(`${label} did not emit valid JSON`);
  }
}

function pathPrefixes(value) {
  const prefixes = new Set();
  if (typeof value !== 'string' || value === '') return [];
  prefixes.add(path.resolve(value));
  try { prefixes.add(fs.realpathSync(value)); } catch (_) { /* the path may no longer exist */ }
  return [...prefixes].sort((left, right) => right.length - left.length);
}

function walkTree(root, visitor) {
  if (!fs.existsSync(root)) return;
  function visit(current) {
    const stat = fs.lstatSync(current);
    visitor(current, stat);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
  }
  visit(root);
}

function isDisallowedName(name) {
  return DISALLOWED_EXACT_NAMES.has(name)
    || DISALLOWED_NAME_PATTERNS.some((expression) => expression.test(name));
}

function isHarnessStateFile(root, file) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const name = path.posix.basename(relative).toLowerCase();
  const isStructured = /\.(?:json|toml|ya?ml)$/i.test(name);
  if (!isStructured) return false;
  const knownControlState = [
    /(?:^|\/)ecc-install-state\.json$/,
    /(?:^|\/)\.codex-marketplace-install\.json$/,
    /(?:^|\/)\.ai-fleet-source\.json$/,
    /(?:^|\/)dcode-adapter\.json$/,
    /^home\/\.codex\/config\.toml$/,
    /^home\/\.deepagents\/(?:config\.toml|\.state\/[^/]+\.json)$/,
    /^home\/\.claude\/plugins\/(?:installed_plugins|known_marketplaces)\.json$/,
    /^home\/\.pi\/agent\/settings\.json$/,
    /^home\/\.omp\/(?:marketplaces\.json|plugins\/installed_plugins\.json)$/,
  ];
  if (knownControlState.some((expression) => expression.test(relative))) return true;
  // Upstream plugin payloads legitimately contain synthetic credential strings
  // in security tests and documentation. Scan only harness-owned control/state
  // files for token values; every path is still subject to the filename policy.
  const vendoredPayloadRoots = [
    'home/.codex/plugins/cache/',
    'home/.claude/plugins/cache/',
    'home/.claude/plugins/marketplaces/',
    'home/.deepagents/plugins/cache/',
    'home/.deepagents/marketplaces/',
    'home/.pi/agent/git/',
    'home/.omp/plugins/cache/',
    'home/.omp/marketplaces/',
    'home/.dsh/skills/',
    'home/.opencode/',
    'project/.agent/',
  ];
  return !vendoredPayloadRoots.some((prefix) => relative.startsWith(prefix));
}

function scanTreeForLeaks(root, options = {}) {
  const resolvedRoot = fs.realpathSync(root);
  const forbiddenPrefixes = (options.forbiddenPrefixes || [])
    .flatMap(pathPrefixes)
    .filter(Boolean);
  let fileCount = 0;

  walkTree(resolvedRoot, (file, stat) => {
    const name = path.basename(file);
    if (DISALLOWED_DIRECTORY_NAMES.has(name) || isDisallowedName(name)) {
      throw new Error(`Secret-like or private state path in artifact: ${file}`);
    }
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(file);
      if (path.isAbsolute(link)) throw new Error(`Absolute symlink in artifact: ${file} -> ${link}`);
      const destination = path.resolve(path.dirname(file), link);
      if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Escaping symlink in artifact: ${file} -> ${link}`);
      }
      return;
    }
    if (!stat.isFile()) return;
    fileCount += 1;
    if (stat.size > 16 * 1024 * 1024) return;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) return;
    const text = buffer.toString('utf8');
    for (const prefix of forbiddenPrefixes) {
      if (text.includes(prefix)) throw new Error(`Staging path leaked into ${file}: ${prefix}`);
    }
    if (isHarnessStateFile(resolvedRoot, file)) {
      for (const expression of TEXT_SECRET_PATTERNS) {
        if (expression.test(text)) throw new Error(`Credential-like content in artifact: ${file}`);
      }
    }
  });
  return { fileCount };
}

function prunePrivateState(root) {
  if (!fs.existsSync(root)) return;
  const removals = [];
  walkTree(root, (file) => {
    if (file === root) return;
    const name = path.basename(file);
    if (DISALLOWED_DIRECTORY_NAMES.has(name) || isDisallowedName(name)) removals.push(file);
  });
  removals.sort((left, right) => right.length - left.length);
  for (const removal of removals) fs.rmSync(removal, { recursive: true, force: true });
}

function replaceTextPrefixes(root, replacements) {
  const normalized = replacements
    .flatMap(([from, to]) => pathPrefixes(from).map((prefix) => [prefix, to]))
    .sort((left, right) => right[0].length - left[0].length);
  walkTree(root, (file, stat) => {
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) return;
    const original = buffer.toString('utf8');
    const rewritten = normalized.reduce(
      (content, [from, to]) => content.split(from).join(to),
      original
    );
    if (rewritten !== original) fs.writeFileSync(file, rewritten, 'utf8');
  });
}

function pinMutableMcpDependencies(root) {
  walkTree(root, (file, stat) => {
    if (!stat.isFile() || !['.mcp.json', 'mcp.json'].includes(path.basename(file))) return;
    const original = fs.readFileSync(file, 'utf8');
    const rewritten = original.replace(
      /chrome-devtools-mcp@latest/g,
      `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`
    );
    if (rewritten !== original) fs.writeFileSync(file, rewritten, 'utf8');
    if (fs.readFileSync(file, 'utf8').includes('chrome-devtools-mcp@latest')) {
      throw new Error(`Mutable chrome-devtools-mcp dependency remains in ${file}`);
    }
  });
}

function validateResolvedSource(value) {
  assertPlainObject(value, 'resolved source');
  assertExactString(value.schemaVersion, SOURCE_SCHEMA_VERSION, 'source.schemaVersion');
  for (const key of ['id', 'repository', 'url', 'trackRef', 'versionRange']) {
    assertExactString(value[key], registry.ECC_SOURCE[key], `source.${key}`);
  }
  const commit = assertLowerSha(value.commit, 40, 'source.commit');
  if (typeof value.version !== 'string' || !/^2\.2\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version)) {
    throw new Error('source.version must be a concrete version in the 2.2.x line');
  }
  return {
    schemaVersion: SOURCE_SCHEMA_VERSION,
    id: registry.ECC_SOURCE.id,
    repository: registry.ECC_SOURCE.repository,
    url: registry.ECC_SOURCE.url,
    trackRef: registry.ECC_SOURCE.trackRef,
    versionRange: registry.ECC_SOURCE.versionRange,
    commit,
    version: value.version,
    archiveSha256: assertLowerSha(value.archiveSha256, 64, 'source.archiveSha256'),
    archiveSizeBytes: assertPositiveInteger(value.archiveSizeBytes, 'source.archiveSizeBytes'),
    archiveFileCount: assertPositiveInteger(value.archiveFileCount, 'source.archiveFileCount'),
  };
}

function readResolvedSource(file) {
  return validateResolvedSource(readJson(file, 'resolved ECC source'));
}

function resolvedDescriptorSource(source) {
  return registry.validateEccSource({
    id: source.id,
    repository: source.repository,
    url: source.url,
    trackRef: source.trackRef,
    versionRange: source.versionRange,
    resolvedCommit: source.commit,
    version: source.version,
  }, { resolved: true });
}

function sourceArchiveExcluded(relativePath) {
  const parts = relativePath.split('/');
  return parts.some((part) => DISALLOWED_DIRECTORY_NAMES.has(part) || isDisallowedName(part))
    || parts.includes('node_modules');
}

function buildInertBundles(sources, cloneRoot, inertRoot) {
  fs.mkdirSync(inertRoot, { recursive: true });
  const realInertRoot = fs.realpathSync(inertRoot);
  const plugins = [];
  const skills = [];
  const clones = {};

  for (const [name, marketplace] of Object.entries(sources.marketplaces)) {
    if (name === registry.ECC_SOURCE.id) continue;
    clones[name] = fetchMarketplace(marketplace, { workRoot: cloneRoot, name });
    assertLowerSha(clones[name].sha, 40, `marketplace ${name} resolved ref`);
  }

  for (const selection of sources.plugins) {
    if (selection.marketplace === registry.ECC_SOURCE.id) continue;
    const clone = clones[selection.marketplace];
    if (!clone) throw new Error(`No inert marketplace checkout for ${selection.marketplace}`);
    const marketplace = sources.marketplaces[selection.marketplace];
    const record = readPlugin(clone.path, {
      name: selection.name,
      marketplace: selection.marketplace,
      version: selection.version,
      ref: clone.sha,
      sourceRepo: marketplace.repo,
      sourceUrl: marketplace.url,
    });
    if (record.incomplete || !record.sourceDir) {
      throw new Error(`Inert plugin payload was not found: ${selection.name}@${selection.marketplace}`);
    }
    const relative = path.posix.join(
      'plugins', selection.marketplace, selection.name, selection.version
    );
    const warnings = copyTreeFiltered(record.sourceDir, path.join(inertRoot, ...relative.split('/')), {
      realRoot: realInertRoot,
    });
    for (const warning of warnings) log(warning);
    plugins.push({
      name: selection.name,
      marketplace: selection.marketplace,
      version: selection.version,
      ref: clone.sha,
      repository: marketplace.repo,
      url: clone.url,
      path: relative,
    });
  }

  const vendoredRoot = path.join(__dirname, '../../packages/shared-core/src/agent/skills');
  for (const selection of sources.skills.filter((item) => item.vendored)) {
    const source = path.join(vendoredRoot, selection.name);
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
      throw new Error(`Vendored inert skill is missing: ${selection.name}`);
    }
    const relative = path.posix.join('skills', selection.name);
    const warnings = copyTreeFiltered(source, path.join(inertRoot, ...relative.split('/')), {
      realRoot: realInertRoot,
    });
    for (const warning of warnings) log(warning);
    skills.push({ name: selection.name, path: relative });
  }

  const manifest = {
    schemaVersion: INERT_SCHEMA_VERSION,
    plugins: plugins.sort((left, right) => left.path.localeCompare(right.path)),
    skills: skills.sort((left, right) => left.path.localeCompare(right.path)),
  };
  writeJson(path.join(inertRoot, 'manifest.json'), manifest);
  scanTreeForLeaks(inertRoot);
  return manifest;
}

function resolveSource({ sourcesPath, outDir }) {
  const output = ensureEmptyDirectory(path.resolve(outDir), 'resolve output');
  const sources = registry.loadSources(path.resolve(sourcesPath));
  if (!sources.source || !sources.harnessStrategies) {
    throw new Error('sources manifest must use the harness-registry/v2 contract');
  }
  const workRoot = path.join(output, '.resolve-work');
  fs.mkdirSync(workRoot);
  try {
    const checkout = fetchMarketplace(sources.marketplaces.ecc, {
      workRoot: path.join(workRoot, 'source'),
      name: 'ecc',
    });
    const commit = assertLowerSha(String(checkout.sha).toLowerCase(), 40, 'resolved ECC commit');
    const packageDocument = readJson(path.join(checkout.path, 'package.json'), 'ECC package.json');
    const version = String(packageDocument.version || '');
    if (!/^2\.2\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`Resolved ECC version ${JSON.stringify(version)} is outside 2.2.x`);
    }
    const archivePath = path.join(output, 'source.tar.gz');
    const archive = createDeterministicTarGz(checkout.path, archivePath, {
      exclude: (relative) => sourceArchiveExcluded(relative),
    });
    if (archive.sizeBytes > MAX_SOURCE_ARCHIVE_BYTES) {
      throw new Error(`ECC source archive exceeds ${MAX_SOURCE_ARCHIVE_BYTES} bytes`);
    }
    buildInertBundles(sources, path.join(workRoot, 'inert-clones'), path.join(output, 'inert'));
    const source = validateResolvedSource({
      schemaVersion: SOURCE_SCHEMA_VERSION,
      ...sources.source,
      commit,
      version,
      archiveSha256: archive.sha256,
      archiveSizeBytes: archive.sizeBytes,
      archiveFileCount: archive.fileCount,
    });
    writeJson(path.join(output, 'source.json'), source);
    log(`resolved ${source.repository} ${source.version} at ${source.commit}`);
    return source;
  } finally {
    safeRemoveGeneratedDirectory(workRoot, output);
  }
}

function createHarnessEnvironment({ homeRoot, workRoot, extra = {} }) {
  const environment = {
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    XDG_CONFIG_HOME: path.join(homeRoot, '.config'),
    XDG_DATA_HOME: path.join(homeRoot, '.local', 'share'),
    XDG_CACHE_HOME: path.join(workRoot, 'cache', 'xdg'),
    NPM_CONFIG_CACHE: path.join(workRoot, 'cache', 'npm'),
    NPM_CONFIG_PREFIX: path.join(workRoot, 'tools', 'npm-prefix'),
    PIP_CACHE_DIR: path.join(workRoot, 'cache', 'pip'),
    UV_CACHE_DIR: path.join(workRoot, 'cache', 'uv'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NO_UPDATE_NOTIFIER: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    CI: 'true',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...extra,
  };
  for (const directory of [
    environment.HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_CACHE_HOME,
    environment.NPM_CONFIG_CACHE,
    environment.NPM_CONFIG_PREFIX,
    environment.PIP_CACHE_DIR,
    environment.UV_CACHE_DIR,
  ]) fs.mkdirSync(directory, { recursive: true });
  return environment;
}

function installNpmCli({ name, version, binary, toolsRoot, env, packages = [] }) {
  const toolRoot = path.join(toolsRoot, binary);
  fs.mkdirSync(toolRoot, { recursive: true });
  run('npm', [
    'install',
    '--prefix', toolRoot,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    `${name}@${version}`,
    ...packages,
  ], { env });
  const executable = path.join(toolRoot, 'node_modules', '.bin', binary);
  if (!fs.existsSync(executable)) {
    throw new Error(`Installed ${name}@${version} did not provide ${binary}`);
  }
  return executable;
}

function codexPlatformPackageSpec() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  const arch = process.arch;
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported Codex build platform: ${process.platform}/${process.arch}`);
  }
  const alias = `@openai/codex-${platform}-${arch}`;
  return `${alias}@npm:@openai/codex@${TOOL_VERSIONS.codex}-${platform}-${arch}`;
}

function installDcodeCli({ toolsRoot, env }) {
  const virtualEnvironment = path.join(toolsRoot, 'dcode-venv');
  run('python3', ['-m', 'venv', virtualEnvironment], { env });
  const python = path.join(virtualEnvironment, 'bin', 'python');
  run(python, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
    `deepagents-code==${TOOL_VERSIONS.dcode}`,
  ], { env });
  const executable = path.join(virtualEnvironment, 'bin', 'dcode');
  if (!fs.existsSync(executable)) throw new Error('deepagents-code did not install the dcode executable');
  return executable;
}

function installOmpCli({ toolsRoot, env }) {
  const bunRoot = path.join(toolsRoot, 'omp-bun');
  fs.mkdirSync(bunRoot, { recursive: true });
  const ompEnvironment = { ...env, BUN_INSTALL: bunRoot };
  run('bun', [
    'install', '--global', '--ignore-scripts', '--no-progress',
    `@oh-my-pi/pi-coding-agent@${TOOL_VERSIONS.omp}`,
  ], { env: ompEnvironment });
  const candidates = [
    path.join(bunRoot, 'bin', 'omp'),
    path.join(bunRoot, 'install', 'global', 'node_modules', '.bin', 'omp'),
  ];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error('@oh-my-pi/pi-coding-agent did not install the omp executable');
  return { executable, env: ompEnvironment };
}

function copySourceTree(sourceRoot, destination) {
  if (fs.existsSync(destination)) throw new Error(`Source destination already exists: ${destination}`);
  fs.cpSync(sourceRoot, destination, {
    recursive: true,
    filter(source) {
      if (source === sourceRoot) return true;
      const name = path.basename(source);
      return !DISALLOWED_DIRECTORY_NAMES.has(name)
        && !isDisallowedName(name)
        && name !== 'node_modules';
    },
  });
}

function assertOutputContains(output, needle, label) {
  if (!String(output).toLowerCase().includes(String(needle).toLowerCase())) {
    throw new Error(`${label} did not contain ${JSON.stringify(needle)}`);
  }
}

function findFiles(root, basename) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  walkTree(root, (file, stat) => {
    if (stat.isFile() && path.basename(file) === basename) files.push(file);
  });
  return files.sort();
}

function treeTextIncludes(root, needle) {
  let found = false;
  if (!fs.existsSync(root)) return false;
  walkTree(root, (file, stat) => {
    if (found || !stat.isFile() || stat.size > 16 * 1024 * 1024) return;
    const buffer = fs.readFileSync(file);
    if (!buffer.includes(0) && buffer.toString('utf8').includes(needle)) found = true;
  });
  return found;
}

function tomlSection(text, name) {
  const header = `[${name}]`;
  const lines = String(text).split(/\r?\n/);
  const section = [];
  let active = false;
  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) {
      active = line.trim() === header;
      continue;
    }
    if (active) section.push(line);
  }
  return section.join('\n');
}

function tomlString(section, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match ? match[1] : null;
}

function validateCodexConfig(configPath, source) {
  const config = fs.readFileSync(configPath, 'utf8');
  const marketplace = tomlSection(config, 'marketplaces.ecc');
  const plugin = tomlSection(config, 'plugins."ecc@ecc"');
  if (
    tomlString(marketplace, 'source_type') !== 'git'
    || tomlString(marketplace, 'source') !== source.url
    || tomlString(marketplace, 'ref') !== source.commit
  ) {
    throw new Error('Codex config does not retain the canonical immutable ECC marketplace source');
  }
  if (!/^\s*enabled\s*=\s*true\s*$/m.test(plugin)) {
    throw new Error('Codex config does not enable ecc@ecc');
  }
}

function normalizeEccInstallStates(root, source) {
  const stateFiles = findFiles(root, 'ecc-install-state.json');
  for (const stateFile of stateFiles) {
    const state = readJson(stateFile, 'ECC install state');
    if (state.schemaVersion !== 'ecc.install.v1' || !state.source || !Array.isArray(state.operations)) {
      throw new Error(`Malformed ECC install state: ${stateFile}`);
    }
    state.source.repoVersion = source.version;
    state.source.repoCommit = source.commit;
    state.operations = state.operations.map(({ sourcePath: ignoredSourcePath, ...operation }) => operation);
    writeJson(stateFile, state);
  }
  return stateFiles;
}

function normalizeVolatileState(root) {
  const timestampKeys = new Set([
    'createdAt', 'installedAt', 'lastUpdated', 'lastValidatedAt', 'updatedAt',
    'created_at', 'installed_at', 'last_updated', 'updated_at',
  ]);
  function normalizeJson(value) {
    if (Array.isArray(value)) return value.map(normalizeJson);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      timestampKeys.has(key) ? '1970-01-01T00:00:00Z' : normalizeJson(item),
    ]));
  }
  walkTree(root, (file, stat) => {
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return;
    if (path.extname(file).toLowerCase() === '.json') {
      try {
        writeJson(file, normalizeJson(readJson(file)));
      } catch (_) { /* JSON-like documentation fixtures may intentionally be invalid */ }
      return;
    }
    if (path.extname(file).toLowerCase() === '.toml') {
      const original = fs.readFileSync(file, 'utf8');
      const rewritten = original.replace(
        /^(last_updated\s*=\s*)"[^"]*"/gm,
        '$1"1970-01-01T00:00:00Z"'
      );
      if (rewritten !== original) fs.writeFileSync(file, rewritten, 'utf8');
    }
  });
}

function runEccProfile({ sourceRoot, homeRoot, projectRoot, env, target, profile }) {
  const installOutput = run(process.execPath, [
    path.join(sourceRoot, 'scripts', 'install-apply.js'),
    '--profile', profile,
    '--target', target,
    '--json',
  ], { cwd: projectRoot, env });
  const installDocument = parseJsonOutput(installOutput, `ECC ${target} installer`);
  if (
    installDocument.dryRun !== false
    || !installDocument.result
    || installDocument.result.applied !== true
    || !Array.isArray(installDocument.result.operations)
    || installDocument.result.operations.length === 0
  ) {
    throw new Error(`ECC ${target} installer did not apply a non-empty plan`);
  }
  const listDocument = parseJsonOutput(run(process.execPath, [
    path.join(sourceRoot, 'scripts', 'list-installed.js'),
    '--target', target,
    '--json',
  ], { cwd: projectRoot, env }), `ECC ${target} list-installed`);
  if (!Array.isArray(listDocument.records) || listDocument.records.length !== 1) {
    throw new Error(`ECC ${target} list-installed did not find exactly one install state`);
  }
  const state = listDocument.records[0].state;
  if (!state || state.schemaVersion !== 'ecc.install.v1') {
    throw new Error(`ECC ${target} install state has an unexpected schema`);
  }
  if (state.target?.target !== target || !Array.isArray(state.operations) || state.operations.length === 0) {
    throw new Error(`ECC ${target} install state does not describe the applied target`);
  }
  return installDocument.result;
}

function validateDshSkillTree(skillsRoot, { requireDirectoryMatch = false } = {}) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(skillsRoot);
  } catch (_) {
    throw new Error(`DeepSeek skill root is missing: ${skillsRoot}`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`DeepSeek skill root must be a real directory: ${skillsRoot}`);
  }

  const skills = [];
  const seenNames = new Set();
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true }).sort((left, right) => (
    left.name.localeCompare(right.name)
  ))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const manifestPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    let manifestStat;
    try {
      manifestStat = fs.lstatSync(manifestPath);
    } catch (_) {
      continue;
    }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error(`DeepSeek skill manifest must be a regular file: ${manifestPath}`);
    }
    const fields = skillFields(parseFrontmatter(fs.readFileSync(manifestPath, 'utf8')).data);
    if (!fields.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name) || !fields.description.trim()) {
      throw new Error(`DeepSeek skill ${entry.name} needs a kebab-case name and description frontmatter`);
    }
    if (requireDirectoryMatch && fields.name !== entry.name) {
      throw new Error(`DeepSeek staged skill directory ${entry.name} does not match manifest name ${fields.name}`);
    }
    if (seenNames.has(fields.name)) {
      throw new Error(`DeepSeek skill name is duplicated: ${fields.name}`);
    }
    seenNames.add(fields.name);
    skills.push({ directory: entry.name, name: fields.name });
  }
  if (skills.length === 0) throw new Error('ECC source provides no DeepSeek-compatible SKILL.md bundles');
  return skills;
}

function requireRealDirectory(directory, label) {
  const stat = lstatOrNull(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
  return fs.realpathSync(directory);
}

function prepareEmptyChildDirectory(realParent, name, label) {
  const directory = path.join(realParent, name);
  assertContained(realParent, directory);
  const stat = lstatOrNull(directory);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a real directory: ${directory}`);
    }
    if (fs.readdirSync(directory).length !== 0) {
      throw new Error(`${label} must be empty: ${directory}`);
    }
  } else {
    fs.mkdirSync(directory);
  }
  const realDirectory = fs.realpathSync(directory);
  assertContained(realParent, realDirectory);
  return realDirectory;
}

function stageDshSkills({ sourceRoot, homeRoot }) {
  const sourceSkillsRoot = path.join(sourceRoot, 'skills');
  const sourceSkills = validateDshSkillTree(sourceSkillsRoot);
  const skillNames = sourceSkills.map((skill) => skill.name).sort((left, right) => left.localeCompare(right));
  const realHomeRoot = requireRealDirectory(homeRoot, 'DeepSeek artifact home root');
  const realDshHome = prepareEmptyChildDirectory(realHomeRoot, '.dsh', 'DeepSeek home');
  const destinationSkillsRoot = prepareEmptyChildDirectory(realDshHome, 'skills', 'DeepSeek skill destination');

  for (const skill of sourceSkills) {
    const sourceSkillRoot = path.join(sourceSkillsRoot, skill.directory);
    const destinationSkillRoot = prepareEmptyChildDirectory(
      destinationSkillsRoot,
      skill.name,
      `DeepSeek skill destination ${skill.name}`
    );
    // A validated skill can legitimately contain a boundary-delimited word such
    // as "token" in its identity. Apply the secret filter to every child while
    // avoiding its conservative root-name rejection for the skill directory.
    for (const entry of fs.readdirSync(sourceSkillRoot).sort()) {
      const warnings = copyTreeFiltered(
        path.join(sourceSkillRoot, entry),
        path.join(destinationSkillRoot, entry),
        { realRoot: realDshHome }
      );
      for (const warning of warnings) log(warning);
    }
  }
  const stagedNames = validateDshSkillTree(destinationSkillsRoot, { requireDirectoryMatch: true })
    .map((skill) => skill.name)
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(stagedNames) !== JSON.stringify(skillNames)) {
    throw new Error('DeepSeek staged skill set does not match the validated ECC source skills');
  }
  return { dshHome: realDshHome, skillsRoot: destinationSkillsRoot, skillNames: stagedNames };
}

function installDeepseek(context, dependencies = {}) {
  const installCli = dependencies.installCli || installNpmCli;
  const runCommand = dependencies.runCommand || run;
  const realHomeRoot = requireRealDirectory(context.homeRoot, 'DeepSeek artifact home root');
  const dshHome = prepareEmptyChildDirectory(realHomeRoot, '.dsh', 'DeepSeek home');
  const dshEnvironment = { ...context.env, DSH_HOME: dshHome };
  const dsh = installCli({
    name: NPM_CLI_PACKAGES.deepseek,
    version: TOOL_VERSIONS.deepseek,
    binary: 'dsh',
    toolsRoot: context.toolsRoot,
    env: dshEnvironment,
  });
  const installedVersion = String(runCommand(dsh, ['--version'], { env: dshEnvironment })).trim();
  if (installedVersion !== TOOL_VERSIONS.deepseek) {
    throw new Error(`DeepSeek Harness version mismatch: expected ${TOOL_VERSIONS.deepseek}, got ${JSON.stringify(installedVersion)}`);
  }

  const staged = stageDshSkills({ ...context, homeRoot: realHomeRoot });
  for (const relative of ['.credentials.yaml', 'settings.yaml', 'profiles', 'sessions', 'node_modules']) {
    if (fs.existsSync(path.join(dshHome, relative))) {
      throw new Error(`DeepSeek artifact must not retain ${relative}`);
    }
  }
  return { stagedSkills: staged.skillNames };
}

function installDeepagent(context) {
  const { sourceRoot, homeRoot, mountPath, toolsRoot, env } = context;
  const marketplaceRoot = path.join(homeRoot, '.deepagents', 'marketplaces', 'ecc-source');
  const canonicalMarketplaceRoot = `${mountPath}/home/.deepagents/marketplaces/ecc-source`;
  const adapted = adaptDcodePlugin({
    sourceRoot,
    marketplaceRoot,
    dcodeHomeRoot: homeRoot,
    sourceSha: context.source.commit,
    canonicalMount: mountPath,
    canonicalMarketplaceRoot,
  });

  run('npm', [
    'install', '--prefix', path.join(adapted.pluginRoot, 'vendor'),
    '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
  ], { env });
  const dcode = installDcodeCli({ toolsRoot, env });
  run(dcode, ['plugin', 'marketplace', 'add', marketplaceRoot], { env });
  run(dcode, ['plugin', 'install', 'ecc@ecc'], { env });
  const listed = run(dcode, ['plugin', 'list', '--json'], { env });
  assertOutputContains(listed, 'ecc@ecc', 'dcode plugin list');
  normalizeDcodeStateTree({
    marketplaceRoot,
    dcodeHomeRoot: homeRoot,
    canonicalMount: mountPath,
    canonicalMarketplaceRoot,
  });
  const cacheRoots = findFiles(path.join(homeRoot, '.deepagents'), 'plugin.json')
    .filter((file) => file.includes(`${path.sep}cache${path.sep}`));
  if (cacheRoots.length === 0) throw new Error('DCode did not create an ECC plugin cache');
  if (!fs.existsSync(path.join(adapted.pluginRoot, 'vendor', 'node_modules', 'chrome-devtools-mcp'))) {
    throw new Error('DCode marketplace is missing the pinned chrome-devtools MCP dependency');
  }
  return {
    capabilities: adapted.artifactManifest.capabilities,
    limitations: adapted.artifactManifest.limitations,
  };
}

function installCodex(context) {
  const { sourceRoot, homeRoot, toolsRoot, env, source } = context;
  const codexHome = path.join(homeRoot, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const codexEnvironment = { ...env, CODEX_HOME: codexHome };
  const codex = installNpmCli({
    name: NPM_CLI_PACKAGES.codex,
    version: TOOL_VERSIONS.codex,
    binary: 'codex',
    toolsRoot,
    env: codexEnvironment,
    // npm treats optional-dependency download failures as success. Install the
    // native Codex package explicitly so a missing platform binary fails the
    // build at the package boundary instead of at a later plugin command.
    packages: [codexPlatformPackageSpec()],
  });
  run(codex, [
    'plugin', 'marketplace', 'add', source.repository,
    '--ref', source.commit,
    '--json',
  ], { env: codexEnvironment });
  run(codex, ['plugin', 'add', 'ecc@ecc', '--json'], { env: codexEnvironment });
  const listed = run(codex, ['plugin', 'list', '--json'], { env: codexEnvironment });
  assertOutputContains(listed, 'ecc@ecc', 'codex plugin list');
  pinMutableMcpDependencies(path.join(codexHome, 'plugins', 'cache'));
  validateCodexConfig(path.join(codexHome, 'config.toml'), source);
  run(process.execPath, [
    path.join(sourceRoot, 'scripts', 'codex', 'check-plugin-cache.js'),
    '--codex-home', codexHome,
  ], { env: codexEnvironment });
  // Codex keeps its completed clone in the versioned plugin cache. Its `.tmp`
  // checkout and zero-byte argument scratch file are transient install state,
  // not part of the ready-to-copy runtime surface.
  for (const relative of ['.tmp', 'tmp']) {
    fs.rmSync(path.join(codexHome, relative), { recursive: true, force: true });
  }
}

function installClaude(context) {
  const { sourceRoot, homeRoot, toolsRoot, env, source } = context;
  const claude = installNpmCli({
    name: NPM_CLI_PACKAGES.claude,
    version: TOOL_VERSIONS.claude,
    binary: 'claude',
    toolsRoot,
    env,
  });
  run(claude, [
    'plugin', 'marketplace', 'add', `${source.repository}@${source.commit}`,
    '--scope', 'user',
  ], { env });
  run(claude, ['plugin', 'install', 'ecc@ecc', '--scope', 'user'], { env });
  const listed = run(claude, ['plugin', 'list', '--json'], { env });
  assertOutputContains(listed, 'ecc@ecc', 'claude plugin list');
  if (!treeTextIncludes(path.join(homeRoot, '.claude', 'plugins'), source.commit)) {
    throw new Error('Claude plugin state does not record the immutable ECC commit');
  }
  run(claude, ['plugin', 'validate', sourceRoot], { env });
  pinMutableMcpDependencies(path.join(homeRoot, '.claude', 'plugins'));
}

function installAntigravity(context) {
  run('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: context.sourceRoot,
    env: context.env,
  });
  runEccProfile({ ...context, target: 'antigravity', profile: 'minimal' });
  const statePath = path.join(context.projectRoot, '.agent', 'ecc-install-state.json');
  if (!fs.existsSync(statePath)) throw new Error('Antigravity adapter did not write install state');
}

function installOpencode(context) {
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: context.sourceRoot,
    env: context.env,
  });
  run('npm', ['run', 'build:opencode'], { cwd: context.sourceRoot, env: context.env });
  for (const relative of [
    ['.opencode', 'dist', 'index.js'],
    ['.opencode', 'dist', 'plugins'],
    ['.opencode', 'dist', 'tools'],
  ]) {
    if (!fs.existsSync(path.join(context.sourceRoot, ...relative))) {
      throw new Error(`OpenCode build did not produce ${relative.join('/')}`);
    }
  }
  runEccProfile({ ...context, target: 'opencode', profile: 'full' });
  const statePath = path.join(context.homeRoot, '.opencode', 'ecc-install-state.json');
  if (!fs.existsSync(statePath)) throw new Error('OpenCode adapter did not write install state');
  pinMutableMcpDependencies(path.join(context.homeRoot, '.opencode'));
}

function installPi(context) {
  const pi = installNpmCli({
    name: NPM_CLI_PACKAGES.pi,
    version: TOOL_VERSIONS.pi,
    binary: 'pi',
    toolsRoot: context.toolsRoot,
    env: context.env,
  });
  const packageSource = `git:github.com/${context.source.repository}@${context.source.commit}`;
  run(pi, ['install', packageSource], { cwd: context.projectRoot, env: context.env });
  run(pi, ['list'], { cwd: context.projectRoot, env: context.env });
  const settingsPath = path.join(context.homeRoot, '.pi', 'agent', 'settings.json');
  const settings = readJson(settingsPath, 'Pi settings');
  if (!JSON.stringify(settings).includes(context.source.commit)) {
    throw new Error('Pi settings do not retain the immutable ECC commit');
  }
  const packageFiles = findFiles(path.join(context.homeRoot, '.pi'), 'package.json');
  const eccPackage = packageFiles.find((file) => {
    try { return readJson(file).name === 'ecc-universal'; } catch (_) { return false; }
  });
  if (!eccPackage) throw new Error('Pi did not retain the installed ECC git package');
  const eccRoot = path.dirname(eccPackage);
  const piManifest = readJson(eccPackage, 'Pi ECC package');
  if (!Array.isArray(piManifest.pi?.extensions) || !Array.isArray(piManifest.pi?.skills)) {
    throw new Error('ECC Pi package does not declare extensions and skills');
  }
  if (!fs.existsSync(path.join(eccRoot, '.pi', 'extensions', 'index.ts'))) {
    throw new Error('ECC Pi extension entrypoint is missing');
  }
  pinMutableMcpDependencies(eccRoot);
}

function installOhMyPi(context) {
  const marketplaceRoot = path.join(context.homeRoot, '.omp', 'marketplaces', 'ecc-source');
  copySourceTree(context.sourceRoot, marketplaceRoot);
  writeJson(path.join(marketplaceRoot, '.ai-fleet-source.json'), {
    repository: context.source.repository,
    commit: context.source.commit,
    version: context.source.version,
  });
  const ompInstall = installOmpCli({ toolsRoot: context.toolsRoot, env: context.env });
  run(ompInstall.executable, ['plugin', 'marketplace', 'add', marketplaceRoot], {
    env: ompInstall.env,
  });
  run(ompInstall.executable, ['plugin', 'install', 'ecc@ecc'], { env: ompInstall.env });
  const listed = run(ompInstall.executable, ['plugin', 'list', '--json'], { env: ompInstall.env });
  assertOutputContains(listed, 'ecc@ecc', 'omp plugin list');
  const doctor = run(ompInstall.executable, ['plugin', 'doctor', '--json'], { env: ompInstall.env });
  parseJsonOutput(doctor, 'omp plugin doctor');
  pinMutableMcpDependencies(path.join(context.homeRoot, '.omp'));
}

const HARNESS_INSTALLERS = Object.freeze({
  deepagent: installDeepagent,
  'codex-sdk': installCodex,
  'claude-agent-sdk': installClaude,
  'antigravity-sdk': installAntigravity,
  opencode: installOpencode,
  pi: installPi,
  'oh-my-pi': installOhMyPi,
  deepseek: installDeepseek,
});

function directoryHasFile(root) {
  let found = false;
  if (!fs.existsSync(root)) return false;
  walkTree(root, (_file, stat) => { if (stat.isFile()) found = true; });
  return found;
}

function buildHarnessArtifact({ harnessId, sourcePath, archivePath, outDir, workDir }) {
  if (!registry.HARNESS_IDS.includes(harnessId)) throw new Error(`Unknown harness: ${harnessId}`);
  const output = ensureEmptyDirectory(path.resolve(outDir), 'harness artifact output');
  const work = ensureEmptyDirectory(path.resolve(workDir), 'harness build work directory');
  const source = readResolvedSource(path.resolve(sourcePath));
  const resolvedArchive = path.resolve(archivePath);
  const archiveStat = fs.statSync(resolvedArchive);
  if (archiveStat.size !== source.archiveSizeBytes || sha256File(resolvedArchive) !== source.archiveSha256) {
    throw new Error('Resolved ECC source archive does not match source.json');
  }
  if (archiveStat.size > MAX_SOURCE_ARCHIVE_BYTES) throw new Error('Resolved source archive exceeds its size cap');
  const sourceEntries = listTarGz(resolvedArchive);
  if (sourceEntries.filter((entry) => entry.type === '0' || entry.type === '\0').length !== source.archiveFileCount) {
    throw new Error('Resolved source archive file count does not match source.json');
  }

  const sourceRoot = path.join(work, 'source');
  const rootfsRoot = path.join(work, 'rootfs');
  const homeRoot = path.join(rootfsRoot, 'home');
  const projectRoot = path.join(rootfsRoot, 'project');
  const toolsRoot = path.join(work, 'tools');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(toolsRoot, { recursive: true });
  extractTarGz(resolvedArchive, sourceRoot);
  const packageDocument = readJson(path.join(sourceRoot, 'package.json'), 'archived ECC package.json');
  if (packageDocument.version !== source.version) throw new Error('Archived ECC package version does not match source.json');
  pinMutableMcpDependencies(sourceRoot);

  const mountPath = `${registry.HARNESS_ARTIFACT_MOUNT_ROOT}/${harnessId}`;
  const env = createHarnessEnvironment({ homeRoot, workRoot: work });
  const context = { harnessId, source, sourceRoot, rootfsRoot, homeRoot, projectRoot, toolsRoot, mountPath, env };
  const overrides = HARNESS_INSTALLERS[harnessId](context) || {};

  normalizeEccInstallStates(rootfsRoot, source);

  replaceTextPrefixes(rootfsRoot, [
    [homeRoot, `${mountPath}/home`],
    [projectRoot, `${mountPath}/project`],
  ]);
  normalizeVolatileState(rootfsRoot);
  prunePrivateState(rootfsRoot);
  pinMutableMcpDependencies(rootfsRoot);
  scanTreeForLeaks(rootfsRoot, { forbiddenPrefixes: [work, sourceRoot, homeRoot, projectRoot] });

  const copyRoots = ['home', 'project'].filter((name) => directoryHasFile(path.join(rootfsRoot, name)));
  if (copyRoots.length === 0) throw new Error(`${harnessId} produced no ready-to-copy files`);
  for (const name of ['home', 'project']) {
    if (!copyRoots.includes(name)) fs.rmSync(path.join(rootfsRoot, name), { recursive: true, force: true });
  }
  const rootfsArchive = path.join(output, 'rootfs.tar.gz');
  const artifact = createDeterministicTarGz(rootfsRoot, rootfsArchive, {
    exclude: (relative) => relative.split('/').some((part) => (
      DISALLOWED_DIRECTORY_NAMES.has(part) || isDisallowedName(part)
    )),
  });
  if (artifact.sizeBytes > MAX_ARTIFACT_ARCHIVE_BYTES) {
    throw new Error(`${harnessId} artifact exceeds ${MAX_ARTIFACT_ARCHIVE_BYTES} bytes`);
  }
  const metadata = STRATEGY_METADATA[harnessId];
  const descriptor = registry.validateArtifactDescriptor({
    schemaVersion: registry.HARNESS_REGISTRY_SCHEMA_VERSION,
    harnessId,
    strategy: registry.HARNESS_STRATEGIES[harnessId],
    source: resolvedDescriptorSource(source),
    artifact: {
      path: registry.expectedArtifactPath(harnessId),
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      fileCount: artifact.fileCount,
    },
    target: {
      platform: 'linux',
      arch: 'x64',
      mountPath,
      copyRoots,
    },
    installer: metadata.installer.name === 'ecc-universal'
      ? { ...metadata.installer, version: source.version }
      : metadata.installer,
    compatibility: metadata.compatibility,
    capabilities: overrides.capabilities || metadata.capabilities,
    limitations: overrides.limitations || metadata.limitations,
  });
  writeJson(path.join(output, 'artifact.json'), descriptor);
  log(`built ${harnessId}: ${artifact.fileCount} files, ${artifact.sha256}`);
  return descriptor;
}

function validateInertManifest(value, inertRoot = null) {
  assertPlainObject(value, 'inert manifest');
  assertExactString(value.schemaVersion, INERT_SCHEMA_VERSION, 'inert.schemaVersion');
  if (!Array.isArray(value.plugins)) throw new Error('inert.plugins must be an array');
  const seen = new Set();
  const plugins = value.plugins.map((entry, index) => {
    assertPlainObject(entry, `inert.plugins[${index}]`);
    for (const key of ['name', 'marketplace', 'version', 'ref', 'url', 'path']) {
      if (typeof entry[key] !== 'string' || !entry[key]) {
        throw new Error(`inert.plugins[${index}].${key} must be a non-empty string`);
      }
    }
    if (entry.repository != null && (typeof entry.repository !== 'string' || !entry.repository)) {
      throw new Error(`inert.plugins[${index}].repository must be null or a non-empty string`);
    }
    assertLowerSha(entry.ref, 40, `inert.plugins[${index}].ref`);
    const normalizedPath = path.posix.normalize(entry.path);
    if (
      normalizedPath !== entry.path
      || normalizedPath.startsWith('../')
      || !normalizedPath.startsWith('plugins/')
    ) {
      throw new Error(`Unsafe inert plugin path: ${entry.path}`);
    }
    if (seen.has(entry.path)) throw new Error(`Duplicate inert plugin path: ${entry.path}`);
    seen.add(entry.path);
    if (inertRoot && !fs.existsSync(path.join(inertRoot, ...entry.path.split('/')))) {
      throw new Error(`Inert plugin payload is missing: ${entry.path}`);
    }
    return { ...entry };
  });
  const skills = value.skills == null ? [] : value.skills;
  if (!Array.isArray(skills)) throw new Error('inert.skills must be an array');
  for (const [index, entry] of skills.entries()) {
    assertPlainObject(entry, `inert.skills[${index}]`);
    if (typeof entry.name !== 'string' || !entry.name || typeof entry.path !== 'string') {
      throw new Error(`inert.skills[${index}] needs name and path strings`);
    }
    if (!entry.path.startsWith('skills/') || path.posix.normalize(entry.path) !== entry.path) {
      throw new Error(`Unsafe inert skill path: ${entry.path}`);
    }
    if (inertRoot && !fs.existsSync(path.join(inertRoot, ...entry.path.split('/')))) {
      throw new Error(`Inert skill payload is missing: ${entry.path}`);
    }
  }
  return { schemaVersion: INERT_SCHEMA_VERSION, plugins, skills: skills.map((entry) => ({ ...entry })) };
}

function assertSameSource(actual, expected, label) {
  if (JSON.stringify(sortJson(actual)) !== JSON.stringify(sortJson(expected))) {
    throw new Error(`${label} does not use the single resolved ECC source`);
  }
}

function verifyRootfsArchive(archivePath, descriptor, options = {}) {
  const stat = fs.statSync(archivePath);
  if (stat.size !== descriptor.artifact.sizeBytes) {
    throw new Error(`${descriptor.harnessId} artifact size does not match its descriptor`);
  }
  if (stat.size > MAX_ARTIFACT_ARCHIVE_BYTES) throw new Error(`${descriptor.harnessId} archive exceeds size cap`);
  if (sha256File(archivePath) !== descriptor.artifact.sha256) {
    throw new Error(`${descriptor.harnessId} artifact checksum does not match its descriptor`);
  }
  const entries = listTarGz(archivePath);
  const fileCount = entries.filter((entry) => entry.type === '0' || entry.type === '\0').length;
  if (fileCount !== descriptor.artifact.fileCount) {
    throw new Error(`${descriptor.harnessId} artifact file count does not match its descriptor`);
  }
  for (const entry of entries) {
    const root = entry.path.split('/')[0];
    if (!descriptor.target.copyRoots.includes(root)) {
      throw new Error(`${descriptor.harnessId} archive contains undeclared copy root: ${entry.path}`);
    }
    const name = path.posix.basename(entry.path);
    if (DISALLOWED_DIRECTORY_NAMES.has(name) || isDisallowedName(name)) {
      throw new Error(`${descriptor.harnessId} archive contains private state: ${entry.path}`);
    }
  }
  if (options.scanContents !== false) {
    const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), `harness-${descriptor.harnessId}-verify-`));
    const extracted = path.join(temporaryParent, 'rootfs');
    try {
      extractTarGz(archivePath, extracted);
      const scan = scanTreeForLeaks(extracted, {
        forbiddenPrefixes: options.forbiddenPrefixes || [],
      });
      if (scan.fileCount !== fileCount) {
        throw new Error(`${descriptor.harnessId} extracted file count changed during verification`);
      }
      for (const copyRoot of descriptor.target.copyRoots) {
        if (!directoryHasFile(path.join(extracted, copyRoot))) {
          throw new Error(`${descriptor.harnessId} declared copy root is empty: ${copyRoot}`);
        }
      }
    } finally {
      safeRemoveGeneratedDirectory(temporaryParent, os.tmpdir());
    }
  }
  return { fileCount, entries };
}

function assembleRegistry({ inputsDir, outDir }) {
  const inputs = path.resolve(inputsDir);
  const output = ensureEmptyDirectory(path.resolve(outDir), 'assembled registry output');
  const sourcePath = path.join(inputs, 'resolve', 'source.json');
  const source = readResolvedSource(sourcePath);
  const descriptorSource = resolvedDescriptorSource(source);
  const inputInertRoot = path.join(inputs, 'resolve', 'inert');
  const inertManifest = validateInertManifest(
    readJson(path.join(inputInertRoot, 'manifest.json'), 'inert manifest'),
    inputInertRoot
  );
  scanTreeForLeaks(inputInertRoot);

  const descriptorFiles = findFiles(path.join(inputs, 'harnesses'), 'artifact.json');
  if (descriptorFiles.length !== registry.HARNESS_IDS.length) {
    throw new Error(
      `Expected ${registry.HARNESS_IDS.length} harness descriptors, found ${descriptorFiles.length}`
    );
  }
  const descriptors = new Map();
  for (const descriptorFile of descriptorFiles) {
    const descriptor = registry.validateArtifactDescriptor(readJson(descriptorFile));
    if (descriptors.has(descriptor.harnessId)) {
      throw new Error(`Duplicate harness descriptor: ${descriptor.harnessId}`);
    }
    assertSameSource(descriptor.source, descriptorSource, descriptor.harnessId);
    const archive = path.join(path.dirname(descriptorFile), 'rootfs.tar.gz');
    if (!fs.existsSync(archive)) throw new Error(`Missing rootfs.tar.gz beside ${descriptorFile}`);
    verifyRootfsArchive(archive, descriptor, { scanContents: false });
    descriptors.set(descriptor.harnessId, { descriptor, archive });
  }
  const missing = registry.HARNESS_IDS.filter((id) => !descriptors.has(id));
  if (missing.length) throw new Error(`Harness artifacts are missing: ${missing.join(', ')}`);

  const versionRoot = path.join(output, REGISTRY_VERSION);
  const harnessRoot = path.join(versionRoot, 'harnesses');
  fs.mkdirSync(harnessRoot, { recursive: true });
  const harnesses = [];
  for (const harnessId of registry.HARNESS_IDS) {
    const { descriptor, archive } = descriptors.get(harnessId);
    const destination = path.join(harnessRoot, harnessId);
    fs.mkdirSync(destination, { recursive: true });
    writeJson(path.join(destination, 'artifact.json'), descriptor);
    fs.copyFileSync(archive, path.join(destination, 'rootfs.tar.gz'));
    harnesses.push({
      id: harnessId,
      strategy: descriptor.strategy,
      descriptorPath: registry.expectedDescriptorPath(harnessId),
      artifactPath: registry.expectedArtifactPath(harnessId),
      sha256: descriptor.artifact.sha256,
      sizeBytes: descriptor.artifact.sizeBytes,
    });
  }
  fs.cpSync(inputInertRoot, path.join(versionRoot, 'inert'), { recursive: true });
  const index = registry.validateHarnessRegistryIndex({
    schemaVersion: registry.HARNESS_REGISTRY_SCHEMA_VERSION,
    version: REGISTRY_VERSION,
    source: descriptorSource,
    harnesses,
    inert: inertManifest.plugins,
  });
  writeJson(path.join(versionRoot, 'registry.json'), index);
  verifyRegistry({ registryDir: output });
  log(`assembled ${harnesses.length} harness artifacts under ${versionRoot}`);
  return index;
}

function verifyRegistry({ registryDir }) {
  const root = path.resolve(registryDir);
  const versionRoot = path.join(root, REGISTRY_VERSION);
  const index = registry.validateHarnessRegistryIndex(
    readJson(path.join(versionRoot, 'registry.json'), 'harness registry index')
  );
  const inertRoot = path.join(versionRoot, 'inert');
  const inertManifest = validateInertManifest(
    readJson(path.join(inertRoot, 'manifest.json'), 'inert manifest'),
    inertRoot
  );
  if (JSON.stringify(sortJson(index.inert)) !== JSON.stringify(sortJson(inertManifest.plugins))) {
    throw new Error('Registry index inert rows do not match inert/manifest.json');
  }
  scanTreeForLeaks(inertRoot);

  for (const entry of index.harnesses) {
    const descriptorFile = path.join(versionRoot, ...entry.descriptorPath.split('/'));
    const archiveFile = path.join(versionRoot, ...entry.artifactPath.split('/'));
    const descriptor = registry.validateArtifactDescriptor(readJson(descriptorFile));
    if (descriptor.harnessId !== entry.id || descriptor.strategy !== entry.strategy) {
      throw new Error(`Registry row does not match descriptor for ${entry.id}`);
    }
    assertSameSource(descriptor.source, index.source, entry.id);
    if (
      descriptor.artifact.sha256 !== entry.sha256
      || descriptor.artifact.sizeBytes !== entry.sizeBytes
    ) {
      throw new Error(`Registry row checksum metadata does not match descriptor for ${entry.id}`);
    }
    verifyRootfsArchive(archiveFile, descriptor);
    const harnessDirectoryEntries = fs.readdirSync(path.dirname(descriptorFile)).sort();
    if (JSON.stringify(harnessDirectoryEntries) !== JSON.stringify(['artifact.json', 'rootfs.tar.gz'])) {
      throw new Error(`Unexpected files in harness directory for ${entry.id}`);
    }
  }
  scanTreeForLeaks(versionRoot);
  return index;
}

module.exports = {
  CHROME_DEVTOOLS_MCP_VERSION,
  HARNESS_INSTALLERS,
  INERT_SCHEMA_VERSION,
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_SOURCE_ARCHIVE_BYTES,
  REGISTRY_VERSION,
  SOURCE_SCHEMA_VERSION,
  STRATEGY_METADATA,
  TOOL_VERSIONS,
  assembleRegistry,
  buildHarnessArtifact,
  buildInertBundles,
  installDeepseek,
  readResolvedSource,
  resolveSource,
  scanTreeForLeaks,
  stageDshSkills,
  validateInertManifest,
  validateCodexConfig,
  validateDshSkillTree,
  validateResolvedSource,
  verifyRegistry,
  verifyRootfsArchive,
};
