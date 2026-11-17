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
const nodepools = read('.github', 'workflows', 'substrate-nodepools.yml');
const rotate = read('.github', 'workflows', 'substrate-token-rotate.yml');
const cleanup = read('deploy', 'gcp', 'substrate-cleanup.sh');
const recreate = read('deploy', 'gcp', 'substrate-recreate.sh');
const bootstrap = read('deploy', 'gcp', 'bootstrap.sh');
const vars = read(GKE_DIR, 'variables.tf');
const versions = read(GKE_DIR, 'versions.tf');
const namespaces = read(GKE_DIR, 'namespaces.tf');
const workflows = { power, deploy, control, nodepools };

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

// --- substrate-nodepools.yml: the CI face of substrate-cleanup/recreate.sh ---------
// Neither graph indexes YAML, so these four assertions are the only thing standing
// between a flag rename in a shell `case` and a workflow that silently stops passing
// it — which reads as "the restore ignored the snapshot" and costs a node pool.

test('the node-pool workflow is manual-only', () => {
  // One of these two scripts deletes three node pools. A push or cron trigger here
  // would make an unrelated merge a teardown.
  const on = nodepools.match(/^on:\n([\s\S]*?)^\n/m)[1];
  assert.match(on, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(on, /^\s{2}(push|schedule|pull_request|workflow_call|repository_dispatch):/m,
    'substrate-nodepools.yml gained a non-manual trigger');
  assert.doesNotMatch(nodepools, /^\s+cron:/m);
});

test('every flag the workflow passes is one the script parses', () => {
  const run = nodepools.match(/- name: Run\n        run: \|\n([\s\S]*?)\n\n      - name:/)[1];
  const flags = [...new Set([...run.matchAll(/FLAGS\+=\((--[a-z-]+)/g)].map((m) => m[1]))];
  assert.ok(flags.length >= 6, `expected the flag matrix, saw ${flags.join(' ')}`);
  // `--snapshot=*)` is a pattern label, not a plain one, so the closing paren can sit
  // after an `=`/glob. Matching only `--x)` would call that flag unparseable.
  const accepts = (src) => new Set([...src.matchAll(/^\s*--([a-z-]+)[=*][^)]*\)|^\s*--([a-z-]+)\)/gm)]
    .map((m) => `--${m[1] || m[2]}`));
  const want = { '--dry-run': [cleanup, recreate], '--keep-pools': [cleanup], '--backup-only': [cleanup],
    '--release-ip': [cleanup], '--with-disk-snapshot': [cleanup], '--skip-backup': [cleanup],
    '--destroy-pvc': [cleanup], '--yes': [cleanup], '--snapshot': [recreate],
    '--with-primary': [recreate] };
  for (const flag of flags) {
    const scripts = want[flag];
    assert.ok(scripts, `the workflow passes ${flag}, which nothing here declares — add it to the table`);
    for (const src of scripts) {
      assert.ok(accepts(src).has(flag.replace(/=$/, '')), `${flag} is not in that script's argument case`);
    }
  }
});

test('a live run needs a typed word and a rehearsal needs none', () => {
  assert.match(nodepools, /description: "recreate: snapshot to restore from\. latest/m);
  // dry_run defaulting to false is how a click becomes a teardown.
  assert.match(nodepools, /dry_run:\n(?:.*\n){1,4}        default: true/);
  const gate = nodepools.match(/- name: Check the inputs agree[\s\S]*?\n      - name: Run/)[0];
  for (const word of ['teardown', 'release-ip', 'destroy-pvc', 'restore']) {
    assert.match(gate, new RegExp(`REQUIRED=${word.replace(/-/g, '\\-')}`), `no gate word ${word}`);
  }
  assert.match(gate, /\[ "\$CONFIRM" = "\$REQUIRED" \]/);
});

test('the worker namespace is one name across the scripts and the workflows', () => {
  // substrate-workers has no Terraform variable, so equality here is the only check
  // that a rename does not leave the recreate script applying a WorkerPool into a
  // namespace nothing schedules from.
  const ns = (src) => (src.match(/POOL_NS:-'(substrate-workers)'/) || src.match(/POOL_NS\}:-?(substrate-workers)/) || [])[1]
    ?? (src.match(/POOL_NS="\$\{POOL_NS:-(substrate[-a-z]*)\}"/) || [])[1]
    ?? (src.match(/WORKER_NS=(\S+)/) || [])[1];
  const expected = 'substrate-workers';
  assert.equal(ns(recreate), expected, 'substrate-recreate.sh moved off substrate-workers');
  assert.equal(ns(cleanup), expected, 'substrate-cleanup.sh moved off substrate-workers');
  assert.match(nodepools, new RegExp(`POOL_NS: '${expected}'`));
  assert.match(control, new RegExp(`WORKER_NS=${expected}`));
});

test('the authorization step reads the policy with the filter form that matches', () => {
  // gcloud's `--filter "bindings.members=x"` (equals) matches nothing today and
  // still exits 0. The step then reports every role as missing and fails a
  // perfectly authorized run — proven by the first dispatch of this workflow.
  assert.match(nodepools, /--filter="bindings\.members:\$SA"/,
    'the IAM filter must use the colon form, not `=`');
  // And an empty read must be named as an unread policy, not as absent grants.
  assert.match(nodepools, /if \[ -z "\$ROLES" \]; then/);
});

// ── the credential rotator: the same cluster, a mint that cannot leak ────────

test('the rotator drives the cluster the other substrate workflows drive', () => {
  // A half-renamed rotator mints a token whose `iss` is a cluster this ateapi
  // does not trust, and ateapi answers 16 UNAUTHENTICATED — which reads as an
  // expired credential, not as the wrong issuer. Proven the hard way when the
  // file was written against the retired OpenShell module.
  assert.doesNotMatch(rotate, /openshell/i, 'substrate-token-rotate.yml still mentions OpenShell');
  for (const key of ['CLUSTER', 'ZONE']) {
    assert.equal(envBinding(rotate, key).repoVar, envBinding(power, key).repoVar,
      `the rotator reads a different ${key} repo variable than the power workflow`);
  }
  assert.equal(envBinding(rotate, 'CLUSTER').fallback, envBinding(power, 'CLUSTER').fallback);
  assert.equal(envBinding(rotate, 'ZONE').fallback, envBinding(power, 'ZONE').fallback);
  // Its own group with cancel-in-progress false: it writes no cluster object, so
  // it must not queue behind a drain, and a scheduled run must never cancel a
  // rotation that is keeping the bearer alive.
  assert.match(rotate, /^\s+group: substrate-token-rotate$/m);
  assert.match(rotate, /cancel-in-progress: false/);
});

test('the rotator never puts the token in a log, an argv or a variable', () => {
  // A projected SA JWT is longer than the 256 characters `::add-mask::` can
  // register, so masking is not the control here — never printing it is.
  assert.match(rotate, /kubectl -n ate-system create token "\$SA_NAME" \\\n\s*--audience="\$AUDIENCE" --duration="\$duration" > "\$token_file"/,
    'the mint must be redirected straight to the file, not captured then echoed');
  assert.match(rotate, /--data-file="\$token_file"/, 'publish from the file, never from a value on the command line');
  assert.doesNotMatch(rotate, /^\s*cat "\$token_file"/m);
  assert.doesNotMatch(rotate, /echo "\$?token_file/);
  // Only the four claims ateapi checks are summarised, base64url decoded in one
  // place — `base64 -d` rejects both the alphabet and the missing padding, which
  // previously read as "the minted token is not a decodable JWT".
  assert.match(rotate, /urlsafe_b64decode/);
  assert.match(rotate, /"iss","aud","sub","exp"/);
});

test('the mint permission is one verb on one service account', () => {
  const substrateTf = read(GKE_DIR, 'substrate.tf');
  const tokenTf = read('deploy', 'gcp', 'terraform', 'substrate_token.tf');
  // `kubectl create token` writes the `serviceaccounts/token` SUBRESOURCE. A
  // Role on `serviceaccounts` leaves a 403 that reads like a missing role.
  assert.match(substrateTf, /resources: \["serviceaccounts\/token"\]/);
  assert.match(substrateTf, /resourceNames: \["ate-client"\]/,
    'an unpinned mint grants the job tokens for every SA in ate-system');
  // A Workload-Identity-Federated GCP SA arrives as a User, not a ServiceAccount.
  assert.match(substrateTf, /kind: User\n\s+name: \$\{local\.substrate_token_creator_user\}/);
  // Gated with the public front it serves, so nothing renders into ate-system
  // on a deployment that publishes no control-plane route.
  assert.match(substrateTf, /resource "kubectl_manifest" "substrate_ate_client_token_role" \{\n\s*count = local\.substrate_control_plane_public_enabled \? 1 : 0/);
  // The role that actually applied. secretVersionAdd binds only to a *version*,
  // which a publisher cannot name before it exists, so it may appear in prose
  // here but never as a bound role.
  assert.match(tokenTf, /role\s*=\s*"roles\/secretmanager\.secretVersionManager"/);
  assert.doesNotMatch(tokenTf, /role\s*=\s*"roles\/secretmanager\.secretVersionAdd"/);
  assert.match(tokenTf, /role\s*=\s*"roles\/secretmanager\.secretAccessor"/);
});

test('the ateapi bearer is one name across the three secret maps, and browser-unwritable', () => {
  // AGENTS.md makes the settings MANAGED_ENV / store SECRET_ENV / vault
  // SECRET_KEYS trio one contract; a key in two of the three resolves on one
  // path and silently returns nothing on another.
  const managed = read('services', 'settings', 'app', 'services', 'secrets_service.py');
  const store = read('packages', 'shared-core', 'src', 'store.js');
  const models = read('services', 'settings', 'app', 'models', 'secrets.py');
  for (const [label, source] of [['settings MANAGED_ENV', managed], ['store SECRET_ENV', store]]) {
    assert.match(source, /substrateApiToken/, `${label} is missing the key`);
  }
  assert.match(models, /"substrateApiToken",\n\s*\)/, 'the vault key list lost substrateApiToken');
  // Operator-written only: a browser-writable control-plane bearer would let any
  // org admin point our client at a token of their choosing.
  assert.match(models, /BROWSER_WRITABLE_SECRET_KEYS[\s\S]*?"substrateApiToken",\n\s*\)\n\)/,
    'substrateApiToken must stay out of the browser-writable set');
  // It is the one managed key resolved per request; env-mounted it would be
  // frozen at container start and served stale for days.
  assert.match(managed, /_DYNAMIC_SECRET_IDS = \{"substrateApiToken": "substrate-ateapi-token"\}/);
  assert.match(managed, /SUBSTRATE_ATEAPI_TOKEN_TTL_SECONDS/);
});

test('the client fails closed on a missing credential instead of opening a socket', () => {
  const substrateJs = read('packages', 'shared-core', 'src', 'agent', 'substrate.js');
  // An unauthenticated call answers `16 / missing bearer token`, which reads as
  // a broken cluster rather than the missing managed secret it is.
  assert.match(substrateJs, /Substrate credential missing for \$\{method\}/);
  assert.match(substrateJs, /function withCredentialHint/);
  assert.match(substrateJs, /async function resolveSubstrateApiToken/);
  // Never a module-level cache: the credential rotates every six hours.
  assert.doesNotMatch(substrateJs, /let cachedToken|tokenCache/);
});

