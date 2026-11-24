'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVICE_ROOT, '..', '..');
const heavyWorkspace = ['@software-factory', 'shared'].join('/');
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

test('billing service source imports shared-core and no heavy AI workspace', () => {
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

test('billing service image copies only its service and shared-core workspaces', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies[coreWorkspace], '*');
  assert.equal(manifest.dependencies[heavyWorkspace], undefined);

  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'deploy/gcp/Dockerfile.billing'), 'utf8');
  assert.match(dockerfile, /^COPY packages\/shared-core\/ \.\/packages\/shared-core\/$/m);
  assert.match(dockerfile, /^COPY services\/billing\/ \.\/services\/billing\/$/m);
  // The rate card is the third thing this image needs, and it is the only COPY that does
  // not come from a workspace. Listed rather than covered by a `COPY deploy/` grant: the
  // image must not gain the rest of deploy/, and an unlisted file is a crash-loop at boot
  // that no unit test can see (deploy/billing/credit-rates.test.js holds the path contract).
  assert.match(dockerfile, /^COPY deploy\/billing\/credit-rates\.yaml \.\/deploy\/billing\/credit-rates\.yaml$/m);
  assert.match(dockerfile, /--workspace=@software-factory\/shared-core/);
  assert.match(dockerfile, /--workspace=@software-factory\/billing/);
  assert.match(dockerfile, /--include-workspace-root=false/);
  assert.doesNotMatch(dockerfile, /^COPY packages\/ \.\/packages\/$/m);
  assert.doesNotMatch(dockerfile, /^COPY services\/ \.\/services\/$/m);
  assert.doesNotMatch(dockerfile, /^COPY deploy\/ \.\/deploy\/$/m);
  assert.match(dockerfile, /^USER node$/m);
});
