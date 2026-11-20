'use strict';

// guest-worker-pool.sh is the only place the guest demo's capacity is real.
// Everything else about that capacity is a string: the name the rendered Harness
// puts in spec.substrate.workerPoolRef.name, the label ate-controller stamps on
// the pods, and the repo variable an operator can set. A rename anywhere in that
// chain plans clean, applies green, and leaves every guest actor Pending — so
// these tests run the script against a stubbed gcloud/kubectl and compare the
// name it creates against the two places that read it.
//
// The dry run is what we can afford to assert on. A live run needs a GKE cluster,
// and the script's mutating behaviour is the same code path with `run` executing
// instead of printing; the parts worth pinning are the numbers, the taint, the
// label, the manifest, and the promise that --dry-run mutates nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(__dirname, 'guest-worker-pool.sh');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const configJs = read('packages', 'shared-core', 'src', 'config.js');
const variablesTf = read('deploy', 'gcp', 'terraform', 'variables.tf');
const deployYml = read('.github', 'workflows', 'deploy.yml');
const checkSh = read('deploy', 'gcp', 'substrate-check.sh');
const recreateSh = read('deploy', 'gcp', 'substrate-recreate.sh');
const guestSh = fs.readFileSync(SCRIPT, 'utf8');

// stubRun(argv, { poolExists, workerPoolExists, readyReplicas, env }) → the script's
// combined output, its exit status, and every gcloud/kubectl call it made.
function stubRun(args, state = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-pool-'));
  const log = path.join(dir, 'calls.log');
  const poolExists = state.poolExists === true;
  const wpExists = state.workerPoolExists === true;
  const ready = state.readyReplicas === undefined ? '' : String(state.readyReplicas);

  const write = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body, { mode: 0o755 });
    return file;
  };
  write('gcloud', `#!/usr/bin/env bash
printf 'gcloud %s\\n' "$*" >> "${log}"
case "$*" in
  *"node-pools describe"*) exit ${poolExists ? 0 : 1} ;;
esac
exit 0
`);
  write('kubectl', `#!/usr/bin/env bash
printf 'kubectl %s\\n' "$*" >> "${log}"
case "$*" in
  # Match on the flag and the resource, not on the whole address: the readiness
  # poll asks for the plural workerpools.ate.dev while the existence probe and the
  # display call use the singular, and a stub that answers neither shape turns a
  # test into a ten-minute wait.
  *"get ns"*)                    exit 0 ;;
  *readyReplicas*)               printf '%s' '${ready}'; exit ${ready === '' ? 1 : 0} ;;
  *create* | *delete* | *apply*) printf 'workerpool.ate.dev stub\\n' ;;
  *workerpool*)                  exit ${wpExists ? 0 : 1} ;;
esac
exit 0
`);

  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...state.env, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: `${result.stdout}${result.stderr}`, status: result.status, calls };
}

test('the rehearsal prints the pool the demo needs and changes nothing', () => {
  const run = stubRun(['--dry-run']);
  assert.equal(run.status, 0, run.out);
  // Sizing: one node, and it scales to zero between bursts.
  assert.match(run.out, /--min-nodes 0 --max-nodes 1/);
  assert.match(run.out, /--num-nodes 0/, 'the pool must start at its floor, not at gcloud\'s default of 3');
  assert.match(run.out, /--machine-type n4-standard-4 --disk-type hyperdisk-balanced --disk-size 100GB/);
  assert.match(run.out, /--boot-disk-provisioned-iops 3000/, 'hyperdisk needs the provisioned-IOPS flags');
  // Placement contract: the taint atelet tolerates and the label that names the pool.
  assert.match(run.out, /--node-taints ate\.dev\/sandboxClass=gvisor:NoSchedule/);
  assert.match(run.out, /--node-labels ate\.dev\/worker-pool=guest-demo-pool/);
  // The custom resource, printed because a rehearsal nobody can read is not a rehearsal.
  assert.match(run.out, /kind: WorkerPool\nmetadata:\n  name: guest-demo-pool\n  namespace: substrate-workers/);
  assert.match(run.out, /spec:\n  replicas: 1\n/);
  assert.match(run.out, /sandboxClasses:\n  - name: gvisor/);
  assert.match(run.out, /nodeSelector:\n      cloud\.google\.com\/gke-nodepool: substrate-guest-node-pool/);
  assert.match(run.out, /requests:\n        cpu: 250m\n        memory: 512Mi/);
  assert.match(run.out, /limits:\n        cpu: "1"\n        memory: 2Gi/);
  // Visibly half the planner pool, which is the point of a separate one.
  assert.match(run.out, /workerImage: ghcr\.io\/agent-substrate\/substrate\/ateworker-gvisor:/);

  // And "print, change nothing" means exactly that: the only calls are probes.
  for (const call of run.calls) {
    assert.doesNotMatch(call, /\bcreate\b|\bdelete\b|\bapply\b|get-credentials/, `--dry-run executed ${call}`);
  }
  assert.ok(run.calls.some((call) => call.includes('node-pools describe')),
    'the rehearsal must still ask whether the pool exists, or it rehearses a different run');
});

test('a rehearsal leaks no credential of any kind', () => {
  // The guest pool is the one substrate object an anonymous visitor's demo names.
  // If its manifest ever grew a secret reference, this is the file that would
  // print it to a terminal.
  const run = stubRun(['--dry-run']);
  // The lookbehind is not fussiness: `--disk-type hyperdisk-balanced` contains a
  // bare `sk-` followed by eight characters, so an unanchored key pattern flags
  // the machine type as a leaked credential. A real key never has a letter in
  // front of the prefix.
  assert.doesNotMatch(run.out, /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN|sha256:[0-9a-f]{16,}/);
  assert.doesNotMatch(run.out, /serviceAccount:|iam\.gserviceaccount\.com|SECRET|TOKEN|PASSWORD|api[_-]?key/i);
  assert.doesNotMatch(run.calls.join('\n'), /key|token|secret|credential/i);
});

test('the pool name is one string in the three places that read it', () => {
  const run = stubRun(['--dry-run']);
  const created = (run.out.match(/name: (guest[-a-z0-9]*)/g) || []).length;
  assert.ok(created >= 1, 'the manifest names no pool');

  // 1. config.js: what the rendered Harness selects, via GUEST_DEMO.workerPool.
  const configDefault = /workerPool: process\.env\.GUEST_WORKER_POOL \|\| '([^']+)'/.exec(configJs);
  assert.ok(configDefault, 'config.js no longer reads GUEST_WORKER_POOL with a literal fallback');
  // 2. Terraform: what the deployed gateway is given.
  const tfBlock = new RegExp(`variable "guest_worker_pool" \\{[\\s\\S]*?default\\s*=\\s*"([^"]+)"`).exec(variablesTf);
  assert.ok(tfBlock, 'var.guest_worker_pool is undeclared or has no default');
  // 3. The script itself.
  const scriptDefault = /GUEST_WP_NAME_DEFAULT=(\S+)/.exec(guestSh);
  assert.ok(scriptDefault, 'the script lost its own default');

  assert.equal(configDefault[1], 'guest-demo-pool');
  assert.equal(tfBlock[1], configDefault[1], 'terraform and the config disagree about which pool the demo selects');
  assert.equal(scriptDefault[1], configDefault[1], 'the script creates a pool neither the config nor terraform names');

  // The CI path for the Terraform side, including the repo-variable fallback that
  // must equal the module default rather than silently repoint the demo.
  assert.match(deployYml, /-var="guest_worker_pool=\$\{\{ vars\.GUEST_WORKER_POOL \|\| 'guest-demo-pool' \}\}"/);
});

test('renaming the pool without renaming the config is refused loudly', () => {
  const run = stubRun(['--dry-run', '--name=guest-other-pool']);
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /WARNING/, 'a rename that breaks the workerSelector contract passed silently');
  assert.match(run.out, /GUEST_WORKER_POOL/);
  assert.match(run.out, /guest_worker_pool/, 'the warning must name both knobs, not just one');
  assert.match(run.out, /name: guest-other-pool/, 'the override did not reach the manifest');
  assert.match(run.out, /--node-labels ate\.dev\/worker-pool=guest-other-pool/,
    'the node label and the CR name must move together, or the pool is recognizable by eye only');
});

test('--nodes raises the ceiling, and only the ceiling', () => {
  const run = stubRun(['--dry-run', '--nodes=2']);
  assert.match(run.out, /--min-nodes 0 --max-nodes 2/);
  assert.match(run.out, /--num-nodes 0/, 'asking for more capacity must not buy a warm node');
  assert.match(run.out, /replicas: 1/, 'one worker pod is the guest demo; --nodes is cluster headroom');
});

test('an existing pool is left alone rather than reconfigured', () => {
  // Both objects: gcloud pool and the CR. This script has no update path, because
  // a partial reconfigure of a pool another tool owns is worse than an old pool.
  const run = stubRun(['--dry-run'], { poolExists: true, workerPoolExists: true, readyReplicas: '1' });
  assert.match(run.out, /already exists — left as is \(this script does not reconfigure\)/);
  assert.match(run.out, /WorkerPool substrate-workers\/guest-demo-pool already exists — left as is/);
  assert.doesNotMatch(run.out, /would create substrate-guest-node-pool/);
  // The manifest is still printed for comparison, which is the only way an
  // operator learns the live pool drifted.
  assert.match(run.out, /Manifest it was created from, for comparison/);
  assert.match(run.out, /kind: WorkerPool/);
});

test('a live run waits for a ready worker and reports the pool', () => {
  const run = stubRun([], { poolExists: false, workerPoolExists: false, readyReplicas: '1' });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /create substrate-guest-node-pool/, 'nothing was provisioned');
  assert.match(run.out, /apply WorkerPool substrate-workers\/guest-demo-pool/);
  assert.match(run.out, /1 worker\(s\) ready/);
  assert.match(run.out, /now selects a live pool/);
  assert.ok(run.calls.some((call) => call.startsWith('kubectl apply -n substrate-workers -f -')),
    `the CR was never applied: ${run.calls.join(' | ')}`);
});

test('a pool that never produces a ready worker is a failure, not a success', () => {
  // A pool at min_nodes=0 legitimately has no ready worker until an actor asks for
  // one, so a script that reported success here would be indistinguishable from one
  // whose nodeSelector matches nothing. G_POLL_TIMEOUT bounds the wait so this
  // branch is reachable by a test rather than by waiting ten minutes.
  const run = stubRun([], {
    poolExists: false, workerPoolExists: false, readyReplicas: '0',
    env: { G_POLL_TIMEOUT: '0', G_POLL_INTERVAL: '0' },
  });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /no ready worker/, 'the wait declared victory on an empty pool');
  assert.match(run.out, /idle at min_nodes=0/, 'the honest reading of an empty pool must be in the message');
  assert.match(run.out, /kubectl get pods -n substrate-workers -l ate\.dev\/worker-pool=guest-demo-pool/,
    'the operator needs the exact follow-up command, and it is the label contract that proves placement');
});

test('teardown removes the resource then the nodes, in that order', () => {
  const run = stubRun(['--dry-run', '--delete'], { poolExists: true, workerPoolExists: true });
  assert.equal(run.status, 0, run.out);
  const deleteCr = run.out.indexOf('would delete WorkerPool substrate-workers/guest-demo-pool');
  const deletePool = run.out.indexOf('would delete node pool substrate-guest-node-pool');
  assert.ok(deleteCr >= 0 && deletePool > deleteCr,
    'deleting the nodes first strands a WorkerPool whose pods can never schedule');
  assert.doesNotMatch(run.out, /would create/);
  // The reminder is the point: the gateway keeps rendering this name regardless.
  assert.match(run.out, /var\.guest_worker_pool/);

  const absent = stubRun(['--dry-run', '--delete']);
  assert.match(absent.out, /does not exist — nothing to delete/);
  assert.equal(absent.status, 0, 'teardown of a pool that was never built is not an error');
});

test('an unknown argument is refused before anything is read from the cluster', () => {
  const run = stubRun(['--dry-run', '--recreate']);
  assert.equal(run.status, 2);
  assert.match(run.out, /unknown argument: --recreate/);
  assert.match(run.out, /--name=<pool>.*--nodes=<max>/s, 'the usage line must list every flag it accepts');
  assert.equal(run.calls.length, 0, `a rejected call still touched the cluster: ${run.calls.join(' | ')}`);
});

test('the guest pool does not disturb the planner pool anything else selects', () => {
  // substrate-check.sh and substrate-recreate.sh both default to planner-pool; a
  // "helpful" edit that pointed them at the guest pool would silently move every
  // signed-in run onto one node.
  assert.match(checkSh, /POOL="\$\{POOL:-planner-pool\}"/);
  assert.doesNotMatch(checkSh, /guest-demo-pool/);
  assert.match(recreateSh, /WORKER_POOL_NAME_DEFAULT=planner-pool/);
  assert.doesNotMatch(recreateSh, /guest-demo-pool/);
  // And the guest script reuses the planner defaults instead of redefining them.
  assert.equal(/G_TAINT="([^"]+)"/.exec(guestSh)[1], /WORKER_TAINT_DEFAULT="([^"]+)"/.exec(recreateSh)[1],
    'the sandbox-class taint is upstream contract and must not fork per pool');
});
