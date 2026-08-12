'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeBundle } = require('./bundle-writer');
const { normalize } = require('./normalizer');
const { readPlugin, readVendoredSkill } = require('./native-reader');

const FIXTURE_MP = path.join(__dirname, '__fixtures__', 'marketplace');
const VENDORED = path.join(__dirname, '__fixtures__', 'vendored-skills');

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-')));
}

function buildRegistry() {
  return normalize([
    readVendoredSkill(VENDORED, 'web-research'),
    readPlugin(FIXTURE_MP, {
      name: 'security', marketplace: 'test-marketplace', version: '1.6.2',
      ref: 'abc1234', sourceRepo: 'test/marketplace', sourceUrl: null,
    }),
  ], { version: 'v1' });
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of fs.readdirSync(cur)) {
      const p = path.join(cur, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) out.push(p);
    }
  }
  return out;
}

test('writeBundle emits dual original + generic trees', () => {
  const out = tmp();
  const res = writeBundle(buildRegistry(), out, { generatedAt: '2026-08-12T00:00:00Z' });
  const V = path.join(out, 'v1');

  // generic tree
  assert.ok(fs.existsSync(path.join(V, 'generic', 'registry.json')));
  assert.ok(fs.existsSync(path.join(V, 'generic', 'skills', 'web-research', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(V, 'generic', 'skills', 'security__raven', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(V, 'generic', 'plugins', 'test-marketplace', 'security', '1.6.2', '.claude-plugin', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(V, 'generic', 'mcp', 'security-scanner.json')));

  // original tree
  assert.ok(fs.existsSync(path.join(V, 'original', 'skills', 'web-research', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(V, 'original', 'test-marketplace', 'security', '1.6.2', '.claude-plugin', 'plugin.json')));

  // top-level pointer
  const pointer = JSON.parse(fs.readFileSync(path.join(out, 'registry-manifest.json'), 'utf8'));
  assert.equal(pointer.version, 'v1');
  assert.equal(res.warnings.some((w) => /auth\.json/.test(w)), true); // the planted secret was skipped
});

test('no planted secret reaches EITHER tree or registry.json', () => {
  const out = tmp();
  writeBundle(buildRegistry(), out, { generatedAt: 'x' });
  const files = walkFiles(path.join(out, 'v1'));
  // auth.json must not exist anywhere
  assert.equal(files.some((f) => path.basename(f) === 'auth.json'), false);
  // and none of the planted secret material appears in any published file
  const forbidden = [/PLANTED-SECRET/, /super-secret-should-be-stripped/, /Bearer sk-should-be-stripped/, /SCAN_TOKEN/];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of forbidden) assert.equal(re.test(text), false, `${re} leaked into ${f}`);
  }
});

test('generic MCP descriptor keeps transport fields, drops secrets', () => {
  const out = tmp();
  writeBundle(buildRegistry(), out, { generatedAt: 'x' });
  const mcp = JSON.parse(fs.readFileSync(path.join(out, 'v1', 'generic', 'mcp', 'security-scanner.json'), 'utf8'));
  assert.equal(mcp.command, 'npx');
  assert.deepEqual(mcp.args, ['-y', '@test/scanner@1.0.0']);
  assert.equal('env' in mcp, false);
  assert.equal('headers' in mcp, false);
});

test('published registry.json strips build-time sourceDir and stamps generatedAt', () => {
  const out = tmp();
  writeBundle(buildRegistry(), out, { generatedAt: '2026-08-12T00:00:00Z' });
  const text = fs.readFileSync(path.join(out, 'v1', 'generic', 'registry.json'), 'utf8');
  assert.equal(/sourceDir/.test(text), false);
  const reg = JSON.parse(text);
  assert.equal(reg.generatedAt, '2026-08-12T00:00:00Z');
  assert.ok(reg.entries.length >= 5);
});

test('a symlink in a skill source is skipped, not followed', () => {
  const out = tmp();
  const src = tmp();
  const skillDir = path.join(src, 'evil-skill');
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: evil-skill\ndescription: x\n---\nbody');
  fs.symlinkSync('/etc/hosts', path.join(skillDir, 'link'));

  const registry = {
    schemaVersion: 'registry/v1',
    version: 'v1',
    entries: [{
      id: 'skill:evil-skill', dedupeKey: 'skill:evil-skill', kind: 'skill', name: 'evil-skill',
      description: 'x', version: { normalized: '0.0.0-unknown', scheme: 'unknown', raw: null, conflict: false },
      provenance: [], adapters: {}, incomplete: false,
      payload: { path: 'skills/evil-skill', entrypoint: 'SKILL.md', sourceDir: skillDir, providedByPlugin: null },
    }],
  };
  const res = writeBundle(registry, out, { generatedAt: 'x' });
  assert.ok(fs.existsSync(path.join(out, 'v1', 'generic', 'skills', 'evil-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(out, 'v1', 'generic', 'skills', 'evil-skill', 'link')), false);
  assert.ok(res.warnings.some((w) => /symlink/.test(w)));
});

test('an unsafe version segment is rejected', () => {
  const registry = buildRegistry();
  registry.version = '../evil';
  assert.throws(() => writeBundle(registry, tmp(), {}), /Unsafe/);
});
