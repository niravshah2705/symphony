'use strict';

// Contract test for the substrate CI rename. Neither code graph parses YAML, so a
// half-done rename here is invisible to every other tool in the repo: the node
// pools, state prefix, path filter and repo variables agree only because this file
// says they do. Each assertion pins workflow text to the Terraform it drives, so
// drift fails CI instead of failing a 03:00 start run.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const GKE_DIR = path.join('deploy', 'gcp', 'terraform-substrate-gke');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const power = read('.github', 'workflows', 'substrate-cluster-power.yml');
const deploy = read('.github', 'workflows', 'deploy.yml');
const control = read('.github', 'workflows', 'substrate-control-plane.yml');
const bootstrap = read('deploy', 'gcp', 'bootstrap.sh');
const vars = read(GKE_DIR, 'variables.tf');
const versions = read(GKE_DIR, 'versions.tf');
const namespaces = read(GKE_DIR, 'namespaces.tf');
const workflows = { power, deploy, control };

// The `variable "x" { ... }` block's scalar default, as written in Terraform.
function tfDefault(name) {
  const block = vars.match(new RegExp(`variable "${name}" \\{[\\s\\S]*?\\n\\}`));
  assert.ok(block, `variable "${name}" is not declared in the substrate root`);
  const def = block[0].match(/default\s*=\s*"?([^"\n]+?)"?\s*$/m);
  return def ? def[1] : undefined;
}

// The repo variable a workflow env key reads, and the fallback it prints when the
// variable is unset. The fallback is the failure mode: a default that no longer
// matches the module's own default reconciles a pool nobody asked for.
function envBinding(source, key) {
  const line = source.match(new RegExp(`^\\s*${key}: \\$\\{\\{ vars\\.([A-Z0-9_]+)( \\|\\| '([^']*)')? \\}\\}`, 'm'));
  assert.ok(line, `${key} is not bound to a repo variable`);
  return { repoVar: line[1], fallback: line[3] };
}

function assertDefault(source, key, tfName) {
  const binding = envBinding(source, key);
  assert.equal(binding.fallback, tfDefault(tfName), `${key}'s fallback is not ${tfName}'s module default`);
}

test('no CI file names OpenShell any more', () => {
  for (const [name, source] of Object.entries(workflows)) {
    assert.doesNotMatch(source, /openshell/i, `${name} still mentions OpenShell`);
  }
  assert.doesNotMatch(bootstrap, /openshell/i, 'bootstrap.sh still mentions OpenShell');
  assert.ok(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'substrate-cluster-power.yml')));
  assert.equal(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'openshell-cluster-power.yml')), false);
  assert.equal(fs.existsSync(path.join(ROOT, GKE_DIR.replace('terraform-substrate-gke', 'terraform-openshell-gke'))), false);
});

test('every writer of the cluster serialises on the same concurrency group', () => {
  // Three workflows touch the same node pools. Two groups would let a control-plane
  // install race a drain, and the run would still go green.
  for (const [name, source] of Object.entries(workflows)) {
    const groups = [...source.matchAll(/^\s+group: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
    assert.ok(groups.includes('substrate-cluster-power'), `${name} does not join substrate-cluster-power`);
  }
  // deploy.yml also has a workflow-level group for its own deploys, so only the
  // two dedicated cluster workflows must declare exactly one.
  assert.equal((power.match(/^\s+group: ([a-z0-9-]+)$/gm) || []).length, 1);
  assert.equal((control.match(/^\s+group: ([a-z0-9-]+)$/gm) || []).length, 1);
});

test('workflow fallbacks are the module defaults they reconcile', () => {
  assertDefault(power, 'CLUSTER', 'cluster_name');
  assertDefault(power, 'NODE_POOL', 'node_pool_name');
  assertDefault(power, 'SYSTEM_NODE_POOL', 'system_node_pool_name');
  assertDefault(power, 'MAX_NODES', 'max_nodes');
  assertDefault(power, 'START_MIN_NODES', 'min_nodes');
  assertDefault(power, 'SYSTEM_MAX_NODES', 'system_max_nodes');
  assertDefault(power, 'SYSTEM_START_MIN_NODES', 'system_min_nodes');
  assertDefault(power, 'SUBSTRATE_MAX_NODES', 'substrate_max_nodes');
  assertDefault(power, 'SUBSTRATE_START_MIN_NODES', 'substrate_min_nodes');

  // deploy.yml reads the same pools because it feeds their live bounds back to
  // Terraform; a different name here reconciles a pool the power workflow does not.
  assert.equal(envBinding(deploy, 'CLUSTER').repoVar, envBinding(power, 'CLUSTER').repoVar);
  assert.equal(envBinding(deploy, 'NODE_POOL').repoVar, envBinding(power, 'NODE_POOL').repoVar);
  assert.equal(envBinding(deploy, 'SYSTEM_NODE_POOL').repoVar, envBinding(power, 'SYSTEM_NODE_POOL').repoVar);
  assert.equal(envBinding(deploy, 'ZONE').repoVar, envBinding(power, 'ZONE').repoVar);
  assertDefault(deploy, 'CLUSTER', 'cluster_name');
  assertDefault(deploy, 'NODE_POOL', 'node_pool_name');
  assertDefault(deploy, 'SYSTEM_NODE_POOL', 'system_node_pool_name');

  // The control-plane workflow names only the cluster: it installs into ate-system
  // and never touches a node pool.
  assertDefault(control, 'CLUSTER', 'cluster_name');
  assertDefault(control, 'ZONE', 'zone');

  // The substrate worker pool is optional: unset must stay empty, because a
  // fallback would make every run drain a pool that does not exist.
  assert.equal(envBinding(power, 'SUBSTRATE_NODE_POOL').fallback, undefined);
});

test('the two vars with no module default are named exactly', () => {
  // cert_email is required by the module and autostop gates a schedule; a typo in
  // either reads as unset, which is silent rather than an error.
  assert.equal(envBinding(deploy, 'CERT_EMAIL').repoVar, 'SUBSTRATE_CERT_EMAIL');
  assert.match(deploy, /gh variable set SUBSTRATE_CERT_EMAIL/);
  assert.match(power, /vars\.SUBSTRATE_CLUSTER_AUTOSTOP == 'true'/);
  // The substrate address the pool name would otherwise imply is the worker pool.
  assert.match(power, /SUBSTRATE_NODE_POOL is the Substrate \*worker\* pool/);
});

test('the reconcile job runs the root that exists, under the documented prefix', () => {
  const tfDir = deploy.match(/^\s*GKE_TF_DIR: (\S+)$/m);
  const prefix = deploy.match(/^\s*GKE_TF_STATE_PREFIX: (\S+)$/m);
  assert.ok(tfDir && prefix, 'deploy.yml lost its GKE directory or state prefix');
  assert.equal(tfDir[1], 'deploy/gcp/terraform-substrate-gke');
  assert.ok(fs.existsSync(path.join(ROOT, tfDir[1])));
  assert.equal(prefix[1], 'substrate/gke');
  // The path filter is what decides whether the job runs at all: a filter pointing
  // at the old directory means merges to the real root reconcile nothing.
  assert.match(deploy, new RegExp(`gke:\\s+\\['${tfDir[1].replace(/\//g, '\\/')}\\/\\*\\*'\\]`));
  assert.match(versions, new RegExp(`prefix=${prefix[1].replace('/', '\\/')}`));
});

test('an empty state prefix is the greenfield start, not a refused run', () => {
  // The old guard failed here ("run the adoption pass first") on the assumption
  // that a live cluster was waiting to be duplicated. Nothing is live.
  assert.doesNotMatch(deploy, /::error::[^\n]*adoption pass/);
  assert.match(deploy, /::notice::[^\n]*greenfield first apply/);
  // The opposite risk stays gated: a delete in a plan is never applied.
  assert.match(deploy, /gke_allow_destroy/);
});

test('the power workflow waits only on namespaces the module still creates', () => {
  const created = new Set();
  for (const block of [namespaces, read(GKE_DIR, 'substrate.tf'), read(GKE_DIR, 'agentgateway.tf')]) {
    for (const resource of block.match(/resource "kubernetes_namespace_v1" "[a-z_]+" \{[\s\S]*?\n\}/g) || []) {
      const name = resource.match(/name\s*=\s*(.+)$/m);
      if (!name) continue;
      const literal = name[1].trim().match(/^"([^"]+)"$/);
      if (literal) created.add(literal[1]);
      else if (/^var\./.test(name[1].trim())) created.add(tfDefault(name[1].trim().slice(4)));
      // `each.key` namespaces are org-derived and are not in the wait lists.
    }
  }
  const drainPreflight = (power.match(/IN\(([^)]*)\)/)[1].match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
  const addonWait = [
    ...(power.match(/NAMESPACES=\(([^)]*)\)/)[1] || '').split(/\s+/).filter(Boolean),
    ...(power.match(/NAMESPACES\+=\(([^)]*)\)/)[1] || '').split(/\s+/).filter(Boolean),
  ];
  for (const listed of [...drainPreflight, ...addonWait]) {
    assert.ok(created.has(listed), `${listed} is waited on but never created by the root`);
  }
  assert.ok(created.has('agentgateway-system'), 'the agentgateway namespace should be pinned');
  assert.deepEqual(addonWait.filter((ns) => /openshell|sandbox/.test(ns)), []);
});

test('the static-IP grant lists the addresses the module owns', () => {
  const addresses = [read(GKE_DIR, 'substrate.tf'), read(GKE_DIR, 'agentgateway.tf')]
    .flatMap((src) => src.match(/resource "google_compute_address" "[a-z_]+" \{[\s\S]*?\n\}/g) || [])
    .map((block) => block.match(/name\s*=\s*"([^"]+)"/)[1]);
  assert.ok(addresses.length >= 2, 'expected a static address per front');
  for (const address of addresses) {
    assert.ok(bootstrap.includes(address), `bootstrap.sh never mentions ${address}`);
  }
  // A name in that comment that no resource creates is how a front loses its IP
  // permission and the apply 403s on the second verb.
  const listed = bootstrap.match(/\((substrate-ip[^)]*)\)/);
  assert.ok(listed, 'bootstrap.sh lost its address list');
  for (const address of listed[1].split(',').map((s) => s.trim())) {
    assert.ok(addresses.includes(address), `bootstrap.sh lists ${address}, which nothing creates`);
  }
});
