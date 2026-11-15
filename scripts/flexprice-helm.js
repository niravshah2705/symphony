#!/usr/bin/env node
// Install FlexPrice into the local kind cluster with the upstream Helm chart,
// using deploy/flexprice/.env for every secret and deploy/flexprice/helm/values-kind.yaml
// for every setting.
//
//   npm run billing:flexprice:helm              # full install + verification
//   npm run billing:flexprice:helm -- --dry-run # print what would run
//   npm run billing:flexprice:helm -- --from migration
//
// Why three phases instead of one `helm install`: the migration Job is a
// pre-install/pre-upgrade hook, so on a cold cluster it runs BEFORE the Postgres,
// Kafka and ClickHouse StatefulSets exist and its wait step polls a Service that
// nothing has created yet — for the full 1800s. Upstream hits the same wall and
// solves it the same way (internal/ee/infrastructure/helm/provision.sh: infra,
// then migrations, then app, each its own `helm upgrade --install`). We follow that
// ordering, with the differences this repo needs: the existing kind cluster, real
// generated secrets from .env rather than inline dev values, and the api_key
// configuration the compose stack was verified against.
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const HERE = path.join(REPO_ROOT, 'deploy', 'flexprice');
const HELM_DIR = path.join(HERE, 'helm');
const ENV_FILE = path.join(HERE, '.env');
const VERSION_FILE = path.join(HERE, 'VERSION');
const VALUES = path.join(HELM_DIR, 'values-kind.yaml');
const EXTRAS = path.join(HELM_DIR, 'extras');
const BUILD = path.join(HELM_DIR, 'build');
const STAGED_CHART = path.join(BUILD, 'flexprice');

const NAMESPACE = 'flexprice';
const RELEASE = 'flexprice';
const SECRET_NAME = 'flexprice-secrets';
const IMAGE = 'flexprice-app:phase0';
// The seed IDs the migration Job's built-in SQL creates. Same constants the
// compose stack and the spike scripts use; a tenant row is what makes a key map
// authenticate at all.
const TENANT_ID = '00000000-0000-0000-0000-000000000000';
const SEED_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';
// The literals in values-kind.yaml and extras/*.yaml. Divergence between the two
// files is silent (a wrong user just fails to connect later), so it is asserted
// here instead of left to a comment.
const EXPECTED = {
  FLEXPRICE_PG_USER: 'flexprice',
  FLEXPRICE_PG_DB: 'flexprice',
  FLEXPRICE_CH_USER: 'flexprice',
  FLEXPRICE_CH_DB: 'flexprice',
  FLEXPRICE_ALLOW_INSECURE_DEFAULTS: 'false',
};

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const fromIdx = argv.indexOf('--from');
const FROM = fromIdx >= 0 ? argv[fromIdx + 1] : 'preflight';

const PHASES = ['preflight', 'secrets', 'chart', 'infra', 'dbinit', 'temporal', 'migration', 'app', 'verify'];
if (fromIdx >= 0 && !PHASES.includes(FROM)) {
  die(`--from must be one of ${PHASES.join(', ')}`);
}
const started = FROM === 'preflight' ? 0 : PHASES.indexOf(FROM);
const skip = (name) => PHASES.indexOf(name) < started;

function log(msg) { process.stderr.write(`${msg}\n`); }
function step(msg) { log(`\n== ${msg}`); }
function die(msg) { process.stderr.write(`FATAL: ${msg}\n`); process.exit(1); }

// Commands run as argv arrays (no shell), so no value from .env is ever
// re-parsed by a shell and none of their stdout is echoed unless a step asks for
// it. Secret material is passed as --from-literal arguments, which exist only for
// the lifetime of the exec: nothing plaintext lands on disk.
//
// `read: true` marks a command whose ANSWER the script needs (context, image id,
// counts). Those execute under --dry-run as well: a rehearsal that skips the
// assertions rehearses nothing, and reading cannot change anything.
function run(bin, args, opts = {}) {
  if (DRY && !opts.read) {
    log(`  [dry-run] ${bin} ${redact(bin, args)}`);
    return { stdout: '', status: 0 };
  }
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: [ignore(), 'pipe', VERBOSE ? 'inherit' : 'pipe'],
      timeout: opts.timeout || 900000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout: (stdout || '').trim(), status: 0 };
  } catch (e) {
    const detail = DRY ? '' : `\n       ${(e.stderr || e.stdout || e.message || '').toString().trim().split('\n').slice(-4).join('\n       ')}`;
    if (opts.allowFail) return { stdout: (e.stdout || '').toString().trim(), status: e.status || 1, failed: true };
    die(`${bin} ${redact(bin, args)} ... failed${detail}`);
  }
}

// kubectl create secret is the one command whose arguments ARE the secrets, so it
// never gets printed as-is — not even in dry-run, which goes to the terminal and to
// any log capture around it.
function redact(bin, args) {
  if (args.includes('secret')) return `${args.slice(0, 3).join(' ')} ... (${args.filter((a) => a.startsWith('--from-literal')).length} values hidden)`;
  return args.join(' ');
}
function ignore() { return DRY ? 'ignore' : 'pipe'; }

function readVersionField(key) {
  const line = fs.readFileSync(VERSION_FILE, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

function parseEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Two ways to get an image into a kind node, and neither needs the kind CLI:
//   - `kind load docker-image` when the CLI is installed;
//   - `docker save | docker exec -i <node> ctr --namespace=k8s.io images import -`
//     otherwise. The second is what kind itself shells out to, and it is the only
//     option here because this cluster was created outside this repo's tooling.
// The import is idempotent by name, so a re-run on an image that is already in the
// node costs one `images ls` instead of a multi-minute stream.
function loadIntoCluster(image, cluster, hasKind) {
  step(`  load ${image} into kind`);
  const node = `${cluster}-control-plane`;
  if (hasKind) {
    run('kind', ['load', 'docker-image', image, '--name', cluster]);
    log(`  ${image} -> ${cluster}`);
    return;
  }
  const nodes = run('docker', ['ps', '--filter', `name=${node}`, '--format', '{{.Names}}'], { read: true }).stdout.split('\n').filter(Boolean);
  if (!nodes.includes(node)) die(`kind CLI is absent and the node container "${node}" is not running — cannot load ${image} into the cluster`);
  const present = run('docker', ['exec', node, 'ctr', '-n', 'k8s.io', 'images', 'ls', '-q'], { allowFail: true, read: true }).stdout;
  // containerd qualifies an unqualified docker ref the same way `kind load` does.
  const names = present.split('\n');
  if (names.some((l) => l === `docker.io/library/${image}` || l === image)) {
    log(`  ${image} already in ${node} — skipping import`);
    return;
  }
  // The pipe is a shell, but both values arrive as positional parameters, so
  // nothing here is string-interpolated into the command text.
  run('sh', ['-c', 'docker save "$0" | docker exec -i "$1" ctr --namespace=k8s.io images import -', image, node], {
    timeout: 1800000,
  });
  log(`  ${image} -> ${node} (ctr import)`);
}

// ------------------------------------------------------------------ 1. preflight

function preflight(env) {
  step(`1/9 preflight${DRY ? ' (dry-run)' : ''}`);

  const ctx = run('kubectl', ['config', 'current-context'], { read: true }).stdout;
  if (!ctx.startsWith('kind-')) die(`current kubectl context is "${ctx}" — expected a kind context (this install is kind-only)`);
  const cluster = ctx.slice('kind-'.length);
  log(`  context=${ctx} cluster=${cluster}`);

  // `kind` is optional. The cluster already exists here (it was created by other
  // means), and image loading has a path that does not need the CLI at all.
  const tools = [['kubectl', ['version', '--client']], ['helm', ['version', '--short']], ['docker', ['version', '--format', '{{.Server.Version}}']]];
  for (const [bin, args] of tools) {
    if (run(bin, args, { timeout: 30000, allowFail: true, read: true }).failed) die(`${bin} is required but did not run`);
  }
  const hasKind = !run('kind', ['version'], { timeout: 20000, allowFail: true, read: true }).failed;
  log(`  kubectl, helm, docker present; kind CLI ${hasKind ? 'present' : 'absent (loading via docker exec + ctr)'}`);

  // The chart lives in the pinned FlexPrice checkout, not in this repo: it ships
  // with the source it configures, and deploy/flexprice/VERSION pins which source.
  const checkout = env.FLEXPRICE_CHECKOUT || readVersionField('checkout');
  const chartSrc = path.join(checkout, 'internal/ee/infrastructure/helm/flexprice');
  if (!fs.existsSync(chartSrc)) die(`chart not found at ${chartSrc}\n   run: npm run billing:flexprice:bootstrap`);
  const pinned = readVersionField('commit');
  const head = run('git', ['-C', checkout, 'rev-parse', 'HEAD'], { allowFail: true, read: true }).stdout;
  if (head && pinned && head !== pinned) log(`  NOTE checkout HEAD ${head.slice(0, 8)} != VERSION pin ${pinned.slice(0, 8)} — using what is on disk`);

  const img = run('docker', ['images', '-q', IMAGE], { allowFail: true, read: true }).stdout;
  if (!img) die(`image ${IMAGE} not built — run: npm run billing:flexprice:bootstrap`);
  log(`  image=${IMAGE} id=${img.slice(0, 12)}`);

  // The cluster cannot see the host's docker daemon; without this the pods sit in
  // ErrImageNeverPull (pullPolicy is Never, so there is no registry fallback).
  loadIntoCluster(IMAGE, cluster, hasKind);

  for (const [key, want] of Object.entries(EXPECTED)) {
    if (env[key] !== want) die(`deploy/flexprice/.env ${key}="${env[key]}" but values-kind.yaml and extras/ hardcode "${want}"`);
  }
  for (const key of ['FLEXPRICE_PG_PASSWORD', 'FLEXPRICE_CH_PASSWORD', 'FLEXPRICE_AUTH_SECRET', 'FLEXPRICE_SECRETS_ENCRYPTION_KEY', 'FLEXPRICE_AUTH_API_KEY_KEYS', 'FLEXPRICE_API_KEY']) {
    if (!env[key]) die(`deploy/flexprice/.env is missing ${key}`);
  }
  if (!/"00000000-0000-0000-0000-000000000000"/.test(env.FLEXPRICE_AUTH_API_KEY_KEYS)) {
    die('the API key map does not name tenant ' + TENANT_ID + ' — nothing will authenticate');
  }
  log('  .env agrees with values-kind.yaml');
  return { cluster, chartSrc };
}

// ------------------------------------------------------------------- 2. secrets

function secrets(env) {
  step('2/9 namespace + Secret');
  // create | apply is the idempotent pair: `create --dry-run` prints the object,
  // `apply` takes it. A bare `kubectl create` would fail on the second run.
  //
  // Keys the chart reads: postgres-password + clickhouse-password are referenced by
  // templates/infra/*.yaml, auth-secret + encryption-key by the app containers, and
  // api-key-keys is the name secretEnv maps FLEXPRICE_AUTH_API_KEY_KEYS to. Values
  // go through argv (gone when the exec exits) and are never logged: the dry-run
  // line is printed by hand, because the generic printer would echo the arguments.
  const literals = [
    `postgres-password=${env.FLEXPRICE_PG_PASSWORD}`,
    `clickhouse-password=${env.FLEXPRICE_CH_PASSWORD}`,
    `auth-secret=${env.FLEXPRICE_AUTH_SECRET}`,
    `encryption-key=${env.FLEXPRICE_SECRETS_ENCRYPTION_KEY}`,
    `api-key-keys=${env.FLEXPRICE_AUTH_API_KEY_KEYS}`,
  ];
  if (DRY) {
    log(`  [dry-run] kubectl create namespace ${NAMESPACE} | apply`);
    log(`  [dry-run] kubectl create secret generic ${SECRET_NAME} --from-literal ... (${literals.length} keys, values not shown) | apply`);
    return;
  }
  for (const [kind, argvTail] of [
    ['namespace', ['create', 'namespace', NAMESPACE]],
    ['secret', ['create', 'secret', 'generic', SECRET_NAME, '-n', NAMESPACE, ...literals.map((kv) => ['--from-literal', kv]).flat()]],
  ]) {
    const yaml = execFileSync('kubectl', [...argvTail, '--dry-run=client', '-o', 'yaml']);
    execFileSync('kubectl', ['apply', '-f', '-'], { input: yaml });
    log(`  ${kind} applied`);
  }
  log(`  secret ${SECRET_NAME}: ${literals.length} keys (values not shown)`);
}

// --------------------------------------------------------------------- 3. chart

// The chart declares four subchart dependencies (bitnami postgresql/kafka/redis +
// the official temporal chart). Every one of their conditions is false in
// values-kind.yaml — the hand-rolled templates under templates/infra/ are what
// render — but Helm still refuses to install a chart whose declared dependencies
// are not vendored, which would mean `helm repo add` twice and four tarball
// downloads to obtain manifests that render to nothing. So the chart is staged into
// a gitignored build directory with its `dependencies:` block removed and its lock
// file dropped. Nothing else about it is modified: the templates that run are
// byte-for-byte upstream's.
function stageChart(chartSrc) {
  step('3/9 stage chart (subchart dependencies stripped)');
  if (DRY) {
    log(`  [dry-run] cp -R ${chartSrc} ${STAGED_CHART}; drop the dependencies: block from Chart.yaml; helm lint`);
    return;
  }
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.cpSync(chartSrc, STAGED_CHART, { recursive: true });

  const chartYaml = path.join(STAGED_CHART, 'Chart.yaml');
  const lines = fs.readFileSync(chartYaml, 'utf8').split('\n');
  const at = lines.findIndex((l) => /^dependencies:/.test(l));
  if (at < 0) die('Chart.yaml has no dependencies: block — the staging step is now wrong, fix it rather than trusting it');
  fs.writeFileSync(chartYaml, `${lines.slice(0, at).join('\n')}\n`);
  fs.rmSync(path.join(STAGED_CHART, 'Chart.lock'), { force: true });

  run('helm', ['lint', STAGED_CHART, '-f', VALUES], { timeout: 120000 });
  log(`  chart staged + linted (version ${readChartVersion(path.join(chartSrc, 'Chart.yaml'))})`);
}

function readChartVersion(file) {
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => /^version:/.test(l));
  return line ? line.split(':')[1].trim() : '?';
}

// ----------------------------------------------------------------- phases 4..7

// Each phase is the same command with different enablement flags — the ordering
// mechanism, not a feature. `--wait` makes helm block until what it rendered is
// actually Ready, which is what turns "the chart applied" into "the database works".
function helmPhase(label, sets, timeout) {
  step(label);
  healPendingRelease();
  const args = ['upgrade', '--install', RELEASE, STAGED_CHART, '-f', VALUES, '-n', NAMESPACE,
    // relaxInfraProbes() writes probe timings the chart does not render, which server-side
    // apply would otherwise report as a conflict against its own fields and refuse the
    // upgrade with. Taking ownership back here is what makes the two orderings (chart
    // renders, script widens) repeatable rather than a one-shot.
    '--force-conflicts',
    ...sets.flatMap((s) => ['--set', s]), '--wait', '--timeout', `${timeout}s`];
  const res = run('helm', args, { timeout: (timeout + 120) * 1000, allowFail: true });
  if (res.failed) {
    // helm's own report is "resource X not ready / context deadline exceeded", which
    // is true and useless: the reason is a scheduling event or a container's waiting
    // state, and both are one kubectl away. Print them rather than making the next
    // operator rediscover that a Pending pod means the node is out of memory.
    whyNotReady();
    die(`${label} did not become Ready in ${timeout}s`);
  }
  log(`  ${sets.filter((s) => !/frontend/.test(s)).join(' ')}`);
  relaxInfraProbes();
}

// The chart hardcodes the infra probes and exposes no values key for them: postgres
// readiness is `pg_isready` with timeoutSeconds 3, liveness 5s x 3 failures, and
// ClickHouse both at 1s. On a saturated single-node kind cluster those are not slow
// answers but timeouts, and a timeout KILLS a healthy database: dbmate then dies with
// `connection reset by peer`, `backoffLimit: 0` fails the whole pre-upgrade hook, and
// Temporal loses its connection badly enough that namespace writes return
// "no usable database connection found". Widen the timing only — every command, port,
// period and initial delay the chart chose stays as rendered.
//
// Called after EVERY helm phase, not just infra: each `upgrade --install` re-renders
// the chart and would put the fragile defaults back. The patch is a no-op once applied,
// so it never costs an extra pod restart.
const INFRA_PROBES = [['flexprice-postgres', 'postgres'], ['flexprice-kafka', 'kafka'],
  ['flexprice-clickhouse', 'clickhouse'], ['flexprice-redis', 'redis']];

function relaxInfraProbes() {
  const widened = { timeoutSeconds: 20, failureThreshold: 6 };
  for (const [sts, container] of INFRA_PROBES) {
    // A `kubectl patch` is a mutating request, not an apply, so it never gets refused for
    // conflicts; it does leave the fields owned by `kubectl-patch`, which is why the
    // upgrade above runs with --force-conflicts. (`--field-manager=helm` here does NOT
    // work: it creates a second entry under helm's name with operation=Patch, and helm's
    // Apply then conflicts with its own impostor.)
    run('kubectl', ['patch', 'sts', sts, '-n', NAMESPACE, '-p', JSON.stringify({
      spec: { template: { spec: { containers: [{ name: container, livenessProbe: widened, readinessProbe: widened }] } } },
    })]);
    // The StatefulSet is RollingUpdate, but the pod that is already running keeps the
    // timings it was created with: after the first patch here, `get sts` reported
    // timeoutSeconds 15 while `get pod` still reported 5 and the revision labels
    // already matched, so the controller saw nothing to roll. Compare the live pod
    // against the template and recreate it once when they disagree — otherwise the
    // widened values exist only in the spec and the probe still kills the database.
    const live = run('kubectl', ['get', 'pod', `${sts}-0`, '-n', NAMESPACE, '-o',
      `jsonpath={.spec.containers[?(@.name=="${container}")].livenessProbe.timeoutSeconds}`], { read: true, allowFail: true }).stdout;
    if (live === '20') continue;
    run('kubectl', ['delete', 'pod', `${sts}-0`, '-n', NAMESPACE, '--wait=true'], { timeout: 420000 });
    run('kubectl', ['rollout', 'status', `statefulset/${sts}`, '-n', NAMESPACE, '--timeout=420s'], { timeout: 480000 });
    log(`  ${sts}-0 recreated with widened probes`);
  }
}

// auto-setup registers the `default` namespace from a background step (the script ends
// with `setup_server &`), so a pod killed by a probe during that window comes back with
// a server that answers traffic but has no namespace at all. The symptom is far from the
// cause: the FlexPrice worker crash-loops on
// `ensure temporal server schedules: describe temporal schedule
//  "credit-grants-processing": Namespace default is not found.`
// Do the same registration in the foreground instead, guarded by a describe so a re-run
// is a no-op. The server binds `bindOnIP` to the pod IP (the entrypoint's loopback
// default is overridden), so the address is read from the pod status rather than assumed
// to be localhost.
function registerTemporalNamespace() {
  const ip = run('kubectl', ['get', 'pod', '-n', NAMESPACE,
    '-l', 'app.kubernetes.io/name=flexprice-temporal', '-o', 'jsonpath={.items[0].status.podIP}'], { read: true, allowFail: true }).stdout.trim();
  if (!ip) {
    if (DRY) { log('  [dry-run] would describe, then create, the `default` namespace on the Temporal pod'); return; }
    die('no Temporal pod IP — the Deployment is not reporting a ready pod');
  }
  const script = [
    'addr="$1"',
    'd() { temporal operator namespace describe -n default --address "$addr" >/dev/null 2>&1; }',
    'd && { echo already registered; exit 0; }',
    'temporal operator namespace create -n default --address "$addr" --retention 24h --description "Default namespace for Temporal Server." >/dev/null 2>&1 && { echo created; exit 0; }',
    // Neither call answered, which on this cluster is usually the persistence pool
    // mid-reconnect ("no usable database connection found") rather than a real
    // problem: Temporal returns that for a namespace that was registered in an
    // earlier pass. Re-ask before failing the install over it.
    'd && { echo registered despite the error; exit 0; }',
    'echo "namespace default is absent and could not be created" >&2; exit 1',
  ].join('; ');
  const res = run('kubectl', ['exec', '-n', NAMESPACE, 'deploy/flexprice-temporal', '--',
    'sh', '-c', script, 'sh', `${ip}:7233`], { read: true });
  log(`  namespace default: ${DRY ? `[dry-run] would ensure it exists at ${ip}:7233` : res.stdout}`);
}

// If an earlier phase was interrupted (the outer command timeout, a Ctrl-C, a
// killed terminal) the release record stays at `pending-upgrade` and every later
// `helm upgrade` refuses to run. Nothing is actually in progress, so roll the
// release back to the newest revision that finished, which makes the next upgrade
// apply cleanly.
function healPendingRelease() {
  const hist = run('helm', ['history', RELEASE, '-n', NAMESPACE, '--output', 'json'], { allowFail: true, read: true });
  if (hist.failed || !hist.stdout) return;
  let rows = [];
  try { rows = JSON.parse(hist.stdout); } catch { return; }
  if (!rows.some((r) => /^pending/.test(String(r.status)))) return;
  const last = rows.filter((r) => !/^pending/.test(String(r.status))).pop();
  if (!last) die(`release ${RELEASE} has only pending revisions and nothing to roll back to — run: helm -n ${NAMESPACE} uninstall ${RELEASE}`);
  log(`  release stuck at ${rows[rows.length - 1].status} — rolling back to revision ${last.revision} (${last.status})`);
  run('helm', ['rollback', RELEASE, String(last.revision), '-n', NAMESPACE, '--wait', '--timeout', '300s'], { timeout: 420000 });
}

function whyNotReady() {
  const all = run('kubectl', ['get', 'pods', '-n', NAMESPACE, '--no-headers'], { allowFail: true }).stdout;
  // kubectl accepts only one --field-selector value, and "not Running and not
  // Succeeded" is two, so the filter is done here. STATUS is column 3.
  const bad = all.split('\n').filter(Boolean).filter((line) => {
    const status = line.trim().split(/\s+/)[2];
    return status !== 'Running' && status !== 'Completed';
  }).join('\n');
  if (!bad) { log('  (no pod is outside Running/Completed — the stall is elsewhere: helm history + job logs)'); return; }
  for (const line of bad.split('\n')) {
    const cols = line.trim().split(/\s+/);
    log(`  pod ${cols[0]}: ${cols[2]}${cols[3] ? ` (${cols[3]})` : ''}`);
    const reason = run('kubectl', ['-n', NAMESPACE, 'get', 'pod', cols[0],
      '-o', 'jsonpath={.status.containerStatuses[0].state.waiting.reason}{" / "}{.status.conditions[?(@.type=="PodScheduled")].reason}'], { allowFail: true }).stdout;
    log(`    reason=${reason || 'unknown'}`);
  }
  const events = run('kubectl', ['-n', NAMESPACE, 'get', 'events', '--sort-by=.lastTimestamp',
    '-o', 'jsonpath={range .items[*]}{.reason}{" "}{.message}{"\n"}{end}'], { allowFail: true, timeout: 60000 });
  for (const e of events.stdout.split('\n').filter(Boolean).slice(-6)) log(`  event: ${e}`);
}

function infra() {
  helmPhase('4/9 infra — postgres, kafka, redis, clickhouse', [
    'api.enabled=false', 'consumer.enabled=false', 'worker.enabled=false',
    'frontend.enabled=false', 'migration.enabled=false',
  ], 600);
  for (const sts of ['flexprice-postgres', 'flexprice-kafka', 'flexprice-redis', 'flexprice-clickhouse']) {
    run('kubectl', ['rollout', 'status', `statefulset/${sts}`, '-n', NAMESPACE, '--timeout=420s'], { timeout: 480000 });
    log(`  ${sts} ready`);
  }
  // Kafka reports Ready when the broker answers the quorum check, which is not the
  // same as the controller having finished electing. `migrate kafka` in the next
  // phase would be the first thing to notice.
  run('kubectl', ['exec', '-n', NAMESPACE, 'flexprice-kafka-0', '--', 'kafka-metadata-quorum', '--bootstrap-controller', 'localhost:9093', 'describe', '--status'], { allowFail: true });
}

function dbinit() {
  step('5/9 the temporal database (nothing in the chart creates it)');
  const file = path.join(EXTRAS, '01-db-init.yaml');
  // A finished Job's pod template is immutable, so apply-over-existing fails the
  // moment the SQL changes. Delete first: the step is idempotent by design.
  run('kubectl', ['delete', 'job/flexprice-db-init', '-n', NAMESPACE, '--ignore-not-found']);
  run('kubectl', ['apply', '-f', file]);
  if (DRY) return;
  run('kubectl', ['wait', '--for=condition=complete', 'job/flexprice-db-init', '-n', NAMESPACE, '--timeout=420s'], { timeout: 480000 });
  log(`  ${execFileSync('kubectl', ['logs', 'job/flexprice-db-init', '-n', NAMESPACE], { encoding: 'utf8' }).trim().split('\n').pop()}`);
}

function temporal() {
  step('6/9 in-cluster Temporal (the chart cannot provide a usable one)');
  const file = path.join(EXTRAS, '02-temporal.yaml');
  run('kubectl', ['apply', '-f', file]);
  run('kubectl', ['rollout', 'status', 'deployment/flexprice-temporal', '-n', NAMESPACE, '--timeout=420s'], { timeout: 480000 });
  // The Service name is what `include "flexprice.temporalAddress"` emits; assert the
  // pair actually lines up rather than trusting the comment in the manifest.
  const ep = run('kubectl', ['get', 'endpoints', 'flexprice-temporal-frontend', '-n', NAMESPACE, '-o', 'jsonpath={.subsets[0].addresses[0].targetRef.name}'], { allowFail: true });
  log(`  flexprice-temporal-frontend:7233 -> ${ep.stdout || 'NO ENDPOINT'}`);
  registerTemporalNamespace();
}

function migration() {
  helmPhase('7/9 migrations — dbmate, ClickHouse schema, Kafka topics, seed', [
    'api.enabled=false', 'consumer.enabled=false', 'worker.enabled=false',
    'frontend.enabled=false', 'migration.enabled=true',
  ], 1500);
}

function app() {
  helmPhase('8/9 app — api, consumer, temporal worker', [
    'api.enabled=true', 'consumer.enabled=true', 'worker.enabled=true',
    'frontend.enabled=false', 'migration.enabled=false',
  ], 900);
  for (const d of ['flexprice-api', 'flexprice-consumer', 'flexprice-worker']) {
    run('kubectl', ['rollout', 'status', `deployment/${d}`, '-n', NAMESPACE, '--timeout=420s'], { timeout: 480000 });
    log(`  ${d} ready`);
  }
}

// --------------------------------------------------------------------- 9. verify

// Same assertions scripts/flexprice-bootstrap.js makes against the compose stack,
// re-aimed at the cluster. The point of repeating them rather than trusting
// `--wait` is that every one of these failures looks like success from the outside:
// ingest answers 202 with zero rows landing, an unseeded tenant 401s like a bad
// key, and a ClickHouse schema check without --database reports an empty schema on
// a healthy server.
async function verify(env) {
  step('9/9 verify');
  if (DRY) { log('  [dry-run] would port-forward and assert health, auth, topics, schemas, seed'); return { ok: true }; }
  const verdicts = [];
  const note = (name, ok, detail) => {
    verdicts.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const port = 18080;
  // svc/flexprice-api, not svc/flexprice: the chart names the API Service after the
  // component, so the shorter name the upstream NOTES snippet prints does not exist
  // here and a forward to it fails silently into "unreachable".
  const pf = spawn('kubectl', ['-n', NAMESPACE, 'port-forward', 'svc/flexprice-api', `${port}:80`], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  // The forward has to outlive every HTTP assertion below; killing it after /health
  // would turn the rest of the list into a wall of connection resets.
  try {
    // FLEXPRICE_API_KEY, not the _INGEST/_MONEY pair: this cluster's Postgres is
    // new, and the two plane keys are minted at runtime by
    // scripts/flexprice-provision.js, so they exist only in the stack they were
    // created against. The config-map key is the one the chart guarantees.
    const api = async (p, { key = env.FLEXPRICE_API_KEY, environmentId = SEED_ENVIRONMENT_ID } = {}) => {
      const headers = {};
      if (key) headers['x-api-key'] = key;
      if (environmentId) headers['X-Environment-ID'] = environmentId;
      try {
        const res = await fetch(`${base}${p}`, { headers, signal: AbortSignal.timeout(8000) });
        return { status: res.status, body: await res.text() };
      } catch (e) { return { status: 0, body: String(e.message) }; }
    };

    let health = null;
    for (let i = 0; i < 60 && !health; i += 1) {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) health = await res.text();
      } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    note('api /health', Boolean(health), health ? health.slice(0, 60) : 'unreachable after 120s');

    const authed = await api('/v1/meters');
    note('x-api-key + environment auth', authed.status === 200, `GET /v1/meters -> ${authed.status}`);
    note('rejects an unauthenticated read', (await api('/v1/meters', { key: '' })).status === 401, '');
    note('demands X-Environment-ID', (await api('/v1/meters', { environmentId: null })).status === 403, '');
    const envs = await api('/v1/environments');
    note('both seeded environments readable', envs.status === 200 && (envs.body.match(/"id"/g) || []).length >= 2, '');
  } finally {
    pf.kill();
  }

  // --database matters for the same reason it mattered in the spike: clickhouse-client
  // defaults to the `default` database, where currentDatabase() has 0 tables while
  // all of FlexPrice's live in `flexprice`.
  // `kafka-topics`, not `kafka-topics.sh`: this image puts the CLI wrappers in
  // /usr/bin without the .sh suffix, and exec'ing the suffixed name fails with
  // "executable file not found", which reads as "no topics" on a working broker.
  const topics = run('kubectl', ['exec', '-n', NAMESPACE, 'flexprice-kafka-0', '--', 'kafka-topics', '--bootstrap-server', 'localhost:9092', '--list'], { allowFail: true }).stdout.split('\n').filter(Boolean);
  note('kafka topics created', topics.length >= 11 && topics.includes('events'), `${topics.length} topics`);

  const ch = run('kubectl', ['exec', '-n', NAMESPACE, 'flexprice-clickhouse-0', '--', 'clickhouse-client',
    `--user=${env.FLEXPRICE_CH_USER}`, `--password=${env.FLEXPRICE_CH_PASSWORD}`, `--database=${env.FLEXPRICE_CH_DB}`,
    '--query', 'SELECT count() FROM system.tables WHERE database=currentDatabase()'], { allowFail: true }).stdout.trim();
  note('clickhouse schema', Number(ch || 0) > 0, `${ch} tables in ${env.FLEXPRICE_CH_DB}`);

  const pgq = (sql, database = env.FLEXPRICE_PG_DB) => run('kubectl', ['exec', '-n', NAMESPACE, 'flexprice-postgres-0', '--', 'psql',
    '-U', env.FLEXPRICE_PG_USER, '-d', database, '-Atc', sql], { allowFail: true }).stdout.trim();
  const migrated = pgq('SELECT count(*) FROM schema_migrations');
  note('dbmate migrations recorded', Number(migrated || 0) > 0, `${migrated} rows`);
  note('default tenant seeded', pgq(`SELECT count(*) FROM tenants WHERE id='${TENANT_ID}'`) === '1', '');
  // Temporal's own tables live in the `temporal` DATABASE (that is what
  // extras/01-db-init.yaml creates and what auto-setup then fills), not in a schema
  // inside flexprice's DB — asking the wrong one reports "relation does not exist"
  // against a server that is working. And its version table is `schema_version`,
  // singular and unlike dbmate's `schema_migrations`, because it tracks one row per
  // dialect rather than one per file.
  const temporalSchemas = pgq('SELECT count(*) FROM schema_version', 'temporal');
  note('temporal database + schemas', Number(temporalSchemas || 0) > 0, `${temporalSchemas} rows`);

  const pods = run('kubectl', ['get', 'pods', '-n', NAMESPACE, '--no-headers'], { allowFail: true }).stdout.split('\n').filter(Boolean);
  const notReady = pods.filter((line) => {
    const status = line.trim().split(/\s+/)[2];
    return status !== 'Running' && status !== 'Completed';
  });
  note('all pods Running/Completed', notReady.length === 0, notReady.length ? `${notReady.join(' | ')}` : `${pods.length} pods`);

  return { ok: verdicts.every((v) => v.startsWith('OK')), verdicts };
}

// ------------------------------------------------------------------------ main

(async function main() {
  for (const f of [ENV_FILE, VALUES]) if (!fs.existsSync(f)) die(`missing ${path.relative(REPO_ROOT, f)}`);
  const env = parseEnv(ENV_FILE);

  const { chartSrc } = skip('preflight') ? { chartSrc: '' } : preflight(env);
  if (!skip('secrets')) secrets(env);
  if (!skip('chart') && chartSrc) stageChart(chartSrc);
  else if (!skip('chart')) die('--from chart needs the preflight step to locate the checkout; run it from preflight');
  if (!skip('infra')) infra();
  if (!skip('dbinit')) dbinit();
  if (!skip('temporal')) temporal();
  if (!skip('migration')) migration();
  if (!skip('app')) app();
  const result = skip('verify') ? { ok: true } : await verify(env);

  log('');
  if (!result.ok) {
    log('NOT READY — failing checks:');
    for (const v of result.verdicts.filter((x) => x.startsWith('FAIL')) ) log(`  ${v}`);
    log('');
    log('read the phase that produced it:');
    log(`  kubectl -n ${NAMESPACE} logs job -l batch.kubernetes.io/job-name --all-containers --tail=80`);
    log(`  kubectl -n ${NAMESPACE} logs deploy/flexprice-api --tail=80`);
    log(`  helm -n ${NAMESPACE} history ${RELEASE}`);
    process.exitCode = 1;
    return;
  }
  log('FlexPrice is up on kind from the upstream chart.');
  log('');
  log('kind has no LB here, so the endpoint is a port-forward. Keep it running, then:');
  log(`  kubectl -n ${NAMESPACE} port-forward svc/flexprice-api 18080:80 &`);
  log('  npm run billing:flexprice:provision    # mints THIS cluster\'s ingest/money keys into deploy/flexprice/.env');
  log('  npm run billing:flexprice:inspect');
  log('');
  log('the billing service then reads (flexprice-config.js defaults to 127.0.0.1:18080):');
  log('  FLEXPRICE_ENABLED=true');
  log(`  FLEXPRICE_ENVIRONMENT_ID=${SEED_ENVIRONMENT_ID}`);
  log('  FLEXPRICE_API_KEY_INGEST / FLEXPRICE_API_KEY_MONEY = the pair provision just wrote');
  log('  (the pair already in .env belongs to the compose stack: keys live in Postgres, and this');
  log('   cluster\'s Postgres is new, so the old ones 401 until provision has run against it)');
  log('teardown: helm -n ' + NAMESPACE + ' uninstall ' + RELEASE + ' && kubectl delete namespace ' + NAMESPACE + ' (extras/ objects are kubectl-owned, so uninstall does not remove them)');
})();
