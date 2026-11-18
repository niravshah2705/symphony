'use strict';

/**
 * Tests for the standalone-skill catalog. The shape this file defends is the one
 * that makes cloudflare/security-audit-skill attachable at all: an unversioned
 * upstream whose artifact version is its pin, mounted through
 * `AgentTemplate.spec.skills[]` with a `path:`, and carrying no allowlist and no
 * mcp.json because a single skill directory has neither.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SKILLS,
  VERSION_SOURCES,
  ENTRY_FILE,
  PIN_LABEL_LENGTH,
  pinVersion,
  cellVersion,
  buildMatrix,
  findSkill,
  validateSkillCatalog,
} = require('./skill-catalog');
const { MATRIX_COLUMNS, STATUSES, FULL_GIT_SHA, DOCKERFILE_INSTRUCTIONS } = require('./plugin-catalog');

const ROOT = path.resolve(__dirname, '../../../../..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorFor(mutate) {
  const catalog = clone(SKILLS);
  mutate(catalog);
  const { errors } = validateSkillCatalog(catalog);
  assert.ok(errors.length > 0, 'expected the mutation to be rejected');
  return errors;
}

const AUDIT = findSkill('security-audit');

test('the shipped skill catalog validates clean', () => {
  const { ok, errors } = validateSkillCatalog(SKILLS);
  assert.deepEqual(errors, [], errors.join('\n'));
  assert.equal(ok, true);
});

test('the catalog declares the mount it exists for', () => {
  assert.equal(SKILLS.mountContract, 'AgentTemplate.spec.skills[].source.oci + path');
  assert.equal(SKILLS.schemaVersion, 'skill-catalog/v1');
  const errors = errorFor((c) => { c.mountContract = 'AgentTemplate.spec.plugins[0]'; });
  assert.match(errors.join('\n'), /mountContract must name the standalone-skill mount/);
});

test('the pin is a full commit, because an unversioned upstream has no tag to fall back on', () => {
  assert.match(AUDIT.upstream.commit, FULL_GIT_SHA);
  for (const commit of ['c1c8a8c14710', 'c1c8a8c1471069fb0e188eeaff69b8e8db6564a', 'C1C8A8C1471069FB0E188EEAFF69B8E8DB6564A8']) {
    const errors = errorFor((c) => { c.skills[0].upstream.commit = commit; });
    assert.match(errors.join('\n'), /exactly 40 lowercase hex/);
  }
});

test('versionSource "none" means the artifact label IS the pin, and nothing else', () => {
  assert.deepEqual(VERSION_SOURCES, ['none', 'VERSION', 'plugin.json', 'package.json', 'pyproject.toml']);
  assert.equal(AUDIT.upstream.versionSource, 'none');
  assert.equal(AUDIT.upstream.releases, false);
  assert.equal(AUDIT.upstream.tags, false);
  assert.equal(AUDIT.artifact.version, AUDIT.upstream.commit.slice(0, PIN_LABEL_LENGTH));
  assert.equal(pinVersion(AUDIT.upstream.commit), AUDIT.artifact.version);

  // An invented version on an upstream that states none cannot be verified
  // against anything, so it is rejected rather than reviewed.
  for (const version of ['1.0.0', '2026-11-19', AUDIT.upstream.commit]) {
    const errors = errorFor((c) => { c.skills[0].artifact.version = version; });
    assert.match(errors.join('\n'), /must equal the pinned commit prefix/);
  }
  const claims = errorFor((c) => { c.skills[0].upstream.tags = true; });
  assert.match(claims.join('\n'), /versionSource "none" claims there is no version upstream/);
});

test('the mount path and the directory name are the same fact, checked once', () => {
  assert.equal(AUDIT.artifact.skillPath, `skills/${AUDIT.id}`);
  assert.equal(AUDIT.artifact.entryFile, ENTRY_FILE);
  const errors = errorFor((c) => { c.skills[0].artifact.skillPath = 'skills/security_audit'; });
  assert.match(errors.join('\n'), /the directory name IS the skill name/);
  const noEntry = errorFor((c) => { c.skills[0].artifact.entryFile = 'README.md'; });
  assert.match(noEntry.join('\n'), /artifact.entryFile must be SKILL.md/);
});

test('a skill artifact is a different artifact from a plugin bundle', () => {
  assert.match(AUDIT.artifact.image, /-skill$/);
  assert.match(AUDIT.artifact.dockerfile, /deploy\/kagent\/skills\/security-audit\/Dockerfile\.security-audit-skill$/);
  assert.equal(AUDIT.artifact.compose, 'deploy/kagent/compose-skill-bundle.sh');
  for (const [field, value] of [
    ['image', 'ghcr.io/niravshah2705/symphony/security-audit'],
    ['dockerfile', 'deploy/kagent/security-audit/Dockerfile.security-audit'],
    ['compose', 'deploy/kagent/ecc-plugin/compose-bundle.sh'],
  ]) {
    const errors = errorFor((c) => { c.skills[0].artifact[field] = value; });
    assert.ok(errors.length > 0, `artifact.${field} = ${value} should be rejected`);
  }
});

test('a standalone skill has no allowlist and declares no MCP servers', () => {
  assert.equal(AUDIT.skills, undefined);
  const errors = errorFor((c) => { c.skills[0].skills = [{ name: 'security-audit', enabled: true }]; });
  assert.match(errors.join('\n'), /has no skills allowlist/);
  const mcp = errorFor((c) => { c.skills[0].harnesses.codex.mcp = true; });
  assert.match(mcp.join('\n'), /declares no mcp\.json/);
});

test('the references list is what makes the phases reachable, and excludes the entry file', () => {
  assert.ok(AUDIT.references.length > 1);
  assert.equal(AUDIT.references.includes(ENTRY_FILE), false);
  const empty = errorFor((c) => { c.skills[0].references = []; });
  assert.match(empty.join('\n'), /references must list the files the skill reads/);
  const self = errorFor((c) => { c.skills[0].references = [ENTRY_FILE]; });
  assert.match(self.join('\n'), /not SKILL.md itself/);
});

test('every reference exists in the bundle the composer builds', () => {
  // The composer copies <skill_path>/SKILL.md and its siblings out of the pinned
  // checkout; a reference the record names but the tree lacks is a file the
  // agent will be told to open and will not find.
  const bundle = path.join(ROOT, 'deploy/kagent/skills/security-audit/build/bundle');
  if (!fs.existsSync(bundle)) return; // composed on demand; the validator is the gate
  const dir = path.join(bundle, AUDIT.artifact.skillPath);
  for (const file of [ENTRY_FILE, ...AUDIT.references]) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} listed but not in the bundle`);
  }
});

test('icon paths are same-origin and the helper and the record agree', () => {
  assert.equal(AUDIT.icon.file, `public/icons/skills/${AUDIT.id}.svg`);
  assert.equal(AUDIT.icon.href, `/icons/skills/${AUDIT.id}.svg`);
  assert.ok(fs.existsSync(path.join(ROOT, AUDIT.icon.file)), `${AUDIT.icon.file} is committed`);
  const errors = errorFor((c) => { c.skills[0].icon.href = 'https://raw.githubusercontent.com/cloudflare/security-audit-skill/main/icon.svg'; });
  assert.match(errors.join('\n'), /same-origin/);
});

test('requirements land in the harness runtime image, never in the skill artifact', () => {
  const { requirements } = AUDIT;
  assert.match(requirements.appliedTo, /^go\/harness\/[^/]+\/Dockerfile$/);
  for (const line of requirements.dockerfile) {
    assert.ok(DOCKERFILE_INSTRUCTIONS.includes(line.split(' ')[0]), line);
  }
  const errors = errorFor((c) => {
    c.skills[0].requirements.appliedTo = 'deploy/kagent/skills/security-audit/Dockerfile.security-audit-skill';
  });
  assert.match(errors.join('\n'), /must be a harness runtime image/);
});

test('every filled cell equals the artifact version, and blanks name a blocker', () => {
  for (const [key, entry] of Object.entries(AUDIT.harnesses)) {
    if (entry.status === 'unsupported') {
      assert.equal(cellVersion(AUDIT, key), '');
      assert.ok(entry.blockedOn, `${key}: unsupported must name what blocks it`);
    } else {
      assert.equal(cellVersion(AUDIT, key), AUDIT.artifact.version, `${key} cell`);
    }
  }
  const errors = errorFor((c) => { c.skills[0].harnesses.codex.version = '1.2.3'; });
  assert.match(errors.join('\n'), /cell version 1\.2\.3 != artifact version/);
});

test('the matrix row is shaped like the plugin rows so one CSV holds both tracks', () => {
  const columns = ['kagent', ...Object.keys(MATRIX_COLUMNS)];
  const [row] = buildMatrix(columns);
  assert.equal(row.kind, 'skill');
  assert.equal(row.id, AUDIT.id);
  assert.deepEqual(Object.keys(row.cells), columns);
  assert.equal(row.cells.codex, AUDIT.artifact.version);
  assert.equal(row.cells.deepagent, '', 'deepagent has no kagent engine, so no cell');
});

test('a status outside the legend, or an engine outside kagent enum, is rejected', () => {
  assert.ok(STATUSES.includes('declared'));
  const status = errorFor((c) => { c.skills[0].harnesses.codex.status = 'shipped'; });
  assert.match(status.join('\n'), /status must be one of/);
  const engine = errorFor((c) => { c.skills[0].harnesses.codex.engine = 'claude-sdk'; });
  assert.match(engine.join('\n'), /engine must be one of/);
});

test('malformed catalogs fail loudly rather than validating nothing', () => {
  assert.deepEqual(validateSkillCatalog(null).errors, ['skill catalog must be an object']);
  assert.match(validateSkillCatalog({ schemaVersion: 'skill-catalog/v1', mountContract: 'AgentTemplate.spec.skills[].source.oci + path', skills: [] }).errors.join('\n'), /non-empty array/);
  const dup = clone(SKILLS);
  dup.skills.push(clone(AUDIT));
  assert.match(validateSkillCatalog(dup).errors.join('\n'), /duplicate skill id "security-audit"/);
  const notObject = validateSkillCatalog({
    schemaVersion: 'skill-catalog/v1',
    mountContract: 'AgentTemplate.spec.skills[].source.oci + path',
    skills: ['security-audit'],
  });
  assert.match(notObject.errors.join('\n'), /must be an object/);
});

test('findSkill returns null for an id the catalog does not carry', () => {
  assert.equal(findSkill('nope'), null);
  assert.equal(findSkill(null), null);
});
