'use strict';

// Structural contract for the sample "kagent harness in a tenant with LiteLLM on GKE":
//   - the example YAML is a well-formed, self-consistent tenant atespace surface
//     (Namespace + Harness + ModelConfig + Agent), all in the SAME namespace, with the
//     Agent's harnessRef pointing at the in-namespace Harness;
//   - no raw credential is ever baked into the agent (sentinel-only invariant);
//   - the LiteLLM route + sidecar-only origin + kagent adapter gating still hold.
//
// Self-contained on purpose: parse with a tiny indentation reader rather than the
// `yaml` package, so this runs under plain `node --test` without a devDependency.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const EXAMPLE = read(
  'deploy', 'gcp', 'terraform-substrate-gke', 'examples', 'kagent-litellm-harness.yaml'
);

// Split into documents on a `---` separator line, then flatten the lines we care about
// (strip comments, blank lines, and the leading indentation we don't model).
const docs = EXAMPLE.split(/^---\s*$/m)
  .map((chunk) => chunk.split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').replace(/\s+$/, '')) // drop trailing inline comments
    .filter((l) => l.trim() !== '' && !/^\s*#/.test(l)))
  .filter((lines) => lines.length > 0);

const docFor = (kind) => {
  const hit = docs.find((lines) => lines.some((l) => l.trim() === `kind: ${kind}`));
  assert.ok(hit, `expected a ${kind} document in the example`);
  return hit;
};
// First `key: value` scalar at exactly `indent` spaces of leading whitespace.
const scalarAt = (lines, key, indent) => {
  const re = new RegExp(`^ {${indent}}${key}:\\s*(\\S.*)?$`);
  const line = lines.find((l) => re.test(l));
  return line ? (line.match(re)[1] || '').trim() : undefined;
};
// Names of `- name: X` list items under the env block (indent 8), values at indent 8.
const envPairs = (lines) => {
  const names = [...lines.join('\n').matchAll(/^ {8}- name:\s*(\S+)/gm)].map((m) => m[1]);
  const values = [...lines.join('\n').matchAll(/^ {8}value:\s*(.+)$/gm)].map((m) => m[1].trim());
  return names.map((name, i) => ({ name, value: values[i] }));
};

const CRED_LITERAL = /\b(sk-ant-|sk-[A-Za-z0-9]{20,}|lsv2_|ghp_|gho_|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-)/;

test('example exposes the four expected kagent kinds', () => {
  for (const kind of ['Namespace', 'Harness', 'ModelConfig', 'Agent']) {
    docFor(kind); // throws if absent
  }
});

test('every workload resource lives in the single tenant namespace', () => {
  const ns = scalarAt(docFor('Namespace'), 'name', 2);
  assert.match(ns, /^tenant-[a-z0-9-]+$/, 'atespace namespace must follow the tenant-<slug> form');
  assert.match(docFor('Namespace').join('\n'), /substrate\.ate\.dev\/atespace:\s*"true"/);
  for (const kind of ['Harness', 'ModelConfig', 'Agent']) {
    const lines = docFor(kind);
    // metadata.namespace is the 2-space `namespace:` under a 0-space `metadata:` key.
    assert.equal(scalarAt(lines, 'namespace', 2), ns, `${kind} must be in the tenant atespace`);
  }
});

test('the Agent references an in-namespace Harness that selects a published runtime', () => {
  const harnessLines = docFor('Harness');
  const agentLines = docFor('Agent');
  const harnessName = scalarAt(harnessLines, 'name', 2);
  assert.equal(scalarAt(agentLines, 'name', 4), harnessName,
    'Agent.spec.harnessRef.name must point at the Harness declared here');

  // claude/codex/deepagent/deepseek are the runtimes with a published image today.
  const published = ['claude', 'codex', 'deepagent', 'deepseek'];
  const selected = published.filter((r) => harnessLines.some((l) => new RegExp(`^ {2}${r}:\\s*\\{\\}`).test(l)));
  assert.equal(selected.length, 1,
    'the sample Harness must select exactly one published runtime (not an experimental scaffold)');

  const joined = harnessLines.join('\n');
  assert.match(joined, /^ {6}name:\s*\S+/m, 'substrate.workerPoolRef.name is required');
  assert.match(joined, /location:\s*\S+/, 'substrate.snapshotPolicy.location is required');
});

test('the ModelConfig serves a BARE model id and points at the loopback sentinel route', () => {
  const lines = docFor('ModelConfig');
  const model = scalarAt(lines, 'model', 2);
  assert.doesNotMatch(model, /\//, 'model must be the bare id (no provider/ prefix)');
  const apiBase = scalarAt(lines, 'api_base', 2);
  assert.match(apiBase, /^http:\/\/127\.0\.0\.1:4030\/litellm/,
    'api_base must target the sidecar loopback /litellm route');
});

test('the agent surface bakes in no credential literal and no raw provider key', () => {
  const pairs = envPairs(docFor('Agent'));
  assert.ok(pairs.length >= 2, 'expected LOG_LEVEL/AGENT_MODEL env rows on the agent');
  for (const { name, value } of pairs) {
    assert.ok(!/API_KEY|TOKEN|SECRET|LITELLM/i.test(name), `agent env must not name a credential: ${name}`);
    assert.doesNotMatch(String(value || ''), CRED_LITERAL, `${name} must not carry a secret literal`);
  }
  assert.doesNotMatch(EXAMPLE.replace(/#.*/g, ''), CRED_LITERAL,
    'no credential-shaped literal may appear outside comments');
});

test('egress route + gating contract still holds for the litellm path', () => {
  // Assert on the route source directly so the test stays dependency-free (no
  // installed workspace link required). The /litellm contract is one source of truth.
  const egress = read('packages', 'shared-core', 'src', 'egress.js');
  const litellmRoute = egress.match(/litellm:\s*Object\.freeze\(\{[^}]*\}\)/);
  assert.ok(litellmRoute, 'egress.js must declare the /litellm route');
  const block = litellmRoute[0];
  assert.match(block, /prefix:\s*'\s*\/litellm/, "route prefix must be '/litellm'");
  assert.match(block, /target:\s*'litellm'/, "target must be 'litellm' (env-pinned upstream)");
  assert.match(block, /auth:\s*'apiKey'/, "auth must be 'apiKey' (bearer injection)");
  assert.match(block, /secretKey:\s*'litellmApiKey'/, 'must resolve the per-org virtual key');
  assert.doesNotMatch(block, /upstream:/, 'route upstream must stay env-pinned, never static');

  // The real origin may appear ONLY on the sidecar (local.proxy_plain_env).
  const cloudRun = read('deploy', 'gcp', 'terraform', 'cloud_run.tf');
  assert.match(cloudRun, /LITELLM_PROXY_UPSTREAM\s*=\s*local\.litellm_url/,
    'LITELLM_PROXY_UPSTREAM must be set from local.litellm_url on the sidecar');
  assert.doesNotMatch(cloudRun, /LITELLM_PROXY_UPSTREAM\s*=\s*"https:\/\//,
    'the gateway origin must never be hardcoded onto an agent container');
});

test('the kagent adapter is dark unless BOTH enabled and apiUrl are set', () => {
  // Matches the KAGENT block in packages/shared-core/src/config.js: enabling kagent
  // without an API URL must fail closed (publish/capabilities return 503).
  const cfg = read('packages', 'shared-core', 'src', 'config.js');
  assert.match(cfg, /KAGENT_ENABLED/, 'config must read KAGENT_ENABLED');
  assert.match(cfg, /KAGENT_API_URL/, 'config must read KAGENT_API_URL');
  assert.match(cfg, /KAGENT_ENABLED[\s\S]{0,400}KAGENT_API_URL/,
    'KAGENT.enabled must gate on both KAGENT_ENABLED and KAGENT_API_URL');
});
