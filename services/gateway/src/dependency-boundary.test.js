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

test('gateway source imports shared-core and no heavy AI workspace or agent package', () => {
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

test('gateway manifest declares shared-core, while its dependency closure declares no agent SDK', () => {
  const gateway = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf8'));
  assert.equal(gateway.dependencies[coreWorkspace], '*');
  assert.equal(gateway.dependencies[heavyWorkspace], undefined);

  const core = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/shared-core/package.json'), 'utf8'));
  const names = Object.keys(core.dependencies || {});
  const forbiddenFragments = [
    ['lang', 'chain'].join(''),
    ['deep', 'agents'].join(''),
    ['codex', 'sdk'].join('-'),
    ['claude', 'agent', 'sdk'].join('-'),
  ];
  assert.deepEqual(names.filter((name) => forbiddenFragments.some((part) => name.includes(part))), []);
});

test('gateway image copies only its service and shared-core workspaces', () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'deploy/gcp/Dockerfile.gateway'), 'utf8');
  assert.match(dockerfile, /^COPY packages\/shared-core\/ \.\/packages\/shared-core\/$/m);
  assert.match(dockerfile, /^COPY services\/gateway\/ \.\/services\/gateway\/$/m);
  assert.match(dockerfile, /--workspace=@ai-fleet\/shared-core/);
  assert.match(dockerfile, /--workspace=@ai-fleet\/gateway/);
  assert.match(dockerfile, /--include-workspace-root=false/);
  assert.doesNotMatch(dockerfile, /^COPY packages\/ \.\/packages\/$/m);
  assert.doesNotMatch(dockerfile, /^COPY services\/ \.\/services\/$/m);
});

test('heavy public routes proxy to planner and tombstones mount before SPA fallback', () => {
  const gatewayIndex = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const plannerIndex = fs.readFileSync(path.join(REPO_ROOT, 'services/planner/src/index.js'), 'utf8');
  for (const prefix of [
    '/api/settings', '/api/observability', '/api/projects',
    '/api/issues', '/api/businesses', '/api/roles',
  ]) {
    assert.match(gatewayIndex, new RegExp(`app\\.use\\('${prefix.replaceAll('/', '\\/')}'[^\\n]+plannerProxy`));
  }
  assert.match(gatewayIndex, /app\.use\('\/api\/locale', localeProxy\)/);
  for (const prefix of [
    '/api/settings/codex', '/api/settings/claude', '/api/settings',
    '/api/observability', '/api/locale', '/api/projects', '/api/issues',
    '/api/businesses', '/api/roles',
  ]) {
    assert.match(plannerIndex, new RegExp(`app\\.use\\('${prefix.replaceAll('/', '\\/')}'[^\\n]+Routes`));
  }
  assert.ok(
    gatewayIndex.indexOf('mountRemovedAgentRouteTombstones(app)')
      < gatewayIndex.indexOf('app.use(express.static'),
  );
});
