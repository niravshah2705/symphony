'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TF = path.join(ROOT, 'deploy', 'gcp', 'terraform');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const readTf = (name) => fs.readFileSync(path.join(TF, name), 'utf8');

const jobTf = readTf('billing_job.tf');
const serviceTf = readTf('billing_service.tf');
const variablesTf = readTf('variables.tf');
const workflow = read('.github', 'workflows', 'deploy.yml');

function block(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  const next = source.slice(start + 1).search(/\n(resource|variable|locals|moved|output|data) /);
  return source.slice(start, next === -1 ? source.length : start + 1 + next);
}

// Extract `key = { ... }` with balanced braces from the billing_jobs local.
function jobEntry(key) {
  const locals = block(jobTf, 'locals {');
  const start = locals.search(new RegExp(`\\n\\s+${key} = \\{`));
  assert.notEqual(start, -1, `missing billing job ${key}`);
  let depth = 0;
  for (let i = locals.indexOf('{', start); i < locals.length; i += 1) {
    if (locals[i] === '{') depth += 1;
    if (locals[i] === '}') depth -= 1;
    if (depth === 0) return locals.slice(start, i + 1);
  }
  throw new Error(`unterminated job ${key}`);
}

function validationRegex(name) {
  const v = block(variablesTf, `variable "${name}"`);
  const m = v.match(/regex\("((?:[^"\\]|\\.)*)",/);
  assert.ok(m, `${name} has no regex validation`);
  return new RegExp(m[1].replace(/\\\\/g, '\\'));
}

const JOBS = {
  recharge: 'services/billing/src/auto-recharge-job.js',
  'platform-charge': 'services/billing/src/platform-charge-job.js',
  'credit-expiry': 'services/billing/src/credit-expiry-job.js',
  reconcile: 'services/billing/src/reconcile-gateway-spend.js',
};

test('every billing Job overrides the image CMD with an entrypoint that exists', () => {
  const job = block(jobTf, 'resource "google_cloud_run_v2_job" "billing"');
  assert.match(job, /for_each\s*=\s*local\.billing_jobs/);
  assert.match(job, /command\s*=\s*\["node"\]/);
  assert.match(job, /args\s*=\s*\[each\.value\.script\]/);
  assert.match(job, /task_count\s*=\s*1/);
  assert.match(job, /max_retries\s*=\s*1/);
  for (const [key, script] of Object.entries(JOBS)) {
    assert.match(jobEntry(key), new RegExp(`script\\s*=\\s*"${script.replace(/[.]/g, '\\.')}"`));
    assert.ok(fs.existsSync(path.join(ROOT, script)), `${script} does not exist`);
  }
});

test('the existing recharge Job and scheduler are moved, not replaced', () => {
  assert.match(jobTf, /from\s*=\s*google_cloud_run_v2_job\.billing_auto_recharge\s+to\s*=\s*google_cloud_run_v2_job\.billing\["recharge"\]/);
  assert.match(jobTf, /from\s*=\s*google_cloud_scheduler_job\.billing_auto_recharge\s+to\s*=\s*google_cloud_scheduler_job\.billing_job\["recharge"\]/);
  assert.match(jobEntry('recharge'), /name\s*=\s*var\.billing_job_name\b/);
});

test('FlexPrice keys are readable by billing-sa only and never reach an agent service', () => {
  const accessor = block(serviceTf, 'resource "google_secret_manager_secret_iam_member" "billing_flexprice_accessor"');
  assert.match(accessor, /member\s*=\s*"serviceAccount:\$\{google_service_account\.billing\.email\}"/);
  assert.match(serviceTf, /"flexprice-api-key-ingest"/);
  assert.match(serviceTf, /"flexprice-api-key-money"/);
  assert.doesNotMatch(serviceTf, /google_secret_manager_secret_version"\s+"flexprice/, 'secret values must not be in Terraform');

  const accessorRefs = fs.readdirSync(TF).filter((f) => f.endsWith('.tf'))
    .flatMap((f) => (readTf(f).match(/secret_id\s*=\s*google_secret_manager_secret\.flexprice\b[^\n]*/g) || []).map(() => f));
  assert.deepEqual([...new Set(accessorRefs)], [], 'no secret_id = google_secret_manager_secret.flexprice... outside the for_each accessor');

  for (const f of fs.readdirSync(TF).filter((n) => n.endsWith('.tf'))) {
    if (f === 'billing_service.tf' || f === 'billing_job.tf') continue;
    const src = readTf(f);
    assert.doesNotMatch(src, /FLEXPRICE_API_KEY_/, `${f} references a FlexPrice key`);
    assert.doesNotMatch(src, /billing_flexprice_secrets|google_secret_manager_secret\.flexprice/, `${f} references FlexPrice secrets`);
  }

  const svc = block(serviceTf, 'resource "google_cloud_run_v2_service" "billing"');
  assert.match(svc, /local\.billing_flexprice_env/);
  assert.match(svc, /for_each\s*=\s*local\.billing_flexprice_secrets/);
  assert.doesNotMatch(svc, /BILLING_JOB_NAME/);
});

test('FlexPrice env uses the names the code reads, and production posture', () => {
  const locals = block(serviceTf, 'locals {');
  const cfg = read('packages', 'shared-core', 'src', 'billing', 'flexprice-config.js');
  for (const name of ['FLEXPRICE_ENABLED', 'FLEXPRICE_BASE_URL', 'FLEXPRICE_ENVIRONMENT_ID',
    'FLEXPRICE_SUPPLIER_STATE_CODE', 'FLEXPRICE_DEPLOYMENT_MODE', 'FLEXPRICE_ALLOW_INSECURE_DEFAULTS',
    'FLEXPRICE_API_KEY_INGEST', 'FLEXPRICE_API_KEY_MONEY']) {
    assert.match(locals, new RegExp(`\\b${name}\\b`));
    assert.match(cfg, new RegExp(`\\b${name}\\b`), `code does not read ${name}`);
  }
  assert.match(locals, /FLEXPRICE_DEPLOYMENT_MODE\s*=\s*"production"/);
  assert.match(locals, /FLEXPRICE_ALLOW_INSECURE_DEFAULTS\s*=\s*"false"/);
  assert.match(locals, /BILLING_GATE_POLICY\s*=\s*"enforced"/);
  assert.doesNotMatch(locals, /FLEXPRICE_TEMPORAL_ADDR/);
});

test('Cashfree secrets go to the recharge Job only; internal token to recharge and reconcile', () => {
  assert.match(jobEntry('recharge'), /cashfree\s*=\s*true/);
  for (const key of ['platform-charge', 'credit-expiry', 'reconcile']) {
    assert.match(jobEntry(key), /cashfree\s*=\s*false/, `${key} must not get Cashfree secrets`);
  }
  for (const key of ['recharge', 'reconcile']) assert.match(jobEntry(key), /internal\s*=\s*true/);
  for (const key of ['platform-charge', 'credit-expiry']) assert.match(jobEntry(key), /internal\s*=\s*false/);
  const job = block(jobTf, 'resource "google_cloud_run_v2_job" "billing"');
  assert.match(job, /each\.value\.cashfree \? local\.billing_job_cashfree_secrets : \{\}/);
  assert.match(jobEntry('reconcile'), /SETTINGS_URL\s*=\s*local\.settings_url/);
  assert.match(jobEntry('reconcile'), /LITELLM_URL\s*=\s*local\.litellm_url/);
});

test('schedulers call jobs/<name>:run with an OAuth token from a run.invoker-only SA', () => {
  const sched = block(jobTf, 'resource "google_cloud_scheduler_job" "billing_job"');
  assert.match(sched, /uri\s*=\s*"https:\/\/run\.googleapis\.com\/v2\/projects\/\$\{var\.project_id\}\/locations\/\$\{var\.region\}\/jobs\/\$\{[^}]+\}:run"/);
  assert.match(sched, /http_method\s*=\s*"POST"/);
  assert.match(sched, /oauth_token\s*\{[^}]*service_account_email\s*=\s*google_service_account\.billing_scheduler\.email/);
  assert.match(sched, /scope\s*=\s*"https:\/\/www\.googleapis\.com\/auth\/cloud-platform"/);
  assert.doesNotMatch(sched, /oidc_token/);

  assert.match(jobTf, /account_id\s*=\s*"billing-scheduler-sa"/);
  const tfAll = fs.readdirSync(TF).filter((f) => f.endsWith('.tf')).map(readTf).join('\n');
  const grants = tfAll.split(/\nresource /).filter((r) => r.includes('google_service_account.billing_scheduler.email') && /role\s*=/.test(r));
  assert.ok(grants.length > 0);
  for (const g of grants) assert.match(g, /role\s*=\s*"roles\/run\.invoker"/);
});

test('the service-launched recharge path is gone', () => {
  const tfAll = fs.readdirSync(TF).filter((f) => f.endsWith('.tf')).map(readTf).join('\n');
  assert.doesNotMatch(tfAll, /roles\/run\.developer"[\s\S]{0,200}google_service_account\.billing\.email/);
  assert.doesNotMatch(tfAll, /billing_actas_self|billing_launches_recharge_job/);
  assert.doesNotMatch(tfAll, /billing-recharge-tick/);
  assert.doesNotMatch(read('services', 'billing', 'src', 'app.js'), /billing-recharge-tick|recharge-trigger/);
});

test('variable validations accept and reject the expected values', () => {
  const url = validationRegex('flexprice_base_url');
  assert.ok(url.test('https://flexprice.example.com'));
  assert.ok(!url.test('http://flexprice.example.com'));
  assert.ok(!url.test(''));

  const uuid = validationRegex('flexprice_environment_id');
  assert.ok(uuid.test('3f2b6c1e-9a4d-4c2b-8e1f-0a1b2c3d4e5f'));
  assert.ok(!uuid.test('not-a-uuid'));
  assert.ok(!uuid.test(''));

  const state = validationRegex('flexprice_supplier_state_code');
  for (const ok of ['01', '09', '10', '29', '37']) assert.ok(state.test(ok), ok);
  for (const bad of ['00', '38', '1', '99', '']) assert.ok(!state.test(bad), bad);

  assert.match(block(variablesTf, 'variable "flexprice_enabled"'), /default\s*=\s*true/);
  assert.match(block(variablesTf, 'variable "billing_platform_charge_schedule"'), /default\s*=\s*"0 2 1 \* \*"/);
  assert.match(block(variablesTf, 'variable "billing_credit_expiry_schedule"'), /default\s*=\s*"15 \* \* \* \*"/);
  assert.match(block(variablesTf, 'variable "billing_reconcile_schedule"'), /default\s*=\s*"30 3 \* \* \*"/);
});

test('the deploy workflow validates, plans to a file, applies that plan, and never reads FlexPrice values', () => {
  assert.match(workflow, /terraform fmt -check/);
  assert.match(workflow, /terraform validate/);
  assert.match(workflow, /terraform plan [^\n]*-out=primary\.tfplan/);
  assert.match(workflow, /terraform apply -input=false primary\.tfplan/);
  assert.doesNotMatch(workflow, /terraform apply -input=false -auto-approve "\$\{apply_args\[@\]\}"/);

  const step = workflow.slice(workflow.indexOf('- name: Verify FlexPrice secret versions'));
  const body = step.slice(0, step.indexOf('\n      - name:', 1));
  assert.match(body, /gcloud secrets versions list/);
  assert.match(body, /--filter=state:enabled --limit=1/);
  assert.doesNotMatch(body, /versions access/);
  assert.doesNotMatch(workflow, /versions access[^\n]*flexprice/);

  for (const v of ['FLEXPRICE_BASE_URL', 'FLEXPRICE_ENVIRONMENT_ID', 'FLEXPRICE_SUPPLIER_STATE_CODE']) {
    assert.match(workflow, new RegExp(`vars\\.${v}\\b`));
  }
});
