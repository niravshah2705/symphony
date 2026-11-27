'use strict';

/**
 * Standalone-skill catalog — the source of truth for packs that are ONE skill
 * rather than a plugin.
 *
 * The distinction is not cosmetic, and it is why this track has its own CSV,
 * folder and pipeline. cloudflare/security-audit-skill ships a single
 * `skills/security-audit/` tree: no `plugin.json`, no per-harness manifests,
 * no version file, no releases and no tags. So
 *
 *   - it is attached through `AgentTemplate.spec.skills[].source` with a
 *     `path:` into the artifact, not through `spec.plugins[]`;
 *   - there is no skills allowlist to write, because the artifact is the skill;
 *   - there is no upstream version to equal the bundle version, so the
 *     artifact's label IS the pinned commit (`version == commit[0:12]`) and the
 *     preflight asserts the SKILL.md exists at that commit instead of
 *     comparing a version string;
 *   - a `mcp.json` cannot come from it: standalone skills declare no servers.
 *
 * Pure: Node built-ins only.
 */

const {
  AGENT_PLUGIN_NAME,
  FULL_GIT_SHA,
  KAGENT_ENGINES,
  STATUSES,
  FILLED_STATUSES,
  PROMPT_APPEND_MAX,
  validateRequirements,
  requirementLines,
  isAgentPluginName,
} = require('./plugin-catalog');

const SKILLS = require('./skill-catalog.json');

/**
 * A pack may keep its version nowhere. `none` is then the declared source, and
 * the artifact version must be the pinned commit rather than an invented
 * number — a `1.0.0` on an unversioned upstream is a version nobody can verify
 * against anything.
 */
const VERSION_SOURCES = Object.freeze(['none', 'VERSION', 'plugin.json', 'package.json', 'pyproject.toml']);

const ENTRY_FILE = 'SKILL.md';
const PIN_LABEL_LENGTH = 12;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function push(list, condition, message) {
  if (!condition) list.push(message);
}

/** The version label an unversioned upstream pin earns. */
function pinVersion(commit) {
  return String(commit || '').slice(0, PIN_LABEL_LENGTH);
}

function cellVersion(skill, cliKey) {
  const entry = skill && skill.harnesses && skill.harnesses[cliKey];
  if (!entry || !FILLED_STATUSES.includes(entry.status)) return '';
  return entry.version || '';
}

/**
 * The support matrix for skill rows. Kept shaped exactly like the plugin one so
 * `scripts/seed-plugin-catalog.js` can write both into `plugin-support.csv`
 * with one `kind` column separating them.
 */
function buildMatrix(columns) {
  const rows = [];
  for (const skill of SKILLS.skills || []) {
    const cells = {};
    for (const column of columns) cells[column] = cellVersion(skill, column);
    rows.push({ id: skill.id, label: skill.label, kind: 'skill', cells });
  }
  return rows;
}

function validateSkill(skill, index, errors) {
  const where = `skills[${index}]${skill && skill.id ? ` (${skill.id})` : ''}`;
  if (!isPlainObject(skill)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  push(errors, isAgentPluginName(skill.id),
    `${where}: id "${skill.id}" is not a valid skill directory name`);
  push(errors, typeof skill.label === 'string' && skill.label.length > 0, `${where}: label is required`);

  const upstream = skill.upstream || {};
  push(errors, typeof upstream.repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(upstream.repository || ''),
    `${where}: upstream.repository must be "owner/name"`);
  push(errors, /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(upstream.url || ''),
    `${where}: upstream.url must be the clone URL ending in .git`);
  push(errors, FULL_GIT_SHA.test(upstream.commit || ''),
    `${where}: upstream.commit must be exactly 40 lowercase hex — a standalone skill has no tag to fall back on, so the pin is its identity`);
  push(errors, VERSION_SOURCES.includes(upstream.versionSource),
    `${where}: upstream.versionSource must be one of ${VERSION_SOURCES.join(', ')}`);
  push(errors, /^\d{4}-\d{2}-\d{2}$/.test(upstream.pinnedAt || ''), `${where}: upstream.pinnedAt must be YYYY-MM-DD`);
  push(errors, typeof upstream.license === 'string' && upstream.license.length > 0, `${where}: upstream.license is required`);
  if (upstream.versionSource === 'none') {
    push(errors, upstream.tags === false && upstream.releases === false,
      `${where}: versionSource "none" claims there is no version upstream — set releases and tags to what the repository actually has`);
  }

  const artifact = skill.artifact || {};
  push(errors, artifact.entryFile === ENTRY_FILE,
    `${where}: artifact.entryFile must be ${ENTRY_FILE}; a directory without it is not mountable as a skill`);
  push(errors, artifact.skillPath === `skills/${skill.id}`,
    `${where}: artifact.skillPath must be skills/${skill.id} — the directory name IS the skill name kagent offers to the model`);
  push(errors, /\/skills\/[^/]+\/Dockerfile\.[^/]+-skill$/.test(artifact.dockerfile || ''),
    `${where}: artifact.dockerfile must be deploy/kagent/skills/<id>/Dockerfile.<id>-skill`);
  push(errors, /^ghcr\.io\/[^/]+\/[^/]+\/[^/]+-skill$/.test(artifact.image || ''),
    `${where}: artifact.image must be a ghcr repository ending in "-skill" (a skill artifact and a plugin bundle are different artifacts)`);
  push(errors, artifact.compose === 'deploy/kagent/compose-skill-bundle.sh',
    `${where}: artifact.compose must be the skill composer, not the plugin composer`);
  push(errors, artifact.digest === null || /^sha256:[0-9a-f]{64}$/.test(artifact.digest || ''),
    `${where}: artifact.digest must be null until published, or a sha256 digest`);
  const expectedVersion = upstream.versionSource === 'none' ? pinVersion(upstream.commit) : upstream.release;
  push(errors, artifact.version === expectedVersion,
    `${where}: artifact.version ${artifact.version} must equal ${upstream.versionSource === 'none' ? `the pinned commit prefix ${expectedVersion}` : `the upstream release ${expectedVersion}`}`);

  push(errors, skill.icon && skill.icon.file === `public/icons/skills/${skill.id}.svg`,
    `${where}: icon.file must be public/icons/skills/${skill.id}.svg`);
  push(errors, skill.icon && skill.icon.href === `/icons/skills/${skill.id}.svg`,
    `${where}: icon.href must be the same-origin /icons/skills/${skill.id}.svg`);

  push(errors, Array.isArray(skill.references) && skill.references.length > 0,
    `${where}: references must list the files the skill reads — a skill that only ships SKILL.md loses its phases when the agent cannot open them`);
  push(errors, !skill.references.includes(ENTRY_FILE), `${where}: references lists what SKILL.md points at, not SKILL.md itself`);

  push(errors, typeof skill.promptAppend === 'string' && skill.promptAppend.length > 0,
    `${where}: promptAppend is required`);
  push(errors, String(skill.promptAppend || '').length <= PROMPT_APPEND_MAX,
    `${where}: promptAppend exceeds ${PROMPT_APPEND_MAX} chars`);

  validateRequirements(skill.requirements, where, errors);

  // There is no allowlist here, so a record that looks like a plugin bundle is
  // a shape error rather than a style preference.
  push(errors, skill.skills === undefined,
    `${where}: a standalone skill has no skills allowlist; declare it in plugin-catalog.json instead`);

  const harnesses = skill.harnesses;
  push(errors, isPlainObject(harnesses) && Object.keys(harnesses || {}).length > 0,
    `${where}: harnesses must declare at least one column`);
  for (const [key, entry] of Object.entries(harnesses || {})) {
    const at = `${where}: harnesses.${key}`;
    push(errors, isPlainObject(entry), `${at}: must be an object`);
    if (!isPlainObject(entry)) continue;
    push(errors, KAGENT_ENGINES.includes(entry.engine), `${at}: engine must be one of ${KAGENT_ENGINES.join(', ')}`);
    push(errors, STATUSES.includes(entry.status), `${at}: status must be one of ${STATUSES.join(', ')}`);
    push(errors, entry.mcp === false || entry.mcp === undefined,
      `${at}: a standalone skill declares no mcp.json; only a plugin bundle can`);
    if (entry.status === 'unsupported') {
      push(errors, typeof entry.blockedOn === 'string' && entry.blockedOn.length > 0,
        `${at}: an unsupported cell must name what it is blocked on`);
    } else {
      push(errors, entry.version === artifact.version, `${at}: cell version ${entry.version} != artifact version ${artifact.version}`);
    }
  }
}

/** @returns {{ok:boolean, errors:string[]}} */
function validateSkillCatalog(catalog = SKILLS) {
  const errors = [];
  if (!isPlainObject(catalog)) return { ok: false, errors: ['skill catalog must be an object'] };
  push(errors, catalog.schemaVersion === 'plugin-skill-catalog/v1' || catalog.schemaVersion === 'skill-catalog/v1',
    `schemaVersion must be skill-catalog/v1, got ${JSON.stringify(catalog.schemaVersion)}`);
  push(errors, catalog.mountContract === 'AgentTemplate.spec.skills[].source.oci + path',
    `mountContract must name the standalone-skill mount, got ${JSON.stringify(catalog.mountContract)}`);
  push(errors, Array.isArray(catalog.skills) && catalog.skills.length > 0, 'skills must be a non-empty array');
  const seen = new Set();
  for (const [index, skill] of (catalog.skills || []).entries()) {
    validateSkill(skill, index, errors);
    if (skill && typeof skill.id === 'string') {
      push(errors, !seen.has(skill.id), `duplicate skill id "${skill.id}"`);
      seen.add(skill.id);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** @returns {object|null} */
function findSkill(id, catalog = SKILLS) {
  return ((catalog && catalog.skills) || []).find((skill) => skill && skill.id === id) || null;
}

module.exports = {
  SKILLS,
  VERSION_SOURCES,
  ENTRY_FILE,
  PIN_LABEL_LENGTH,
  pinVersion,
  cellVersion,
  buildMatrix,
  findSkill,
  validateSkillCatalog,
  requirementLines,
};
