'use strict';

/**
 * Plugin catalog — the reviewed source of truth for third-party agent-skill
 * packs shipped as Agent Plugins 1.0.0 bundles for kagent.
 *
 * Pure: only Node built-ins, no filesystem and no cluster. It validates the
 * shape and the cross-field invariants of `plugin-catalog.json`, and derives
 * the support matrix. Publishing artifacts (`deploy/kagent/plugins.csv`, the
 * bundle Dockerfiles and the four-CR manifests) are checked against this by
 * `scripts/seed-plugin-catalog.js` and the registry tests, not from here.
 *
 * The invariants encode three facts that are easy to get wrong:
 *   1. One version number travels in three places (upstream release, the
 *      `plugin.json` we author, and every non-blank matrix cell) and they must
 *      agree, because CI asserts upstream == CSV and the manifest asserts
 *      CSV == bundle.
 *   2. `Harness.spec.engine` is the enum kagent|codex|claude|byo, so a matrix
 *      column is only reachable when it names one of those. `deepagent` has no
 *      engine at all and every other CLI needs a byo runtime image.
 *   3. The plugin image is `FROM scratch` — data only — so a pack's software
 *      requirement lands in the harness runtime image, never the plugin image.
 */

const path = require('node:path');

const CATALOG = require('./plugin-catalog.json');

/**
 * Matrix columns, keyed by the CLI a developer actually runs. `harnessId`
 * joins back to harness-catalog.json; `engine` is the kagent Harness engine
 * that would have to exist for the cell to be fillable, and `null` means no
 * kagent engine can drive that CLI today.
 */
const MATRIX_COLUMNS = Object.freeze({
  deepagent: { harnessId: 'deepagent', engine: null, runtime: 'none' },
  codex: { harnessId: 'codex-sdk', engine: 'codex', runtime: 'native' },
  claude: { harnessId: 'claude-agent-sdk', engine: 'claude', runtime: 'native' },
  antigravity: { harnessId: 'antigravity-sdk', engine: 'byo', runtime: 'byo' },
  qodercli: { harnessId: 'qoder-sdk', engine: 'byo', runtime: 'byo' },
  opencode: { harnessId: 'opencode', engine: 'byo', runtime: 'byo' },
  pi: { harnessId: 'pi', engine: 'byo', runtime: 'byo' },
  omp: { harnessId: 'oh-my-pi', engine: 'byo', runtime: 'byo' },
  dsh: { harnessId: 'deepseek', engine: 'byo', runtime: 'byo' },
});

/** The CLI column `kagent`'s own native engine occupies, for MCP-only rows. */
const KAGENT_COLUMN = 'kagent';

const KAGENT_ENGINES = Object.freeze(['kagent', 'codex', 'claude', 'byo']);

/**
 * Where `verify-plugin-images.sh` reads the upstream version at the pin, as a
 * path relative to the repository root. Only ECC ships a VERSION file, so the
 * extractor keys on the basename: VERSION is raw text, `package.json` and
 * `plugin.json` are `.version`, `pyproject.toml` is `^version = "…"`.
 */
const VERSION_SOURCES = Object.freeze(['VERSION', 'package.json', 'pyproject.toml', 'plugin.json']);

/**
 * built    — published image, digest stamped into a committed manifest.
 * bundled  — the bundle pipeline exists and is proven on a local registry.
 * declared — a catalog row and CSV row exist; nothing published yet.
 * unsupported — the column needs a byo runtime image we have not built.
 */
const STATUSES = Object.freeze(['built', 'bundled', 'declared', 'unsupported']);

/** A matrix cell carries a version only for these statuses. */
const FILLED_STATUSES = Object.freeze(['built', 'bundled', 'declared']);

// kagent's own limits, restated here so a catalog edit fails locally rather
// than on a `kubectl apply`.
const SKILLS_MAX = 50;
const PROMPT_APPEND_MAX = 4000;
const ENV_VARS_MAX = 32;
const ENV_VALUE_MAX = 32768;
const BUNDLE_ENTRIES_MAX = 10000;
const BUNDLE_BYTES_MAX = 104857600;

/** CA/cert paths kagent reserves on the Harness container. */
const RESERVED_ENV = Object.freeze([
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'AWS_CA_BUNDLE',
  'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO',
]);

/** Docker instructions a requirement line may open with. */
const DOCKERFILE_INSTRUCTIONS = Object.freeze(['RUN', 'ENV', 'USER', 'WORKDIR', 'COPY', 'VOLUME', 'ARG']);

// Agent Plugins 1.0.0 naming rule: <=64 chars, lowercase letters/digits/dots/
// hyphens, no leading/trailing dot or hyphen, no `--`, no `..`. The regex
// covers the charset, length and endpoints; the two run separators are checked
// separately because a character class cannot express them.
const AGENT_PLUGIN_NAME = /^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$/;
const RUN_SEPARATORS = /--|\.\./;

/** True when `name` is a legal Agent Plugins 1.0.0 plugin or skill name. */
function isAgentPluginName(name) {
  return typeof name === 'string'
    && AGENT_PLUGIN_NAME.test(name)
    && !RUN_SEPARATORS.test(name);
}

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
// These lines reach a Docker build, and a Docker build reaches the image layer
// cache, so a credential here is a published credential.
const SECRETISH = /(api[_-]?key|secret|passwd|password|access[_-]?key|private[_-]?key|tok_|gh[pousr]_[0-9a-zA-Z]{20,}|sk-[a-z0-9]{20,}|AKIA[0-9A-Z]{16})/i;

const AGENT_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function push(list, condition, message) {
  if (!condition) list.push(message);
}

/** The kagent plugin name for a catalog id: the id itself, verified. */
function pluginName(id) {
  return String(id);
}

/**
 * @returns {string[]} the matrix column keys, in display order
 */
function matrixColumns() {
  return Object.keys(MATRIX_COLUMNS);
}

/** The version that belongs in `cell(pluginId, cliKey)`, or '' when blank. */
function cellVersion(plugin, cliKey) {
  const entry = plugin && plugin.harnesses && plugin.harnesses[cliKey];
  if (!entry || !FILLED_STATUSES.includes(entry.status)) return '';
  return entry.version || '';
}

/**
 * The support matrix as rows of {plugin, cells:{cliKey: version}}. Blank cells
 * are '' so a CSV writer does not have to know the legend.
 */
function buildMatrix(catalog = CATALOG) {
  const columns = matrixColumns();
  const rows = [];
  for (const plugin of (catalog && catalog.plugins) || []) {
    const cells = {};
    for (const column of columns) cells[column] = cellVersion(plugin, column);
    rows.push({ id: plugin.id, label: plugin.label, cells });
  }
  return { columns, rows };
}

/** Enabled skill names, in catalog order — the list a manifest's skills: mirrors. */
function enabledSkills(plugin) {
  return ((plugin && plugin.skills) || [])
    .filter((skill) => skill && skill.enabled)
    .map((skill) => skill.name);
}

/** Every skill name the bundle should carry, enabled or not. */
function bundledSkills(plugin) {
  return ((plugin && plugin.skills) || []).map((skill) => skill && skill.name).filter(Boolean);
}

function validateRequirements(requirements, where, errors) {
  if (!isPlainObject(requirements)) {
    errors.push(`${where}: requirements must be an object`);
    return;
  }
  push(errors, Array.isArray(requirements.packages), `${where}: requirements.packages must be an array`);
  push(errors, Array.isArray(requirements.dockerfile) && requirements.dockerfile.length > 0,
    `${where}: requirements.dockerfile must be a non-empty array of lines to append`);
  push(errors, Array.isArray(requirements.writablePaths), `${where}: requirements.writablePaths must be an array`);

  // The FROM scratch rule, as an assertion: a requirement that names a plugin
  // Dockerfile would be silently dropped, because that image has no shell to
  // run it in.
  const applied = String(requirements.appliedTo || '');
  push(errors, /^go\/harness\/[^/]+\/Dockerfile$/.test(applied),
    `${where}: requirements.appliedTo must be a harness runtime image (go/harness/<cli>/Dockerfile), not a plugin image — got ${JSON.stringify(applied)}`);

  // One array per package family, because a harness runtime image is either
  // Debian-derived (`apt-get`) or alpine (`apk`) and a line written for one fails
  // on the other. `dockerfile` is required (the reviewed default);
  // `dockerfileAlpine` is optional until a pack is proven on an alpine base.
  for (const field of ['dockerfile', 'dockerfileAlpine']) {
    const lines = requirements[field];
    if (field === 'dockerfile') {
      push(errors, Array.isArray(lines) && lines.length > 0,
        `${where}: requirements.dockerfile must be a non-empty array of lines to append`);
    } else {
      push(errors, lines === undefined || (Array.isArray(lines) && lines.length > 0),
        `${where}: requirements.dockerfileAlpine, when present, must be a non-empty array`);
    }
    for (const [index, line] of (lines || []).entries()) {
      const at = `${where}: requirements.${field}[${index}]`;
      if (typeof line !== 'string' || !line.trim()) {
        errors.push(`${at}: must be a non-empty string`);
        continue;
      }
      const instruction = line.trim().split(/\s+/)[0].toUpperCase();
      push(errors, DOCKERFILE_INSTRUCTIONS.includes(instruction),
        `${at}: "${instruction}" is not an allowed instruction (${DOCKERFILE_INSTRUCTIONS.join('|')})`);
      push(errors, !SECRETISH.test(line), `${at}: credential-shaped text in a Dockerfile line`);
    }
  }
  for (const p of requirements.writablePaths || []) {
    push(errors, typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('..'),
      `${where}: writablePath must be relative and contain no ".." — got ${JSON.stringify(p)}`);
  }
}

/**
 * The requirement lines for a base image's package family. An alpine base with
 * only `dockerfile` (Debian-shaped) lines has nothing installable, so the
 * caller gets `null` and must refuse the combination rather than build an image
 * whose `RUN apt-get` fails on `apk`-only bases.
 *
 * @param {object} requirements a pack's `requirements` block
 * @param {'apk'|'apt'} family the base image's package family
 * @returns {string[]|null} the lines to append, or null when the family has none
 */
function requirementLines(requirements, family) {
  if (!isPlainObject(requirements)) return null;
  if (family === 'apk') {
    return Array.isArray(requirements.dockerfileAlpine) && requirements.dockerfileAlpine.length
      ? requirements.dockerfileAlpine
      : null;
  }
  return Array.isArray(requirements.dockerfile) && requirements.dockerfile.length
    ? requirements.dockerfile
    : null;
}

function validateEnv(env, where, errors) {
  if (env == null) return;
  const entries = Object.entries(env);
  push(errors, entries.length <= ENV_VARS_MAX,
    `${where}: ${entries.length} env vars exceeds the kagent limit of ${ENV_VARS_MAX}`);
  for (const [name, value] of entries) {
    push(errors, !RESERVED_ENV.includes(name), `${where}: ${name} is a reserved env name on the Harness container`);
    push(errors, String(value).length <= ENV_VALUE_MAX, `${where}: ${name} exceeds ${ENV_VALUE_MAX} chars`);
  }
}

function validatePlugin(plugin, index, errors) {  const where = `plugins[${index}]${plugin && plugin.id ? ` (${plugin.id})` : ''}`;
  if (!isPlainObject(plugin)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  const id = plugin.id;
  push(errors, typeof id === 'string' && id.length > 0, `${where}: id is required`);
  push(errors, typeof plugin.label === 'string' && plugin.label.length > 0, `${where}: label is required`);
  if (typeof id === 'string' && id) {
    push(errors, isAgentPluginName(id),
      `${where}: id "${id}" is not a valid Agent Plugins 1.0.0 name (<=64, lowercase letters/digits/dots/hyphens, no leading/trailing dot or hyphen, no -- or ..)`);
  }

  const upstream = plugin.upstream || {};
  push(errors, typeof upstream.repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(upstream.repository || ''),
    `${where}: upstream.repository must be "owner/name"`);
  push(errors, typeof upstream.url === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(upstream.url || ''),
    `${where}: upstream.url must be the clone URL ending in .git`);
  push(errors, FULL_GIT_SHA.test(upstream.commit || ''),
    `${where}: upstream.commit must be exactly 40 lowercase hex — kagent rejects a branch, tag, or abbreviated sha`);
  const versionSource = String(upstream.versionSource || '');
  push(errors, VERSION_SOURCES.includes(path.posix.basename(versionSource))
      && !versionSource.startsWith('/') && !versionSource.includes('..'),
    `${where}: upstream.versionSource must be a repo-relative path whose basename is one of ${VERSION_SOURCES.join(', ')} — got ${JSON.stringify(versionSource)}`);
  push(errors, /^\d{4}-\d{2}-\d{2}$/.test(upstream.releasedAt || ''),
    `${where}: upstream.releasedAt must be YYYY-MM-DD`);
  push(errors, typeof upstream.license === 'string' && upstream.license.length > 0,
    `${where}: upstream.license is required`);

  const bundle = plugin.bundle || {};
  push(errors, bundle.version === upstream.release,
    `${where}: bundle.version ${bundle.version} != upstream.release ${upstream.release} — the authored plugin.json must carry the upstream version`);
  push(errors, typeof bundle.image === 'string' && /^ghcr\.io\/[^/]+\/[^/]+\/[^/]+-plugin$/.test(bundle.image || ''),
    `${where}: bundle.image must be a ghcr repository ending in "-plugin"`);
  push(errors, /^deploy\/kagent\/[^/]+\/Dockerfile\.[^/]+-plugin$/.test(bundle.dockerfile || ''),
    `${where}: bundle.dockerfile must be deploy/kagent/<plugin>/Dockerfile.<plugin>-plugin`);
  push(errors, bundle.skillsDir === './skills/',
    `${where}: bundle.skillsDir must be "./skills/" as the plugin.json skills entry`);
  push(errors, typeof bundle.mcp === 'boolean', `${where}: bundle.mcp must be a boolean`);
  push(errors, bundle.digest === null || /^sha256:[0-9a-f]{64}$/.test(bundle.digest || ''),
    `${where}: bundle.digest must be null until CI publishes, or a sha256 digest`);

  const skills = plugin.skills;
  push(errors, Array.isArray(skills) && skills.length > 0, `${where}: skills must be a non-empty array`);
  const seen = new Set();
  const enabled = enabledSkills(plugin);
  for (const [i, skill] of (skills || []).entries()) {
    const name = skill && skill.name;
    push(errors, isAgentPluginName(name),
      `${where}: skills[${i}].name "${name}" is not a safe skill directory name`);
    push(errors, !seen.has(name), `${where}: duplicate skill "${name}"`);
    seen.add(name);
    push(errors, typeof skill.enabled === 'boolean', `${where}: skills[${i}].enabled must be a boolean`);
  }
  push(errors, enabled.length > 0, `${where}: at least one skill must be enabled — attaching a plugin does not enable its skills`);
  push(errors, enabled.length <= SKILLS_MAX,
    `${where}: ${enabled.length} enabled skills exceeds the kagent limit of ${SKILLS_MAX}`);

  push(errors, typeof plugin.promptAppend === 'string' && plugin.promptAppend.length > 0,
    `${where}: promptAppend is required — the pack exists to change how the agent behaves`);
  push(errors, String(plugin.promptAppend || '').length <= PROMPT_APPEND_MAX,
    `${where}: promptAppend exceeds ${PROMPT_APPEND_MAX} chars accepted per plugin`);

  const icon = plugin.icon || {};
  push(errors, icon.file === `public/icons/plugins/${id}.svg`,
    `${where}: icon.file must be public/icons/plugins/${id}.svg`);
  push(errors, icon.href === `/icons/plugins/${id}.svg`,
    `${where}: icon.href must be the same-origin /icons/plugins/${id}.svg`);

  const versions = plugin.versions;
  push(errors, Array.isArray(versions) && versions.length > 0, `${where}: versions must be a non-empty array`);
  const current = (versions || [])[0] || {};
  push(errors, current.version === upstream.release && current.commit === upstream.commit,
    `${where}: versions[0] must describe the pinned release (${upstream.release} @ ${upstream.commit})`);
  for (const [i, v] of (versions || []).entries()) {
    push(errors, FULL_GIT_SHA.test((v && v.commit) || ''), `${where}: versions[${i}].commit must be 40 lowercase hex`);
  }
  const versionSet = new Set((versions || []).map((v) => v && v.version));
  push(errors, versionSet.size === (versions || []).length, `${where}: versions[] must not repeat a version`);

  validateRequirements(plugin.requirements, where, errors);
  validateEnv(plugin.env, where, errors);

  const harnesses = plugin.harnesses;
  push(errors, isPlainObject(harnesses) && Object.keys(harnesses || {}).length > 0,
    `${where}: harnesses must declare at least one column`);
  for (const [key, entry] of Object.entries(harnesses || {})) {
    const at = `${where}: harnesses.${key}`;
    if (key !== KAGENT_COLUMN) {
      push(errors, Object.prototype.hasOwnProperty.call(MATRIX_COLUMNS, key),
        `${at}: not a matrix column (${matrixColumns().join(', ')})`);
      push(errors, MATRIX_COLUMNS[key] && MATRIX_COLUMNS[key].harnessId, `${at}: unknown column`);
    }
    push(errors, isPlainObject(entry), `${at}: must be an object`);
    if (!isPlainObject(entry)) continue;
    push(errors, KAGENT_ENGINES.includes(entry.engine), `${at}: engine must be one of ${KAGENT_ENGINES.join(', ')}`);
    push(errors, STATUSES.includes(entry.status), `${at}: status must be one of ${STATUSES.join(', ')}`);
    push(errors, typeof entry.cliKey === 'string' && entry.cliKey.length > 0, `${at}: cliKey is required`);
    push(errors, entry.limitations === undefined || Array.isArray(entry.limitations),
      `${at}: limitations must be an array when present`);
    push(errors, typeof entry.mcp === 'boolean', `${at}: mcp must be a boolean`);
    // Plugin-declared mcp.json is read by the kagent engine and by nothing else.
    push(errors, !(entry.mcp && entry.engine !== 'kagent'),
      `${at}: a plugin's mcp.json binds only on engine kagent`);
    if (entry.status === 'unsupported') {
      push(errors, typeof entry.blockedOn === 'string' && entry.blockedOn.length > 0,
        `${at}: an unsupported cell must name what it is blocked on`);
    } else {
      push(errors, entry.version === bundle.version,
        `${at}: cell version ${entry.version} != bundle version ${bundle.version}`);
    }
    if (entry.engine === 'byo') {
      push(errors, entry.status === 'unsupported' || entry.runtimeImage,
        `${at}: a byo column needs a runtimeImage once it stops being unsupported`);
    }
  }
}

/**
 * Validate a catalog document.
 * @param {object} [catalog]
 * @returns {{ ok:boolean, errors:string[] }}
 */
function validatePluginCatalog(catalog = CATALOG) {
  const errors = [];
  if (!isPlainObject(catalog)) return { ok: false, errors: ['catalog must be an object'] };
  push(errors, catalog.schemaVersion === 'plugin-catalog/v1',
    `schemaVersion must be "plugin-catalog/v1", got ${JSON.stringify(catalog.schemaVersion)}`);
  push(errors, catalog.bundleSpec === AGENT_PLUGIN_SCHEMA, `bundleSpec must be ${AGENT_PLUGIN_SCHEMA}`);
  push(errors, Array.isArray(catalog.plugins) && catalog.plugins.length > 0, 'plugins must be a non-empty array');
  const ids = new Set();
  for (const [index, plugin] of (catalog.plugins || []).entries()) {
    validatePlugin(plugin, index, errors);
    if (plugin && typeof plugin.id === 'string') {
      push(errors, !ids.has(plugin.id), `duplicate plugin id "${plugin.id}"`);
      ids.add(plugin.id);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Cross-check the ecc record against the harness-rootfs registry's own source
 * description, so the two tracks cannot drift onto different commits of the
 * same pack without somebody noticing.
 * @param {object} catalog
 * @param {{id:string, repository:string, url:string, versionRange:string}} eccSource
 * @returns {string[]}
 */
function eccSourceAgreement(catalog, eccSource) {
  const errors = [];
  const ecc = findPlugin('ecc', catalog);
  if (!ecc) return ['catalog has no "ecc" record, but sources.json pins one'];
  const up = ecc.upstream || {};
  if (up.repository !== eccSource.repository) {
    errors.push(`ecc.upstream.repository ${up.repository} != sources.json ${eccSource.repository}`);
  }
  if (up.url !== eccSource.url) {
    errors.push(`ecc.upstream.url ${up.url} != sources.json ${eccSource.url}`);
  }
  const range = String(eccSource.versionRange || '');
  if (range.includes('.')) {
    const prefix = range.replace(/\.x$/, '');
    if (!String(up.release || '').startsWith(`${prefix}.`)) {
      errors.push(`ecc.release ${up.release} does not satisfy sources.json versionRange ${range}`);
    }
  }
  return errors;
}

/** @returns {object|null} the record for `id` */
function findPlugin(id, catalog = CATALOG) {
  return ((catalog && catalog.plugins) || []).find((plugin) => plugin && plugin.id === id) || null;
}

module.exports = {
  CATALOG,
  MATRIX_COLUMNS,
  KAGENT_COLUMN,
  KAGENT_ENGINES,
  VERSION_SOURCES,
  STATUSES,
  FILLED_STATUSES,
  SKILLS_MAX,
  PROMPT_APPEND_MAX,
  ENV_VARS_MAX,
  ENV_VALUE_MAX,
  BUNDLE_ENTRIES_MAX,
  BUNDLE_BYTES_MAX,
  RESERVED_ENV,
  DOCKERFILE_INSTRUCTIONS,
  AGENT_PLUGIN_NAME,
  FULL_GIT_SHA,
  SECRETISH,
  isAgentPluginName,
  validatePluginCatalog,
  eccSourceAgreement,
  buildMatrix,
  matrixColumns,
  cellVersion,
  enabledSkills,
  bundledSkills,
  validateRequirements,
  requirementLines,
  validateEnv,
  findPlugin,
  pluginName,
};
