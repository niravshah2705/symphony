'use strict';

// The guest broker's whole purpose is to be a small enough attack surface that
// handing it a publishing credential is defensible. These tests are what keep it
// small: the dependency graph, the outbound hosts, the bind address, and the
// rule that every mutating route is token-gated before it reaches the ledger.
//
// They are structural rather than behavioural on purpose. A reviewer cannot see
// "this service holds the only hosting credential" in a diff of a route handler;
// they can see that the service imports no tenant client, calls no host but
// Firebase, and would refuse to start on a public bind without saying so.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVICE_ROOT, '..', '..');
const heavyWorkspace = ['@software-factory', 'shared'].join('/');
const coreWorkspace = `${heavyWorkspace}-core`;

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const source = read('services', 'guest-deployer', 'src', 'server.js');
const configSource = read('services', 'guest-deployer', 'src', 'deploy-config.js');

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    // Installed dependencies are not the broker's shipped source. Without this,
    // the host allowlist below reads whatever npm put in this workspace — a
    // google-auth-library install alone adds ~75 files mentioning nodejs.org,
    // example.com and sts., and the gate that must be deterministic turns on
    // whether anyone ran `npm install` since the last clean checkout.
    if (entry.name === 'node_modules') return [];
    if (entry.isDirectory()) return javascriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
  });
}

function staticRequires(sourceText) {
  return [...sourceText.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
}

const shippedFiles = javascriptFiles(SERVICE_ROOT).filter((file) => !file.endsWith('.test.js'));

test('the broker imports shared-core and no heavy AI workspace', () => {
  const forbidden = new Set([
    heavyWorkspace,
    ['lang', 'chain'].join(''),
    ['deep', 'agents'].join(''),
    ['@openai', ['codex', 'sdk'].join('-')].join('/'),
    ['@anthropic-ai', ['claude', 'agent', 'sdk'].join('-')].join('/'),
  ]);
  const violations = [];
  for (const file of shippedFiles) {
    for (const specifier of staticRequires(read(file))) {
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (forbidden.has(packageName)) violations.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(violations, [], 'a model or agent runtime would put code the guest never approved inside the credential holder');

  const manifest = JSON.parse(read(SERVICE_ROOT, 'package.json'));
  assert.equal(manifest.dependencies[coreWorkspace], '*');
  assert.equal(manifest.dependencies[heavyWorkspace], undefined);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [coreWorkspace, 'google-auth-library'],
    'the only runtime dependency the hosting call needs is the token mint');
});

test('the broker reaches no tenant service and no model gateway', () => {
  // The broker talks to exactly one upstream. Anything else — the org service,
  // settings, the orchestrator, an LLM — would turn a preview publisher into a
  // caller that can read tenant state with a guest-supplied token.
  const hosts = new Set();
  for (const file of shippedFiles) {
    for (const [, host] of read(file).matchAll(/https:\/\/([a-z0-9.-]+)/g)) hosts.add(host);
  }
  assert.deepEqual([...hosts].sort(), [
    'firebasehosting.googleapis.com',
    'www.googleapis.com',
  ], `unexpected outbound hosts: ${[...hosts].join(', ')}`);

  const forbiddenSpecifiers = /(?:createProxy|orchestrator|substrate-runner|agent\/registry\/plugin|settings|org\/client)/;
  for (const file of shippedFiles) {
    assert.doesNotMatch(staticRequires(read(file)).join(' '), forbiddenSpecifiers,
      `${path.relative(REPO_ROOT, file)} imports a tenant-side module`);
  }
  // And the boundary is HTTP in both directions: the gateway never imports the
  // broker's package, so it cannot borrow the credential by requiring the code.
  const gatewayFiles = javascriptFiles(path.join(REPO_ROOT, 'services', 'gateway', 'src'));
  for (const file of gatewayFiles) {
    assert.doesNotMatch(staticRequires(read(file)).join(' '), /@software-factory\/guest-deployer|\.\.\/\.\.\/guest-deployer/,
      `${path.relative(REPO_ROOT, file)} reaches into the broker in-process instead of over its RPCs`);
  }
});

test('every mutating route authenticates before it reaches the ledger', () => {
  for (const verb of ['status', 'remove', 'redeploy', 'deploy']) {
    assert.match(source, new RegExp(`service\\.${verb}\\(`), `the ${verb} route disappeared`);
  }
  // One gate in front of every dispatch: the presented token is compared before
  // any handler runs, so a new RPC is authenticated by default rather than by
  // whoever remembers to add a check.
  const auth = source.indexOf('tokenMatches(req.headers');
  assert.ok(auth > 0, 'the token comparison moved out of the request handler');
  for (const verb of ['status', 'remove', 'redeploy', 'deploy']) {
    assert.ok(source.indexOf(`service.${verb}(`) > auth, `service.${verb} is reachable before the token check`);
  }
  // Each token-bearing path re-validates the URL segment through the same
  // helper the ledger uses, so a malformed token cannot reach a file write.
  assert.equal((source.match(/releases\.requireToken\(/g) || []).length, 3,
    'status, remove and redeploy each validate the presented preview token');

  const health = /if \(\(path === '\/healthz' \|\| path === '\/health'\)[\s\S]*?\n    \}/.exec(source);
  assert.ok(health, 'the health route moved');
  assert.doesNotMatch(health[0], /token/, 'a health probe must not need the credential');
  assert.ok(source.indexOf('tokenMatches(req.headers') > (health ? health.index : -1),
    'the unauthenticated probe must answer before the credential gate, or the startup probe fails closed');

  // The comparison is constant-time over digests, never a string equality.
  assert.match(source, /crypto\.timingSafeEqual/);
  assert.doesNotMatch(source, /provided === expected|===\s*config\.token\b/);
});

test('the broker binds loopback unless deployment says otherwise, and says so', () => {
  // Same contract as the egress sidecar's PROXY_BIND_HOST: a Cloud Run container
  // that binds 127.0.0.1 answers nothing, and a local run that binds 0.0.0.0
  // exposes the RPCs on the LAN. The default is the safe one in each place.
  assert.match(configSource, /'127\.0\.0\.1'/);
  assert.match(configSource, /GUEST_DEPLOY_BIND_HOST must be 127\.0\.0\.1 or 0\.0\.0\.0/);
  assert.match(source, /server\.listen\(config\.port, config\.bindHost/);

  const cloudRun = read('deploy', 'gcp', 'terraform', 'guest_deployer_service.tf').replace(/^\s*#.*$/gm, '');
  assert.match(cloudRun, /name\s*=\s*"GUEST_DEPLOY_BIND_HOST"\s*\n\s*value\s*=\s*"0\.0\.0\.0"/,
    'the deployed broker would bind loopback and answer every request with a connection refused');

  // Fail-closed on the credential too: no token, no service.
  assert.match(configSource, /GUEST_DEPLOY_INTERNAL_TOKEN/);
  assert.match(configSource, /MIN_TOKEN_CHARS = 16/,
    'a short shared secret is brute-forceable over the RPC');
});

test('the broker image carries only the bundles it publishes', () => {
  const dockerfile = read('deploy', 'gcp', 'Dockerfile.guest-deployer');
  assert.match(dockerfile, /^COPY packages\/shared-core\/ \.\/packages\/shared-core\/$/m);
  assert.match(dockerfile, /^COPY services\/guest-deployer\/ \.\/services\/guest-deployer\/$/m);
  assert.doesNotMatch(dockerfile, /^COPY packages\/ \.\/packages\/$/m);
  assert.doesNotMatch(dockerfile, /^COPY services\/ \.\/services\/$/m);
  assert.match(dockerfile, /--workspace=@software-factory\/shared-core/);
  assert.match(dockerfile, /--workspace=@software-factory\/guest-deployer/);
  assert.match(dockerfile, /--include-workspace-root=false/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^CMD \["node", "services\/guest-deployer\/src\/server\.js"\]$/m);
});

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
