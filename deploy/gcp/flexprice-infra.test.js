'use strict';

// Structural invariants for the self-hosted FlexPrice stack on GKE.
//
// Nothing here runs Terraform or Helm: these are the facts a future edit can
// break silently, where "silently" means an apply that converges onto a stack
// that cannot bill. Each assertion therefore pins a decision whose failure mode
// is a Pending pod, a migration that never runs, or a tenant moving money
// before counsel cleared the AGPL memo — not a plan error.
//
// Style follows deploy/gcp/billing-infra.test.js: read the source, match the
// contract, and name the consequence in the failure message.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const TF_DIR = path.join(ROOT, 'deploy', 'gcp', 'terraform-flexprice');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const readTf = (name) => fs.readFileSync(path.join(TF_DIR, name), 'utf8');
const readAllTf = () => fs.readdirSync(TF_DIR).filter((f) => f.endsWith('.tf')).map(readTf).join('\n');

function block(source, header, label = header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing ${label}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(resource|variable|locals|moved|output|data|provider) /);
  return source.slice(start, next === -1 ? source.length : start + 1 + next);
}

const helmInfra = readTf('helm_infra.tf');
const helmMigration = readTf('helm_migration.tf');
const helmApp = readTf('helm_app.tf');
const variablesTf = readTf('variables.tf');
const extrasTf = readTf('extras.tf');
const namespacesTf = readTf('namespaces.tf');
const secretsTf = readTf('secrets.tf');
const outputsTf = readTf('outputs.tf');
const frontTf = readTf('front.tf');
const values = YAML.parse(read('deploy', 'gcp', 'terraform-flexprice', 'values', 'base.yaml'));
const workflow = read('.github', 'workflows', 'deploy.yml');
const rootVariables = read('deploy', 'gcp', 'terraform', 'variables.tf');
const rootBilling = read('deploy', 'gcp', 'terraform', 'billing_service.tf');
const stagingScript = read('scripts', 'flexprice-stage-chart.js');
const powerWorkflow = read('.github', 'workflows', 'substrate-cluster-power.yml');
const nodepoolWorkflow = read('.github', 'workflows', 'flexprice-nodepools.yml');
const cleanupScript = read('deploy', 'gcp', 'flexprice-cleanup.sh');
const recreateScript = read('deploy', 'gcp', 'flexprice-recreate.sh');
const nodePoolTf = readTf('node_pool.tf');

// --- The gate that keeps this off the money path ------------------------------

test('the billing cutover is a second, closed gate — not the feature switch', () => {
  const v = block(rootVariables, 'variable "flexprice_billing_cutover_enabled"');
  assert.match(v, /default\s*=\s*false/, 'the cutover gate must default closed');

  // Both halves required. `true && cutover` is the whole design: infra can be
  // built and probed while no organization's money moves.
  assert.match(rootBilling, /FLEXPRICE_ENABLED\s*=\s*tostring\(var\.flexprice_enabled && var\.flexprice_billing_cutover_enabled\)/,
    'FLEXPRICE_ENABLED must be the conjunction of the feature switch and the cutover gate');
});

test('the three FlexPrice root variables are optional but still format-checked', () => {
  for (const [name, pattern] of [
    ['flexprice_base_url', /https/],
    ['flexprice_environment_id', /UUID|[0-9a-f]/],
    ['flexprice_supplier_state_code', /0\[1-9\]|state/],
  ]) {
    const v = block(rootVariables, `variable "${name}"`);
    assert.match(v, /default\s*=\s*""/, `${name} must accept "" so an apply with no repo variables converges`);
    assert.match(v, /validation/, `${name} must still validate a non-empty value against ${pattern}`);
    assert.match(v, /==\s*""/, `${name}'s validation must exempt the empty value`);
  }
});

test('docs and CI name the gate instead of implying the stack is billing anyone', () => {
  const readme = readTf.bind(null, 'README.md');
  assert.match(readme(), /NOT CLEARED|gate/i, 'the module README must state the AGPL gate');
  assert.match(workflow, /FLEXPRICE_BILLING_CUTOVER_ENABLED/,
    'deploy.yml must pass the cutover gate from a repo variable, defaulting false');
});

// --- Release shape ------------------------------------------------------------

test('three releases, one namespace, each with a stable enablement story', () => {
  for (const [source, name] of [[helmInfra, 'flexprice_infra'], [helmMigration, 'flexprice_migration'], [helmApp, 'flexprice_app']]) {
    const r = block(source, `resource "helm_release" "${name}"`);
    assert.match(r, /create_namespace\s*=\s*false/, `${name}: the module owns the namespace and its labels`);
    assert.match(r, /atomic\s*=\s*true/);
    assert.match(r, /cleanup_on_fail\s*=\s*true/);
    assert.match(r, /wait\s*=\s*true/);
    assert.match(r, /force_update\s*=\s*false/);
    assert.match(r, /max_history\s*=\s*5/);
    assert.match(r, /version\s*=\s*var\.chart_version/, `${name} must install the pinned chart, never a range`);
  }

  // Disjoint enablement, which is what keeps three releases in one namespace from
  // fighting over one object.
  assert.match(helmInfra, /retainStorage = true/);
  assert.match(helmMigration, /enabled = true\s*\n\s*asHook\s+= false/);
  assert.match(helmApp, /migration = \{ enabled = false \}/);
  assert.doesNotMatch(helmApp, /retainStorage = true/, 'only the infra release may create the cluster-scoped StorageClass');
  assert.doesNotMatch(helmInfra, /api = \{ enabled = true \}/, 'the infra release must not render app Deployments');
});

test('the migration release waits for its Jobs, and the ordering is expressed', () => {
  const r = block(helmMigration, 'resource "helm_release" "flexprice_migration"');
  // `wait` alone is `--wait`, which does not treat a completed Job as ready. This
  // release IS Jobs, so `--wait-for-jobs` is the difference between an apply that
  // means "migrated" and one that means "the pods started".
  assert.match(r, /wait_for_jobs = true/);
  assert.match(r, /depends_on = \[[\s\S]*helm_release\.flexprice_infra[\s\S]*kubectl_manifest\.flexprice_db_init[\s\S]*kubectl_manifest\.flexprice_temporal/,
    'the migration Job cannot wait on Services that do not exist yet');
});

test('non-infra releases point every store at the release that owns it', () => {
  for (const [source, label] of [[helmMigration, 'migration'], [helmApp, 'app']]) {
    assert.ok(/local\.flexprice_stores_elsewhere/.test(source), `${label} must render zero infrastructure objects`);
  }
  const elsewhere = block(helmInfra, 'flexprice_stores_elsewhere = {');
  for (const [key, want] of [
    ['postgres', /external = \{ enabled = true \}/],
    ['clickhouse', /mode\s*=\s*"external"/],
    ['kafkaConfig', /external = \{ enabled = true \}/],
    ['redisConfig', /external = \{ enabled = true \}/],
  ]) {
    assert.match(block(elsewhere, `${key} = {`, `stores_elsewhere.${key}`), want);
  }
  // The addresses, not just the toggles: values.yaml's external-mode defaults are
  // `kafka-service:9092` and `redis-service`, which exist nowhere on this cluster.
  assert.match(elsewhere, /"flexprice-clickhouse:9000"/);
  assert.match(elsewhere, /"flexprice-kafka:9092"/);
  assert.match(elsewhere, /host\s+= "flexprice-redis"/);
  assert.match(elsewhere, /"flexprice-temporal-frontend:7233"/);
});

test('only the migration release registers the Temporal namespace', () => {
  // The bootstrap Job's name is unhashed, so a second release setting
  // bootstrapNamespaces would render the same Job twice.
  assert.match(helmMigration, /bootstrapNamespaces = \[\{/);
  assert.doesNotMatch(helmApp, /bootstrapNamespaces/, 'two releases would own one bootstrap Job');
  assert.doesNotMatch(helmInfra, /bootstrapNamespaces = /);
});

// --- The two imperative-shaped gaps ------------------------------------------

test('the chart is staged, not pulled, and staging does three named things', () => {
  // Pinned at the call sites, not the identifiers: the script's own comments and
  // function names mention every one of these strings, so matching a name alone
  // stays green while the behaviour it describes is deleted.
  assert.match(stagingScript, /^\s*files\.delete\('Chart\.lock'\);$/m, 'the lock names the deps that were just removed');
  assert.match(stagingScript, /files\.set\('Chart\.yaml', stripDependencies\(files\.get\('Chart\.yaml'\)\)\)/,
    'Helm refuses to install a chart with un-vendored deps');
  assert.match(stagingScript, /if \(removed !== 4\) throw/, 'a fifth dependency, or a renamed one, must stop the build rather than be guessed past');
  assert.match(stagingScript, /timeoutSeconds: 20/);
  assert.match(stagingScript, /failureThreshold: 6/);
  assert.match(stagingScript, /nodeSelector/, 'postgres/kafka/redis templates expose no placement keys; the patch injects them');
  assert.match(stagingScript, /sha256/, 'a patched chart must be identified by a recorded digest');
  // The files it must touch, and the one that already has placement keys.
  for (const c of ['postgres', 'kafka', 'clickhouse', 'redis']) {
    assert.ok(stagingScript.includes(`'${c}'`), `staging must widen ${c} probes`);
  }
  const placement = stagingScript.match(/const PLACEMENT_FILES = \[[^\]]*\]/);
  assert.ok(placement, 'no placement injection list');
  assert.doesNotMatch(placement[0], /clickhouse/, 'clickhouse already reads .Values.clickhouse.standalone.nodeSelector');
});

test('the temporal database and the temporal server are owned here', () => {
  assert.match(extrasTf, /resource "kubectl_manifest" "flexprice_db_init"/);
  assert.match(extrasTf, /resource "kubectl_manifest" "flexprice_temporal"/);
  assert.match(extrasTf, /resource "kubectl_manifest" "flexprice_temporal_service"/);
  assert.match(extrasTf, /createdb[^\n]*temporal/);
  // The name the chart's own helper and the env block resolve to.
  assert.match(extrasTf, /flexprice-temporal-frontend/);
  // A finished Job's pod template is immutable, so the identity moves into the
  // name rather than being patched in place.
  assert.match(extrasTf, /flexprice-db-init-\$\{local\.db_init_hash\}/);
  assert.match(extrasTf, /db_init_hash = substr\(sha256/);
});

test('the front is gated on a hostname and owns its own solver', () => {
  assert.match(frontTf, /flexprice_front_enabled = var\.flexprice_enabled && var\.ingress_hostname != ""/);
  const kinds = [...frontTf.matchAll(/resource "kubectl_manifest" "([a-z_]+)"/g)].map((m) => m[1]);
  for (const need of ['flexprice_issuer', 'flexprice_certificate', 'flexprice_gateway', 'flexprice_api_route']) {
    assert.ok(kinds.includes(need), `front.tf must render ${need}`);
  }
  // The shared ClusterIssuer's solvers name only the substrate fronts, so a
  // certificate owned here would sit Pending forever with nothing erroring.
  assert.match(frontTf, /kind\s*=\s*"Issuer"/);
  assert.match(frontTf, /name\s*=\s*"flexprice-ingress"/, 'the solver parentRef must name this front\'s own Gateway');
  // HTTP-01 arrives on port 80, and Envoy Gateway will not Program a Gateway whose
  // certificate Secret is missing — hence both listeners.
  assert.match(frontTf, /protocol\s*=\s*"HTTP"/);
  assert.match(frontTf, /protocol\s*=\s*"HTTPS"/);
  assert.match(frontTf, /sectionName\s*=\s*"http"/, 'the redirect must claim only the port 80 listener');
  assert.match(frontTf, /sectionName\s*=\s*"https"/, 'the API route pinned to both listeners would contend with its own redirect');
});

// --- Placement, storage, images ----------------------------------------------

test('the node pool is never one the substrate power workflow parks', () => {
  const pool = block(variablesTf, 'variable "node_pool_name"').match(/default\s+=\s+"([^"]+)"/)[1];
  assert.equal(pool, 'flexprice-pool');
  // The power workflow scales exactly the pools its env block names. A pool it
  // never names is a pool it cannot park — which is the whole reason this stack
  // has its own. Naming it there would stop a ClickHouse or Kafka quorum at
  // 03:00 and bring it back as a database that has to recover.
  assert.doesNotMatch(powerWorkflow, new RegExp(pool.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')),
    `${pool} must never appear in the power workflow`);
  const parked = [...powerWorkflow.matchAll(/vars\.SUBSTRATE[A-Z_]*NODE_POOL[^}]*\|\|\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(parked.length >= 2, 'expected the power workflow to name the pools it parks');
  assert.ok(!parked.includes(pool), `${pool} must not be a pool the power workflow parks`);
  assert.match(block(variablesTf, 'variable "node_min_count"'), /condition\s+= var\.node_min_count >= 1/,
    'min 1: a parked pool cannot serve a cold quorum and the StatefulSets have nowhere else');
});

// --- CI face of the pool teardown (flexprice-nodepools.yml + cleanup/recreate) ---
// Neither graph indexes YAML or shell, so these assertions are the only thing between a
// flag rename in a script `case` and a workflow that silently stops passing it — the
// same failure class substrate-workflow-config.test.js guards for the substrate pools.

test('the node-pool teardown workflow is manual-only and rehearses by default', () => {
  // One of these two scripts deletes the pool holding every FlexPrice database. A push
  // or cron trigger here would make an unrelated merge a teardown.
  const on = nodepoolWorkflow.match(/^on:\n([\s\S]*?)^\n/m)[1];
  assert.match(on, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(on, /^\s{2}(push|schedule|pull_request|workflow_call|repository_dispatch):/m,
    'flexprice-nodepools.yml gained a non-manual trigger');
  assert.doesNotMatch(nodepoolWorkflow, /^\s+cron:/m);
  assert.match(nodepoolWorkflow, /dry_run:\n(?:.*\n){1,4}        default: true/,
    'dry_run defaulting to false is how a click becomes a teardown');
});

test('every flag the teardown workflow passes is one the script parses', () => {
  const run = nodepoolWorkflow.match(/- name: Run\n        run: \|\n([\s\S]*?)\n\n      - name:/)[1];
  const flags = [...new Set([...run.matchAll(/FLAGS\+=\((--[a-z-]+)/g)].map((m) => m[1]))];
  assert.ok(flags.length >= 5, `expected the flag matrix, saw ${flags.join(' ')}`);
  const accepts = (src) => new Set([...src.matchAll(/^\s*--([a-z-]+)[=*][^)]*\)|^\s*--([a-z-]+)\)/gm)]
    .map((m) => `--${m[1] || m[2]}`));
  const want = { '--dry-run': [cleanupScript, recreateScript], '--keep-pool': [cleanupScript],
    '--backup-only': [cleanupScript], '--destroy-pvc': [cleanupScript], '--yes': [cleanupScript],
    '--with-disk-snapshot': [cleanupScript], '--skip-backup': [cleanupScript],
    '--snapshot': [recreateScript] };
  for (const flag of flags) {
    const scripts = want[flag];
    assert.ok(scripts, `the workflow passes ${flag}, which nothing here declares — add it to the table`);
    for (const src of scripts) {
      assert.ok(accepts(src).has(flag.replace(/=$/, '')), `${flag} is not in that script's argument case`);
    }
  }
});

test('the teardown workflow names the pool, namespace and cluster the module owns', () => {
  // The literals here are pinned to variables.tf because the staged chart's placement
  // (helm_infra.tf flexprice_placement) reads the SAME names: a workflow pointing at
  // another pool recreates compute nothing selects, and the stores stay Pending.
  const pool = block(variablesTf, 'variable "node_pool_name"').match(/default\s+=\s+"([^"]+)"/)[1];
  const ns = block(variablesTf, 'variable "namespace"').match(/default\s+=\s+"([^"]+)"/)[1];
  assert.match(nodepoolWorkflow, new RegExp(`POOL: '${pool}'`), 'workflow pool literal is not the module default');
  assert.match(nodepoolWorkflow, new RegExp(`FP_NS: '${ns}'`), 'workflow namespace literal is not the module default');
  for (const key of ['CLUSTER', 'ZONE']) {
    const wf = nodepoolWorkflow.match(new RegExp(`${key}: \\$\\{\\{ vars\\.[A-Z0-9_]+ \\|\\| '([^']+)' \\}\\}`));
    const job = workflow.match(new RegExp(`^\\s+${key}: \\$\\{\\{ vars\\.[A-Z0-9_]+ \\|\\| '([^']+)' \\}\\}`, 'm'));
    assert.ok(wf && job, `${key} is not bound to a vars fallback in both workflows`);
    assert.equal(wf[1], job[1], `the teardown workflow and deploy.yml disagree on ${key}`);
  }
});

test('the teardown workflow serialises with its own Terraform owner, not the power group', () => {
  // The structural guarantee cuts both ways: naming flexprice-pool in the substrate
  // power workflow is forbidden above, and JOINING its concurrency group here would
  // queue a billing restore behind a 03:00 drain it must never wait for (and vice
  // versa). The only other writer of this pool is deploy.yml's flexprice_reconcile job.
  assert.match(nodepoolWorkflow, /^\s+group: flexprice-reconcile$/m);
  assert.match(nodepoolWorkflow, /cancel-in-progress: false/);
  assert.doesNotMatch(nodepoolWorkflow, /group: substrate-cluster-power/,
    'joining the power group makes a pool the power workflow must never see a shared resource');
});

test('the recreate defaults and cleanup abort-gates mirror the module design', () => {
  // The taint is what makes the pool dedicated rather than merely named; the module
  // spells it in HCL form and the script in the gcloud form. Equal values, or a restore
  // leaves every flexprice pod Pending on a toleration mismatch.
  for (const part of ['fleet.dev/dedicated', 'flexprice', 'NO_SCHEDULE']) {
    assert.ok(nodePoolTf.includes(part), `node_pool.tf no longer carries the taint part ${part}`);
  }
  assert.match(recreateScript, /POOL_TAINT_DEFAULT="fleet\.dev\/dedicated=flexprice:NoSchedule"/);
  assert.match(recreateScript, /POOL_MIN_DEFAULT=1/, 'min 0 would violate the node_min_count validation');
  // The two abort gates of the substrate design, restated for Retain volumes: no clear
  // unless every PV is Retain, and the PVC tier needs the explicit --yes.
  assert.match(cleanupScript, /are NOT Retain/, 'the reclaim-policy gate left the cleanup script');
  assert.match(cleanupScript, /--destroy-pvc needs --yes/);
  // A live run is typed-consent gated, strongest word wins.
  const gate = nodepoolWorkflow.match(/- name: Check the inputs agree[\s\S]*?\n      - name: Run/)[0];
  for (const word of ['teardown', 'destroy-pvc', 'restore']) {
    assert.match(gate, new RegExp(`REQUIRED=${word.replace(/-/g, '\\-')}`), `no gate word ${word}`);
  }
  assert.match(gate, /\[ "\$CONFIRM" = "\$REQUIRED" \]/);
});

test('storage is chart-owned Retain/pd-ssd, and Terraform does not also declare the class', () => {
  assert.match(helmInfra, /provisioner\s*=\s*"pd\.csi\.storage\.gke\.io"/);
  assert.match(helmInfra, /type\s*=\s*"pd-ssd"/);
  assert.match(helmInfra, /name\s*=\s*var\.storage_class_name/);
  assert.doesNotMatch(readAllTf(), /resource "kubernetes_storage_class_v1"/,
    'one StorageClass with two owners is a conflicting field manager');
  // base.yaml keeps the local shape's opt-out: per-component storageClass "" so
  // the chart's helper resolves to the Retain class rather than the pool default.
  assert.equal(values.postgres.internal.persistence.storageClass, '');
  assert.equal(values.clickhouse.standalone.persistence.storageClass, '');
});

test('every image is pulled, never assumed present', () => {
  assert.match(helmInfra, /pullPolicy = "IfNotPresent"/);
  assert.doesNotMatch(readAllTf(), /pullPolicy\s*=\s*"Never"/, 'Never is a kind-cluster answer');
  // The pull policy rides on the shared image ref, so all three releases must use
  // that ref rather than spelling an image block of their own: the one that did
  // not would inherit base.yaml's `repository` — a ghcr.io path nothing here can
  // pull — and its pods would sit at ErrImagePull with the reason buried a
  // `kubectl describe` away from the registry that refused.
  for (const [source, label] of [[helmInfra, 'infra'], [helmMigration, 'migration'], [helmApp, 'app']]) {
    assert.match(source, /image\s*=\s*local\.flexprice_image_ref/, `${label} must use the Artifact Registry ref`);
  }
});

test('the image tag is not merely cosmetic next to a digest', () => {
  // The migration Job hashes `<repository>:<tag | .Chart.AppVersion>` into its
  // name; this chart's appVersion is the constant "1.0.0", so an empty tag lets a
  // new image reuse a completed Job name and skip its migrations.
  assert.match(block(variablesTf, 'variable "image_tag"'), /migration Job|name hash/i);
  assert.match(workflow, /image_tag=\$TAG|SHORT_TAG/, 'CI must pass a content-derived tag');
});

test('chart and digest inputs are pinned and validated', () => {
  const chartVar = block(variablesTf, 'variable "chart_version"');
  assert.match(chartVar, /validation/);
  assert.match(chartVar, /regex\("\^\[0-9\]/, 'exact SemVer, not a range');
  assert.match(block(variablesTf, 'variable "image_digest"'), /\^sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(block(variablesTf, 'variable "cluster_name"'), /default\s+=\s+"substrate-multitenant"/);
  assert.doesNotMatch(readAllTf(), /resource "google_container_cluster"/, 'this root reads the cluster, never creates it');

  // The staged chart is not the upstream chart, so what was built from which
  // commit is a record rather than an inference. A chart_version that drifted
  // from VERSION means the module and the supply-chain note describe two
  // different artifacts, and only one of them is installable.
  const pinned = read('deploy', 'flexprice', 'VERSION');
  const chartVersion = chartVar.match(/default\s+=\s+"([^"]+)"/)[1];
  assert.match(pinned, new RegExp(`patched_chart_version=${chartVersion.replace(/[+.]/g, '\\$&')}`),
    `VERSION must record the chart this module installs (${chartVersion})`);
  assert.match(pinned, /patched_chart_sha256=[0-9a-f]{64}/,
    'VERSION must record the digest of the patched tree, or the patch is unauditable');
  assert.match(pinned, /patched_chart_source=internal\/ee\/infrastructure\/helm\/flexprice/);
  assert.match(workflow, /record this in deploy\/flexprice\/VERSION/i,
    'CI prints the sha it pushed; the record has to be updated in the same change');
});

// The format of the recorded digest is checkable anywhere; its VALUE is only
// checkable against the tree it was derived from. That checkout is a workstation
// artifact (`npm run billing:flexprice:bootstrap` creates it), so this skips in CI
// rather than pretending — and runs, and catches a stale sha, on the machine where
// someone just bumped the pin.
const CHART_SRC = path.join(process.env.FLEXPRICE_CHECKOUT
  || path.join(ROOT, 'deploy', 'flexprice', 'checkout'), 'internal', 'ee', 'infrastructure', 'helm', 'flexprice');
test('the recorded patched-chart digest reproduces from the pinned checkout',
  { skip: fs.existsSync(path.join(CHART_SRC, 'Chart.yaml')) ? false : 'no FlexPrice checkout on this machine' }, () => {
    const chartVersion = block(variablesTf, 'variable "chart_version"').match(/default\s+=\s+"([^"]+)"/)[1];
    const recorded = read('deploy', 'flexprice', 'VERSION').match(/patched_chart_sha256=([0-9a-f]{64})/)[1];
    const out = execFileSync('node', [path.join(ROOT, 'scripts', 'flexprice-stage-chart.js'),
      '--source', CHART_SRC, '--out', path.join(os.tmpdir(), `fp-stage-${process.pid}`),
      '--version', chartVersion, '--dry-run'], { encoding: 'utf8' });
    const derived = out.match(/chart sha256: ([0-9a-f]{64})/);
    assert.ok(derived, `staging printed no digest:\n${out}`);
    assert.equal(derived[1], recorded,
      `VERSION records ${recorded} but the pinned tree stages to ${derived[1]}`);
  });

// --- Secrets ------------------------------------------------------------------

test('five secret containers, no versions, no material in state', () => {
  const ids = block(secretsTf, 'flexprice_secret_ids = {');
  const expected = [
    ['postgres-password', 'flexprice-postgres-password'],
    ['clickhouse-password', 'flexprice-clickhouse-password'],
    ['auth-secret', 'flexprice-auth-secret'],
    ['encryption-key', 'flexprice-encryption-key'],
    ['api-key-keys', 'flexprice-api-key-keys'],
  ];
  for (const [key, id] of expected) {
    assert.match(ids, new RegExp(`${key}\\s*=\\s*"${id}"`), `missing secret container ${key} -> ${id}`);
  }
  // The CI mirror derives the Kubernetes key by stripping `flexprice-` from the id
  // it lists, so a name that does not follow `<prefix><key>` silently reads a
  // nonexistent file into `--from-file` and applies a Secret with a wrong key.
  const ciIds = workflow.match(/SECRET_IDS:\s*([^\n]+)/)[1].trim().split(/\s+/);
  assert.deepEqual(ciIds, expected.map(([, id]) => id),
    'deploy.yml must mirror exactly the five ids this root creates');
  assert.match(secretsTf, /resource "google_secret_manager_secret" "flexprice"/);
  assert.doesNotMatch(readAllTf(), /resource "google_secret_manager_secret_version"/,
    'a version in state is the secret written into the state file');
  assert.doesNotMatch(readAllTf(), /secret_version/);
  // The writer role that is actually bindable at the secret level.
  assert.match(secretsTf, /roles\/secretmanager\.secretVersionManager/);
  assert.doesNotMatch(secretsTf, /roles\/secretmanager\.admin/);

  // The literals the app authenticates with must agree with the chart's own
  // defaults; a divergence is a connection that fails later, not now.
  assert.equal(values.env.FLEXPRICE_POSTGRES_USER, 'flexprice');
  assert.equal(values.env.FLEXPRICE_CLICKHOUSE_USER, 'flexprice');
  assert.equal(values.env.FLEXPRICE_ALLOW_INSECURE_DEFAULTS, 'false',
    'true is upstream compose\'s dev default and it accepts the public demo key');

  // secretEnv is the chart's env→Secret-key map, and the Kubernetes Secret is
  // built out-of-band by CI. Every target key must be one CI actually writes:
  // a name that appears on only one side renders a pod whose env var is unset,
  // which FlexPrice reports as an authentication failure rather than as config.
  assert.deepEqual(values.secretEnv, {
    FLEXPRICE_POSTGRES_PASSWORD: 'postgres-password',
    FLEXPRICE_CLICKHOUSE_PASSWORD: 'clickhouse-password',
    FLEXPRICE_AUTH_SECRET: 'auth-secret',
    FLEXPRICE_SECRETS_ENCRYPTION_KEY: 'encryption-key',
    FLEXPRICE_AUTH_API_KEY_KEYS: 'api-key-keys',
  });
  for (const key of Object.values(values.secretEnv)) {
    assert.ok(workflow.includes(`--from-file="${key}=`), `deploy.yml never writes the Secret key ${key}`);
  }
});

test('the API key map is pointed at the seeded tenant, in docs and in CI', () => {  const TENANT = '00000000-0000-0000-0000-000000000000';
  assert.match(read('deploy', 'gcp', 'terraform-flexprice', 'APPLY.md'), new RegExp(TENANT));
  assert.match(workflow, new RegExp(TENANT), 'CI must refuse a key map that names no existing tenant');
});

// --- Values: the cloud twin of the kind file -----------------------------------

test('base.yaml disables the apps and renders the stores itself, in-cluster', () => {
  assert.equal(values.api.enabled, false);
  assert.equal(values.consumer.enabled, false);
  assert.equal(values.worker.enabled, false);
  assert.equal(values.migration.enabled, false);
  assert.equal(values.dataProtection.retainStorage, false, 'only the infra release may turn retention on');
  assert.equal(values.secrets.existingSecret, 'flexprice-secrets');
  // The Bitnami/temporal subcharts are NOT toggled off here, because the staged
  // chart has no `dependencies:` block to toggle: scripts/flexprice-stage-chart.js
  // strips them, so `postgresql.enabled` is not even a key the chart reads. What
  // must be pinned instead is that every store resolves to the chart's own
  // hand-rolled in-cluster templates, and that the only externalised component is
  // the Temporal server extras.tf owns.
  assert.equal(values.postgres.external.enabled, false, 'postgres must render internally');
  assert.equal(values.kafkaConfig.external.enabled, false, 'kafka must render internally');
  assert.equal(values.redisConfig.external.enabled, false, 'redis must render internally');
  assert.equal(values.clickhouse.mode, 'standalone', 'altinity would render a CRD the operator for which nothing installs');
  assert.equal(values.temporal.enabled, false, 'the official subchart needs vendored deps');
  assert.equal(values.temporalConfig.enabled, true, 'it gates the namespace bootstrap Job');
  assert.equal(values.temporalConfig.external.enabled, true, 'extras.tf owns the server, not the chart');
  assert.equal(values.serviceAccount.perComponent, false, 'no per-component Google SAs without event storage');
  assert.equal(values.serviceAccount.name, 'flexprice');
  assert.equal(values.temporalConfig.address, 'flexprice-temporal-frontend:7233');
  assert.equal(values.ingress.enabled, false);
  assert.equal(values.networkPolicy.enabled, false);
});

test('PodSecurity enforces baseline, because restricted refuses the databases', () => {
  assert.match(namespacesTf, /pod-security\.kubernetes\.io\/enforce"?\s*=\s*"baseline"/);
  assert.match(namespacesTf, /pod-security\.kubernetes\.io\/audit"?\s*=\s*"restricted"/);
  assert.doesNotMatch(namespacesTf, /enforce"?\s*=\s*"restricted"/,
    'postgres/redis/kafka/temporal pods cannot run under restricted — they would not schedule');
});

// --- Outputs the operator acts on ----------------------------------------------

test('the DNS obligation is surfaced in one line a human can hand a registrar', () => {
  const o = block(outputsTf, 'output "flexprice_dns_hint"');
  assert.match(o, /A record:/);
  assert.match(o, /-> /);
  assert.match(o, /google_compute_address\.flexprice_ip/, 'the hint must carry the address itself, not a placeholder');
  assert.match(outputsTf, /output "flexprice_ingress_ip"/, 'the address must also be output on its own, for the record-creation step');
  assert.match(outputsTf, /flexprice_base_url = local\.flexprice_front_enabled \? "https:\/\/\$\{var\.ingress_hostname\}"/,
    'the URL is https and only exists with a hostname');
  assert.match(block(outputsTf, 'output "flexprice_api_service"'), /value\s+= var\.flexprice_enabled \?/,
    'the in-cluster address exists whether or not a public front was asked for');
  const docs = read('deploy', 'gcp', 'terraform-flexprice', 'README.md');
  assert.match(docs, /archagentix\.com/, 'the README must name the record, not just describe it');
  assert.match(docs, /Nothing in this repo writes Cloud DNS/i);
});

// --- CI wiring -------------------------------------------------------------------

test('the reconcile job exists, is path-scoped, and does not join the power group', () => {
  assert.match(workflow, /flexprice:\s*\[[^\]]*deploy\/gcp\/terraform-flexprice\/\*\*/);
  assert.match(workflow, /'deploy\/flexprice\/\*\*'/);
  assert.match(workflow, /'scripts\/flexprice-\*'/);
  assert.match(workflow, /run_flexprice/);

  // Slice from the JOB (2-space indent), not the workflow_dispatch input of the
  // same name (6-space indent) — slicing on the bare string finds the input
  // first and then asserts against the whole file.
  const at = workflow.search(/^ {2}flexprice_reconcile:/m);
  assert.notEqual(at, -1, 'no flexprice_reconcile job');
  const job = workflow.slice(at);
  assert.match(job, /group: flexprice-reconcile/);
  assert.doesNotMatch(job, /group: substrate-cluster-power/,
    'this job must not serialise with the pool-parking workflow it deliberately stays out of');
  assert.match(job, /FP_TF_STATE_PREFIX: substrate\/flexprice/);
  assert.match(job, /flexprice_plan_only/);
  assert.match(job, /flexprice_allow_destroy/);
  assert.match(job, /helm registry login/, 'OCI chart push needs the registry login, not just docker');
  assert.match(job, /helm push/);
  assert.match(job, /-target=google_artifact_registry_repository/, 'the repos must exist before the chart can be pushed');
  assert.match(job, /rollout status/, 'a green apply that never checked the pods is not a verified stack');
});
