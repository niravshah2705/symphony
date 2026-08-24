'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVICE_ROOT, '..', '..');
const heavyWorkspace = ['@ai-fleet', 'shared'].join('/');
const coreWorkspace = `${heavyWorkspace}-core`;

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
  });
}

function staticRequires(source) {
  return [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
}

test('identity verification source imports shared-core and no heavy AI workspace', () => {
  const forbidden = new Set([
    heavyWorkspace,
    ['lang', 'chain'].join(''),
    ['deep', 'agents'].join(''),
    ['@openai', ['codex', 'sdk'].join('-')].join('/'),
    ['@anthropic-ai', ['claude', 'agent', 'sdk'].join('-')].join('/'),
  ]);
  const violations = [];
  for (const file of javascriptFiles(SERVICE_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of staticRequires(source)) {
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (forbidden.has(packageName)) violations.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('identity verification image copies only its service and shared-core workspaces', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies[coreWorkspace], '*');
  assert.equal(manifest.dependencies[heavyWorkspace], undefined);

  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'deploy/gcp/Dockerfile.identity-verification'), 'utf8');
  assert.match(dockerfile, /^COPY packages\/shared-core\/ \.\/packages\/shared-core\/$/m);
  assert.match(dockerfile, /^COPY services\/identity-verification\/ \.\/services\/identity-verification\/$/m);
  assert.match(dockerfile, /--workspace=@ai-fleet\/shared-core/);
  assert.match(dockerfile, /--workspace=@ai-fleet\/identity-verification/);
  assert.match(dockerfile, /--include-workspace-root=false/);
  assert.doesNotMatch(dockerfile, /^COPY packages\/ \.\/packages\/$/m);
  assert.doesNotMatch(dockerfile, /^COPY services\/ \.\/services\/$/m);
  assert.match(dockerfile, /^USER node$/m);
});
