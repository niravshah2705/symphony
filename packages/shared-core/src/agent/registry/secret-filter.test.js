'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDenied, copyTreeFiltered, sanitizeMcpDescriptor } = require('./secret-filter');

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secfilter-')));
}

test('isDenied flags secrets and VCS/build noise but keeps normal files', () => {
  for (const bad of ['auth.json', '.env', '.env.production', 'server.pem', 'tls.key',
    'id_rsa', 'api-key.txt', 'credentials.json', 'auth-token.json', '.git', 'node_modules',
    '.mcp.json', 'mcp.json']) {
    assert.equal(isDenied(bad), true, `${bad} should be denied`);
  }
  for (const ok of ['SKILL.md', 'plugin.json', 'tokenizer.js', 'security.md', 'README.md', 'index.js']) {
    assert.equal(isDenied(ok), false, `${ok} should be allowed`);
  }
});

test('copyTreeFiltered excludes secrets, .git and symlinks but copies payload', () => {
  const root = tmp();
  const src = path.join(root, 'plugin');
  fs.mkdirSync(path.join(src, 'skills', 'raven'), { recursive: true });
  fs.mkdirSync(path.join(src, '.git'), { recursive: true });
  fs.writeFileSync(path.join(src, 'plugin.json'), '{}');
  fs.writeFileSync(path.join(src, 'skills', 'raven', 'SKILL.md'), 'body');
  fs.writeFileSync(path.join(src, 'auth.json'), 'SECRET');
  fs.writeFileSync(path.join(src, '.env'), 'TOKEN=xyz');
  fs.writeFileSync(path.join(src, '.git', 'config'), 'gitstuff');
  fs.symlinkSync('/etc/hosts', path.join(src, 'evil-link'));

  const dst = path.join(root, 'out');
  const warnings = copyTreeFiltered(src, dst, { realRoot: root });

  assert.ok(fs.existsSync(path.join(dst, 'plugin.json')));
  assert.ok(fs.existsSync(path.join(dst, 'skills', 'raven', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(dst, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(dst, '.env')), false);
  assert.equal(fs.existsSync(path.join(dst, '.git')), false);
  assert.equal(fs.existsSync(path.join(dst, 'evil-link')), false);
  assert.ok(warnings.some((w) => /auth\.json/.test(w)));
  assert.ok(warnings.some((w) => /symlink/.test(w)));
});

test('copyTreeFiltered skips oversized files', () => {
  const root = tmp();
  const src = path.join(root, 's');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(src, 'small.txt'), 'ok');
  const dst = path.join(root, 'o');
  const warnings = copyTreeFiltered(src, dst, { realRoot: root, maxFileBytes: 512 });
  assert.equal(fs.existsSync(path.join(dst, 'small.txt')), true);
  assert.equal(fs.existsSync(path.join(dst, 'big.bin')), false);
  assert.ok(warnings.some((w) => /oversized/.test(w)));
});

test('sanitizeMcpDescriptor keeps transport fields and strips secrets', () => {
  const clean = sanitizeMcpDescriptor({
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    url: null,
    headers: { Authorization: 'Bearer sk-secret' },
    env: { LINEAR_API_KEY: 'lin_secret' },
  });
  assert.deepEqual(clean, { command: 'npx', args: ['-y', '@playwright/mcp@latest'], url: null });
  assert.equal('headers' in clean, false);
  assert.equal('env' in clean, false);
});
