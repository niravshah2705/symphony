'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  validateSkillName,
  assertContained,
  assertNoSymlinks,
  claimSkillsDirectory,
  safeCopyDir,
  SKILLS_OWNER_MARKER,
} = require('./fs-guards');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsguards-'));
}

test('validateSkillName rejects traversal / separators', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../x']) {
    assert.throws(() => validateSkillName(bad), /Invalid skill name/);
  }
  assert.equal(validateSkillName('web-research'), 'web-research');
});

test('assertContained blocks escapes from the root', () => {
  const root = tmp();
  assert.doesNotThrow(() => assertContained(root, path.join(root, 'a', 'b')));
  assert.throws(() => assertContained(root, path.join(root, '..', 'evil')), /outside destination root/);
  assert.throws(() => assertContained(root, '/etc/passwd'), /outside destination root/);
});

test('assertNoSymlinks refuses a symlinked entry', () => {
  const root = tmp();
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'f.txt'), 'x');
  assert.doesNotThrow(() => assertNoSymlinks(real));
  const link = path.join(root, 'link');
  fs.symlinkSync('/etc', link);
  assert.throws(() => assertNoSymlinks(link), /symbolic link/);
});

test('claimSkillsDirectory refuses an unmarked pre-existing dir', () => {
  const root = fs.realpathSync(tmp());
  const dest = path.join(root, '.agent-skills');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, 'preexisting.txt'), 'user data');
  assert.throws(() => claimSkillsDirectory(dest, root), /ownership marker/);
});

test('claimSkillsDirectory creates + marks a fresh dir, then reuses it', () => {
  const root = fs.realpathSync(tmp());
  const dest = path.join(root, '.agent-skills');
  claimSkillsDirectory(dest, root);
  assert.ok(fs.existsSync(path.join(dest, SKILLS_OWNER_MARKER)));
  assert.doesNotThrow(() => claimSkillsDirectory(dest, root)); // idempotent reuse
});

test('safeCopyDir copies a clean tree and refuses a symlinked source', () => {
  const root = fs.realpathSync(tmp());
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'SKILL.md'), 'hi');
  const dst = path.join(root, 'dst');
  safeCopyDir(src, dst, root);
  assert.equal(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8'), 'hi');

  const badSrc = path.join(root, 'badsrc');
  fs.mkdirSync(badSrc);
  fs.symlinkSync('/etc/hosts', path.join(badSrc, 'link'));
  assert.throws(() => safeCopyDir(badSrc, path.join(root, 'dst2'), root), /symbolic link/);
});
