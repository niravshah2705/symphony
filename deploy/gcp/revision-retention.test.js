'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'deploy/gcp/prune-cloud-run-revisions.sh');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const FAKE_GCLOUD = String.raw`
gateway_revisions='gw-6 gw-5 gw-4 gw-3 gw-2 gw-1'
pipeline_revisions='po-3 po-2 po-1'
tenant_revisions='tenant-4 tenant-3 tenant-2 tenant-1'

print_words() {
  local word
  for word in $1; do printf '%s\n' "$word"; done
}

remove_word() {
  local words="$1" removed="$2" word
  for word in $words; do
    [ "$word" = "$removed" ] || printf '%s\n' "$word"
  done
}

service_revision_words() {
  case "$1" in
    gateway) printf '%s\n' "$gateway_revisions" ;;
    pipeline-orchestrator) printf '%s\n' "$pipeline_revisions" ;;
    gw-tenant) printf '%s\n' "$tenant_revisions" ;;
    zero) printf '\n' ;;
    one) printf 'one-1\n' ;;
    two) printf 'two-2 two-1\n' ;;
    three) printf 'three-3 three-2 three-1\n' ;;
    *) return 91 ;;
  esac
}

service_latest() {
  case "$1" in
    gateway) printf 'gw-6\tgw-6\n' ;;
    pipeline-orchestrator) printf 'po-3\tpo-3\n' ;;
    gw-tenant) printf 'tenant-4\ttenant-4\n' ;;
    zero) printf '\n' ;;
    one) printf 'one-1\tone-1\n' ;;
    two) printf 'two-2\ttwo-2\n' ;;
    three) printf 'three-3\tthree-3\n' ;;
  esac
}

service_traffic() {
  case "$1" in
    gateway) printf '%s\n' "__DOLLAR__{GATEWAY_TRAFFIC:-gw-6}" ;;
    pipeline-orchestrator) printf 'po-3\n' ;;
    gw-tenant) printf 'tenant-4\n' ;;
    zero) printf '\n' ;;
    one) printf 'one-1\n' ;;
    two) printf 'two-2\n' ;;
    three) printf 'three-3\n' ;;
  esac
}

gcloud() {
  printf '%s\n' "$*" >> "$CALL_LOG"

  if [ "$1 $2 $3" = 'run services list' ]; then
    [ "__DOLLAR__{SERVICE_LIST_FAIL:-0}" = 1 ] && return 41
    print_words "__DOLLAR__{SERVICES:-gateway pipeline-orchestrator gw-tenant}"
    return
  fi

  if [ "$1 $2 $3" = 'run services describe' ]; then
    if [[ "$*" == *'status.traffic.revisionName'* ]]; then
      service_traffic "$4"
    else
      service_latest "$4"
    fi
    return
  fi

  if [ "$1 $2 $3" = 'run revisions list' ]; then
    local arg service=''
    for arg in "$@"; do
      case "$arg" in --service=*) service="__DOLLAR__{arg#--service=}" ;; esac
    done
    [ "__DOLLAR__{REVISION_LIST_FAIL:-}" = "$service" ] && return 42
    print_words "$(service_revision_words "$service")"
    return
  fi

  if [ "$1 $2 $3" = 'run revisions delete' ]; then
    local revision="$4"
    [ "__DOLLAR__{DELETE_FAIL:-0}" = 1 ] && return 43
    if [ "__DOLLAR__{DELETE_NOOP:-0}" != 1 ]; then
      case "$revision" in
        gw-*) gateway_revisions="$(remove_word "$gateway_revisions" "$revision")" ;;
        tenant-*) tenant_revisions="$(remove_word "$tenant_revisions" "$revision")" ;;
      esac
    fi
    return
  fi

  echo "unexpected fake gcloud call: $*" >&2
  return 90
}
`.replaceAll('__DOLLAR__', '$');

function runRetention(
  t,
  env = {},
  project = 'test-project',
  region = 'test-region',
  { conditional = false } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-run-retention-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const callLog = path.join(directory, 'calls.log');
  fs.writeFileSync(callLog, '');
  const invocation = conditional
    ? 'if main "$2" "$3"; then exit 0; else exit "$?"; fi'
    : 'main "$2" "$3"';
  const result = spawnSync('bash', [
    '-c',
    `source "$1"\n${FAKE_GCLOUD}\n${invocation}`,
    'revision-retention-test',
    SCRIPT,
    project,
    region,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CALL_LOG: callLog, ...env },
  });
  return { ...result, calls: fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) };
}

test('keeps the newest three revisions for every discovered service', (t) => {
  const result = runRetention(t);
  assert.equal(result.status, 0, result.stderr);

  const deletes = result.calls.filter((call) => call.startsWith('run revisions delete '));
  assert.deepEqual(deletes.map((call) => call.split(' ')[3]), [
    'gw-1', 'gw-2', 'gw-3', 'tenant-1',
  ]);
  for (const call of deletes) {
    assert.match(call, /--project=test-project/);
    assert.match(call, /--region=test-region/);
    assert.match(call, /--quiet/);
    assert.match(call, /--no-async/);
  }

  const lists = result.calls.filter((call) => call.startsWith('run revisions list '));
  assert.equal(lists.length, 6, 'each service must be listed before and after pruning');
  for (const service of ['gateway', 'pipeline-orchestrator', 'gw-tenant']) {
    const serviceLists = lists.filter((call) => call.includes(`--service=${service}`));
    assert.equal(serviceLists.length, 2);
    for (const call of serviceLists) {
      assert.match(call, /--sort-by=~metadata\.creationTimestamp/);
      assert.match(call, /--format=value\(metadata\.name\)/);
    }
  }
  assert.match(result.stdout, /revision retention complete: 3 service\(s\), newest 3 retained/i);
});

test('services with zero through three revisions are left unchanged', (t) => {
  const result = runRetention(t, { SERVICES: 'zero one two three' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.calls.filter((call) => call.startsWith('run revisions delete ')).length,
    0,
  );
  assert.match(result.stdout, /revision retention complete: 4 service\(s\)/i);
});

test('fails before deletion when an older revision is a traffic target', (t) => {
  const result = runRetention(t, {
    SERVICES: 'gateway',
    GATEWAY_TRAFFIC: 'gw-6 gw-1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /older revision gw-1 is latest, receives traffic, or has a traffic tag/);
  assert.equal(result.calls.filter((call) => call.startsWith('run revisions delete ')).length, 0);
});

test('delete and post-prune verification failures are not hidden', async (t) => {
  await t.test('delete failure', () => {
    const result = runRetention(t, { SERVICES: 'gw-tenant', DELETE_FAIL: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to delete tenant-1/);
  });
  await t.test('delete failure from a conditional caller', () => {
    const result = runRetention(
      t,
      { SERVICES: 'gw-tenant', DELETE_FAIL: '1' },
      'test-project',
      'test-region',
      { conditional: true },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to delete tenant-1/);
    assert.doesNotMatch(result.stdout, /revision retention complete/i);
  });
  await t.test('verification failure', () => {
    const result = runRetention(t, { SERVICES: 'gw-tenant', DELETE_NOOP: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /still has 4 revisions; expected at most 3/);
  });
  await t.test('service discovery failure', () => {
    const result = runRetention(t, { SERVICE_LIST_FAIL: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to list Cloud Run services/);
  });
  await t.test('revision discovery failure', () => {
    const result = runRetention(t, { SERVICES: 'gw-tenant', REVISION_LIST_FAIL: 'gw-tenant' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to list revisions.*gw-tenant/);
  });
});

test('all full deployment paths run the shared pruner after apply', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const manual = read('deploy/gcp/deploy.sh');
  const cloudBuild = read('cloudbuild.yaml');
  const bootstrap = read('deploy/gcp/bootstrap.sh');
  const invocation = 'prune-cloud-run-revisions.sh';

  assert.equal((workflow.match(new RegExp(invocation, 'g')) || []).length, 2);
  assert.match(workflow, /infra:.*prune-cloud-run-revisions\.sh/);
  assert.ok(workflow.indexOf('terraform apply -input=false -auto-approve "${apply_args[@]}"') < workflow.lastIndexOf(invocation));
  assert.ok(workflow.lastIndexOf(invocation) < workflow.indexOf('- name: Outputs'));

  assert.equal((manual.match(new RegExp(invocation, 'g')) || []).length, 1);
  assert.ok(manual.indexOf('terraform -chdir="$TF_DIR" apply') < manual.indexOf(invocation));
  assert.ok(manual.indexOf(invocation) < manual.indexOf('log "Done"'));

  assert.equal((cloudBuild.match(new RegExp(invocation, 'g')) || []).length, 1);
  assert.match(cloudBuild, /id: prune-cloud-run-revisions[\s\S]*?waitFor: \[tf-apply\]/);
  assert.match(cloudBuild, /name: gcr\.io\/google\.com\/cloudsdktool\/cloud-sdk:slim[\s\S]*?prune-cloud-run-revisions\.sh/);
  assert.doesNotMatch(bootstrap, /prune-cloud-run-revisions\.sh/);
});

test('retained revisions remain backed by enough Artifact Registry versions', () => {
  const variables = read('deploy/gcp/terraform/variables.tf');
  const block = variables.match(/variable "artifact_retention_count" \{([\s\S]*?)\n\}/);
  assert.ok(block, 'artifact_retention_count variable must exist');
  const defaultValue = block[1].match(/default\s*=\s*(\d+)/);
  assert.ok(defaultValue, 'artifact_retention_count must have a numeric default');
  assert.ok(Number(defaultValue[1]) >= 3, 'image retention must cover all retained revisions');
});
