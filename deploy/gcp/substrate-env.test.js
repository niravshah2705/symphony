'use strict';

// Structural invariants for the substrate environment surface: substrate.tf's env
// maps, the variables behind them, and which workloads receive them.
//
// The failure mode this guards is the quiet one. Every SUBSTRATE_* consumer
// falls back to an inert default when its variable is absent, so a missing or
// misspelled env key never errors — the deployment simply keeps running the
// pattern it already ran, and the operator finds out from a status field that
// says "Substrate is not configured". The same is true of the reverse mistake:
// Terraform setting a name no code reads is invisible forever, and a plan that
// succeeds is not evidence that anything consumed it.
//
// The second half is the boundary that costs more to get wrong: the substrate
// control plane creates, assigns and deletes actors in EVERY tenant's atespace,
// so telling a workload that runs model-generated code where it is turns a
// sandbox escape into an API call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TF = path.join(__dirname, 'terraform');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const tfFile = (name) => fs.readFileSync(path.join(TF, name), 'utf8');

const substrateTf = tfFile('substrate.tf');
const variablesTf = tfFile('variables.tf');
const cloudRunTf = tfFile('cloud_run.tf');
const provisionerTf = tfFile('provisioner.tf');
const orgServiceTf = tfFile('org_service.tf');
const iamTf = tfFile('iam.tf');
const outputsTf = tfFile('outputs.tf');
const deployDoc = read('docs', 'GCP_DEPLOY.md');

// ---------------------------------------------------------------------------
// terraform console, used to check what the HCL actually RENDERS.
//
// Reading substrate.tf proves which names are assigned; it does not prove the
// rendered string is the shape packages/shared-core/src/config.js parses, nor
// that a gate that looks conditional really removes all four actor names
// together. Both were found by rendering rather than by reading, and the class
// (TF setting a name JS cannot use) is invisible to every other check here.
//
// A render needs Terraform installed AND the root init'ed against its real
// backend: `terraform console` refuses to run with `-backend=false`, so this
// skips with the reason on a credential-less CI runner and runs on any operator
// machine that has. A render that ERRORS on a machine where it can run fails
// loudly, because that means the module changed under us.
//
// Each `terraform console` is a fresh process (~5s here), so renders are memoized
// by expression + variables.
// ---------------------------------------------------------------------------

function tfEval(expr, vars = {}) {
  const env = { ...process.env, TF_IN_AUTOMATION: '1' };
  for (const [name, value] of Object.entries(vars)) env[`TF_VAR_${name}`] = String(value);
  return execFileSync('terraform', ['console'], {
    cwd: TF, input: `${expr}\n`, env, timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'],
  })
    .toString()
    .replace(/^Exit code \d+\n/m, '')
    .trim();
}

const RENDER_CACHE = new Map();
function tfRender(expr, vars = {}) {
  const key = `${expr}|${JSON.stringify(vars)}`;
  if (!RENDER_CACHE.has(key)) RENDER_CACHE.set(key, tfEval(expr, vars));
  return RENDER_CACHE.get(key);
}

function tfProbe() {
  try {
    const out = tfEval('1 + 1');
    if (out === '2') return { ok: true };
    return { ok: false, reason: `unexpected output ${JSON.stringify(out)}` };
  } catch (err) {
    const detail = String(err.stderr || err.message || '').split('\n').slice(0, 3).join(' ');
    return { ok: false, reason: detail };
  }
}

const TF_RENDER = tfProbe();

/** `tomap({ "K" = "v" … })` / `tomap({})` → plain object of strings. */
function tfMap(expr, vars = {}) {
  const text = tfRender(expr, vars);
  assert.match(text, /^tomap\(\{[\s\S]*\}\)$/, `expected a map from ${expr}, saw: ${text}`);
  const entries = [...text.matchAll(/^\s*"([^"]+)" = "(.*)"\s*$/gm)];
  return Object.fromEntries(entries.map(([, k, v]) => [k, v]));
}

/** A rendered string value, quotes stripped. */
function tfStr(expr, vars = {}) {
  const text = tfRender(expr, vars);
  assert.match(text, /^".*"$/, `expected a string from ${expr}, saw: ${text}`);
  return text.slice(1, -1);
}

const ACTOR_KEYS = [
  'SUBSTRATE_ACTOR_JWT_AUDIENCE',
  'SUBSTRATE_ACTOR_MODE',
  'SUBSTRATE_JWKS_URL',
  'SUBSTRATE_TRUST_DOMAIN',
];

const ACTOR_VARS = {
  substrate_url: 'substrate-control.example.com:443',
  substrate_atespace: 'tenant-t3f9a1b2c4d5',
  substrate_allowed_atespaces: '["tenant-t3f9a1b2c4d5"]',
  substrate_atespace_by_org: '{"01934abcd":"tenant-t3f9a1b2c4d5"}',
  substrate_actor_mode: 'true',
  substrate_jwks_url: 'https://issuer.example.com/.well-known/jwks.json',
  substrate_actor_member: 'serviceAccount:substrate-actor@demo-project.iam.gserviceaccount.com',
};

/** Every `process.env.SUBSTRATE_*` read in shipped code (tests excluded). */
function envNamesRead() {
  const dirs = [
    path.join(ROOT, 'packages', 'shared-core', 'src'),
    path.join(ROOT, 'packages', 'shared', 'src'),
    path.join(ROOT, 'services', 'planner', 'src'),
    path.join(ROOT, 'services', 'provisioner', 'src'),
    path.join(ROOT, 'services', 'gateway', 'src'),
    path.join(ROOT, 'services', 'coder', 'src'),
  ];
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
        for (const [, name] of read(path.relative(ROOT, full))
          .matchAll(/process\.env\.(SUBSTRATE_[A-Z0-9_]+)/g)) names.add(name);
      }
    }
  };
  for (const dir of dirs) if (fs.existsSync(dir)) walk(dir);
  return names;
}

/** Names the substrate env maps actually assign, comments stripped. */
function envNamesEmitted() {
  const code = substrateTf.replace(/^\s*#.*$/gm, '');
  return new Set([...code.matchAll(/\b(SUBSTRATE_[A-Z0-9_]+)\s*=/g)].map(([, n]) => n));
}

/** The body of a `NAME = merge(...) }` local inside cloud_run.tf's locals block. */
function envLocal(name) {
  const start = cloudRunTf.indexOf(`  ${name} = merge(`);
  assert.notEqual(start, -1, `${name} local not found in cloud_run.tf`);
  const ends = [cloudRunTf.indexOf('\n  )', start), cloudRunTf.indexOf('\n  }', start)]
    .filter((i) => i > -1);
  assert.ok(ends.length, `${name} local does not close`);
  return cloudRunTf.slice(start, Math.min(...ends));
}

/** A `variable "x" { ... }` block body, or null. */
function varBlock(name) {
  const re = new RegExp(`variable "${name}" \\{([\\s\\S]*?)\\n\\}`);
  const m = re.exec(variablesTf);
  return m ? m[1] : null;
}

function varDefault(name) {
  const block = varBlock(name);
  assert.ok(block, `variable "${name}" is not declared in variables.tf`);
  const m = /\n\s*default\s*=\s*(.*)/.exec(`${block}\n`);
  assert.ok(m, `variable "${name}" has no default — every substrate switch must be off by itself`);
  return m[1].trim();
}

test('Terraform emits only SUBSTRATE_* names that shipped code reads', () => {
  const read$ = envNamesRead();
  const emitted = envNamesEmitted();
  assert.ok(read$.size >= 9, `expected the substrate surface to be at least 9 names, saw ${read$.size}`);
  for (const name of emitted) {
    assert.ok(read$.has(name), `${name} is set by substrate.tf but no running code reads process.env.${name}`);
  }
});

test('every substrate setting the code can honor is reachable from Terraform', () => {
  // The other direction, and the one an operator actually hits: a name config.js
  // reads but this root never sets means the value can only be smuggled in as a
  // raw tfvars/secret, i.e. undocumented and invisible in a plan.
  const emitted = envNamesEmitted();
  const unsurfaced = [...envNamesRead()].filter((name) => !emitted.has(name));
  // SUBSTRATE_TOKEN is the ONE accepted gap: a bearer for the control plane is a
  // credential, and a credential inside these maps would be printed by an agent
  // `env` and land on coder-control too. It gets Secret Manager or nothing.
  assert.deepEqual(unsurfaced, ['SUBSTRATE_TOKEN'], 'substrate.tf must surface every non-credential SUBSTRATE_* name');
  assert.match(
    substrateTf,
    /SUBSTRATE_TOKEN[\s\S]{0,400}Secret Manager/,
    'the reason SUBSTRATE_TOKEN stays unwired has to live next to the omission',
  );
});

test('no credential-shaped key is ever emitted into the substrate env maps', () => {
  for (const name of envNamesEmitted()) {
    assert.doesNotMatch(
      name,
      /(TOKEN|SECRET|KEY|PASSWORD)$/,
      `${name} looks like a credential; substrate_env is a plaintext env map that reaches coder-control`,
    );
  }
});

test('substrate env reaches the dispatchers and never the worker', () => {
  const planner = envLocal('planner_env');
  const control = envLocal('coder_control_env');
  assert.ok(planner && control, 'planner_env / coder_control_env locals not found in cloud_run.tf');
  // The planner is the only service with the actor callback endpoint, so only it
  // gets the pair; the others get the control-plane map.
  assert.match(planner, /local\.substrate_env,/);
  assert.match(control, /local\.substrate_control_env,/);
  assert.doesNotMatch(control, /local\.substrate_env,/, 'coder-control does not verify actor JWTs');
  assert.match(
    provisionerTf,
    /local\.substrate_control_env,/,
    'the provisioner answers the atespace step and cannot do it without the address',
  );

  // coder-worker is the container that executes model-generated code. It must
  // not learn where the control plane is.
  const worker = envLocal('coder_worker_env');
  assert.doesNotMatch(worker, /local\.substrate/, 'substrate env reached the container that runs model code');
  assert.match(
    worker,
    /Deliberately NO substrate env/,
    'the omission needs a reason here, or the next person adds the merge line for symmetry',
  );
});

test('the actor callback opens only with an identity allowed to call it', () => {
  const block = /substrate_actor_env = \(([\s\S]*?)\) \? \{([\s\S]*?)\} : \{/.exec(substrateTf);
  assert.ok(block, 'substrate_actor_env must gate BOTH names with one condition');
  const [cond, body] = [block[1], block[2]];
  for (const needed of [
    'local.substrate_enabled',
    'var.substrate_actor_mode',
    'var.substrate_jwks_url',
    'var.substrate_actor_member',
  ]) {
    assert.match(cond, new RegExp(needed.replace(/\./g, '\\.')), `${needed} is part of the gate`);
  }
  const keys = [...body.matchAll(/\b(SUBSTRATE_[A-Z0-9_]+)\s*=/g)].map(([, n]) => n).sort();
  assert.deepEqual(
    keys,
    ['SUBSTRATE_ACTOR_JWT_AUDIENCE', 'SUBSTRATE_ACTOR_MODE', 'SUBSTRATE_JWKS_URL', 'SUBSTRATE_TRUST_DOMAIN'],
    'the actor verification config travels as one unit',
  );
  // Match the endpoint's own predicate, which requires both (a half-pair reads as
  // "enabled" in Terraform and stays shut in the planner).
  assert.match(
    read('services', 'planner', 'src', 'routes', 'substrate-actor.js'),
    /process\.env\.SUBSTRATE_ACTOR_MODE === 'true' && !!process\.env\.SUBSTRATE_JWKS_URL/,
    'the planner no longer opens the endpoint on both names — update the gate here',
  );

  // The receiving half: Cloud Run answers 403 before that route's JWT check ever
  // runs unless the actor identity holds run.invoker on the planner, so an
  // operator who sets the env without the binding gets a dead endpoint and no
  // error. Both switch on the same variable, which is the only thing making the
  // pairing enforceable.
  const invoker = /resource "google_cloud_run_v2_service_iam_member" "substrate_actor_invokes_planner" \{([\s\S]*?)\n\}/.exec(iamTf);
  assert.ok(invoker, 'no run.invoker binding for the substrate actor on the planner');
  assert.match(invoker[1], /trimspace\(var\.substrate_actor_member\) != "" \? 1 : 0/);
  assert.match(invoker[1], /roles\/run\.invoker/);
  assert.match(invoker[1], /google_cloud_run_v2_service\.planner\.name/);
  assert.equal(varDefault('substrate_actor_member'), '""');

  // ...and the member it accepts must be a named workload identity, never an
  // "anyone" principal — the endpoint takes a prompt on behalf of an org.
  const pre = /precondition \{([\s\S]*?)\n    \}/.exec(invoker[1]);
  assert.ok(pre, 'the actor invoker has no precondition on the member shape');
  // HCL strings carry their own escapes (`\.` for a literal dot), so unescape the
  // source the way Terraform would before handing it to RegExp — otherwise every
  // pattern here silently tests for a backslash and the guard checks nothing.
  const accepts = [...pre[1].matchAll(/regex\("([^"]+\$)"[^)]*\)/g)]
    .map(([, source]) => new RegExp(source.replace(/\\\\/g, '\\')));
  assert.equal(accepts.length, 2, 'expected one regex for a service account and one for a principal');
  const allowed = [
    'serviceAccount:substrate-actor@demo-project.iam.gserviceaccount.com',
    'principal://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/ns/substrate/sa/actor',
  ];
  const refused = ['allUsers', 'allAuthenticatedUsers', 'mailto:nobody@example.com', 'domain:example.com'];
  for (const member of allowed) {
    assert.ok(accepts.some((re) => re.test(member)), `the precondition would reject a valid invoker: ${member}`);
  }
  for (const member of refused) {
    assert.ok(
      !accepts.some((re) => re.test(member)),
      `the precondition accepts ${member} — that is a public prompt endpoint on an IAM-gated service`,
    );
  }
});

test('environment_init reaches the org service under the name its settings class reads', () => {
  const py = read('services', 'org', 'app', 'core', 'config.py');
  const field = /(^|\n)\s*(environment_init_enabled)\s*:\s*bool\s*=\s*(\w+)/.exec(py);
  assert.ok(field, 'services/org config.py no longer declares environment_init_enabled as a bool');
  const envName = field[2].toUpperCase();
  assert.equal(envName, 'ENVIRONMENT_INIT_ENABLED');
  // pydantic-settings binds env vars to field names case-insensitively with no
  // prefix; assert that, or the HCL name is a guess that fails silently.
  assert.doesNotMatch(py, /env_prefix/, 'the org settings class gained an env_prefix — the HCL name must follow it');
  assert.match(orgServiceTf, new RegExp(`name\\s*=\\s*"${envName}"`));
  assert.match(
    orgServiceTf,
    new RegExp(`name\\s*=\\s*"${envName}"\\s*\\n\\s*value\\s*=\\s*tostring\\(var\\.environment_init_enabled\\)`),
    'the org service must forward the variable, not a literal',
  );
  assert.equal(varDefault('environment_init_enabled'), 'false', 'a login must not touch infrastructure by default');
  assert.equal(varDefault('provisioner_enabled'), 'false', 'the receiver is its own opt-in, not a side effect');
  // The consumer is the trigger AND the status endpoint; a flag nobody reads is
  // the reason this test exists.
  const svc = read('services', 'org', 'app', 'services', 'environment_service.py');
  assert.match(svc, /settings\(\)\.environment_init_enabled|get_settings\(\)\.environment_init_enabled/);
});

test('an init run has a topic and an answer, without buying run.admin', () => {
  // tenant_jobs_on is the existence gate; provisioning_on is the privilege gate.
  // Collapsing them would let "initialize my environment at login" quietly grant
  // project-wide run.admin + act-as on the runtime identities.
  assert.match(
    provisionerTf,
    /tenant_jobs_on = anytrue\(\[\s*var\.provisioning_enabled,\s*var\.provisioner_enabled,\s*var\.environment_init_enabled,\s*\]\)/,
    'the topic + provisioner must exist for an explicit receiver or for init, and provisioning implies both',
  );
  const privileged = ['provisioner_run_admin', 'provisioner_pubsub_admin', 'provisioner_scheduler_admin', 'provisioner_actas'];
  for (const name of privileged) {
    const block = new RegExp(`resource "[a-z_]+" "${name}" \\{([\\s\\S]*?)\\n\\}`).exec(provisionerTf);
    assert.ok(block, `${name} not found`);
    assert.match(block[1], /local\.provisioning_on/, `${name} is granted by the init flag — it is not a substrate privilege`);
  }
  for (const name of ['google_pubsub_topic" "tenant_provision', 'google_cloud_run_v2_service" "provisioner']) {
    const re = new RegExp(`resource "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    assert.match(provisionerTf, re);
  }

  // The other half of the split: the RECEIVER has to exist for init, or the
  // message has nowhere to go and the step parks in RUNNING. Reading only the
  // privilege side (above) would leave a root that grants nothing and answers
  // nothing, which is indistinguishable from the flag being off.
  for (const name of [
    'google_service_account" "provisioner',
    'google_pubsub_topic" "tenant_provision',
    'google_pubsub_subscription" "tenant_provision_push',
    'google_cloud_run_v2_service" "provisioner',
    'google_cloud_run_v2_service_iam_member" "push_invokes_provisioner',
  ]) {
    const block = new RegExp(`resource "${name}\\S* \\{([\\s\\S]*?)\\n\\}`).exec(provisionerTf);
    assert.ok(block, `${name} not found`);
    assert.match(
      block[1],
      /local\.tenant_jobs_on/,
      `${name} is not gated on the existence local, so an init-only deployment has no receiver`,
    );
  }

  // Nothing in the code path publishes without this grant: a publish on ADC with
  // no publisher role is a Permission denied that the plan never mentions.
  const grant = /resource "google_pubsub_topic_iam_member" "org_publish_tenant_provision" \{([\s\S]*?)\n\}/.exec(provisionerTf);
  assert.ok(grant, 'the org service has no publisher grant on the provisioning topic');
  assert.match(grant[1], /google_service_account\.org\.email/);
  assert.match(grant[1], /roles\/pubsub\.publisher/);
  assert.match(
    grant[1],
    /google_pubsub_topic\.tenant_provision\[0\]\.name/,
    'grant must be topic-scoped; a project-wide publisher would be an escalation',
  );

  // And the container switch stays separate from the infra switch: the handler
  // answers substrate-atespace with PROVISIONING_ENABLED=false (see
  // services/provisioner/src/index.js), so hardcoding "true" here would make an
  // init-only deployment able to create tenant stacks.
  assert.match(
    provisionerTf,
    /PROVISIONING_ENABLED\s*=\s*tostring\(var\.provisioning_enabled\)/,
    'provisioner env must forward the variable rather than assert its own existence',
  );
});

test('the rendered substrate map is the shape the JS side parses', (t) => {
  if (!TF_RENDER.ok) return t.skip(`terraform console unavailable: ${TF_RENDER.reason}`);
  // Nothing set: the pattern is inert, which is the state a default apply ships.
  assert.deepEqual(tfMap('local.substrate_env'), {});

  const full = tfMap('local.substrate_env', ACTOR_VARS);
  assert.equal(full.SUBSTRATE_URL, ACTOR_VARS.substrate_url);
  assert.equal(full.SUBSTRATE_ATESPACE, 'tenant-t3f9a1b2c4d5');
  // The two composite keys must arrive as the ONE string each parser splits.
  assert.equal(full.SUBSTRATE_ALLOWED_ATESPACES, 'tenant-t3f9a1b2c4d5');
  assert.equal(full.SUBSTRATE_ATESPACE_BY_ORG, '01934abcd=tenant-t3f9a1b2c4d5');
  // Numbers cross the wire as strings; a `60000` rendered unquoted would make
  // the env map a type error at apply time, not here.
  assert.match(full.SUBSTRATE_TIMEOUT_MS, /^\d+$/);
  assert.match(full.SUBSTRATE_ACTOR_TTL_MS, /^\d+$/);
  assert.equal(full.SUBSTRATE_WORKER_POOL, 'planner-pool');

  // Unset optional keys stay absent rather than arriving as "", which is the
  // half a reading review cannot see: an empty SUBSTRATE_ATESPACE would win over
  // the per-org settings value substrate.js consults first. Structural check
  // lives in "the substrate surface is dark…"; this one renders it.
  const noSpaces = tfMap('local.substrate_env', {
    substrate_url: ACTOR_VARS.substrate_url,
    substrate_actor_mode: 'false',
  });
  assert.equal(noSpaces.SUBSTRATE_URL, ACTOR_VARS.substrate_url);
  for (const key of ['SUBSTRATE_ATESPACE', 'SUBSTRATE_ALLOWED_ATESPACES', 'SUBSTRATE_ATESPACE_BY_ORG']) {
    assert.ok(!(key in noSpaces), `${key} was emitted empty; config.js reads "" over the org's settings value`);
  }

  // The map `for` iterates in sorted key order, which is what keeps the rendered
  // binding string byte-stable between applies instead of reshuffling each plan.
  assert.equal(
    tfStr('local.substrate_atespace_by_org', { substrate_atespace_by_org: '{"z-org":"tenant-t9","a-org":"tenant-t1"}' }),
    'a-org=tenant-t1,z-org=tenant-t9',
  );
});

test('the actor callback renders as four names or none, never a half-pair', (t) => {
  if (!TF_RENDER.ok) return t.skip(`terraform console unavailable: ${TF_RENDER.reason}`);
  const on = tfMap('local.substrate_env', ACTOR_VARS);
  assert.deepEqual(ACTOR_KEYS.filter((k) => k in on).sort(), [...ACTOR_KEYS].sort());

  // The gate has four conditions and the one an operator is most likely to
  // forget is the IAM member that may call at all — test #5 proves all four are
  // in the expression, and the dark render above shows the URL half, so this
  // only has to show the group is atomic.
  const rendered = tfMap('local.substrate_env', { ...ACTOR_VARS, substrate_actor_member: '' });
  for (const key of ACTOR_KEYS) {
    assert.ok(!(key in rendered), `no invoker named: ${key} is set while the callback cannot work`);
  }

  // A credential must never appear in the rendered map, whatever is configured.
  for (const key of Object.keys(on)) {
    assert.doesNotMatch(key, /(TOKEN|SECRET|KEY|PASSWORD)$/, `${key} is a credential in a plaintext env map`);
  }
});

test('the substrate surface is dark until an operator names a control plane', () => {
  assert.equal(varDefault('substrate_url'), '""');
  assert.equal(varDefault('substrate_atespace'), '""');
  assert.equal(varDefault('substrate_ingress_url'), '""');
  assert.equal(varDefault('substrate_planner_image'), '""');
  assert.equal(varDefault('substrate_jwks_url'), '""');
  assert.equal(varDefault('substrate_actor_mode'), 'false');
  assert.equal(varDefault('substrate_actor_member'), '""', 'an unnamed invoker means no callback and no binding');
  // Fail-closed by default, and the empty list is the security property:
  // resolveSubstrateAtespace honors a request-supplied name only from this list.
  assert.equal(varDefault('substrate_allowed_atespaces'), '[]');
  assert.equal(varDefault('substrate_atespace_by_org'), '{}');

  assert.match(
    substrateTf,
    /substrate_enabled = trimspace\(var\.substrate_url\) != ""/,
    'substrate_url is the switch; anything else lets a half-configured deployment resolve a space it cannot dial',
  );
  // The keys the JS side parses out of ONE string must arrive as that string.
  assert.match(substrateTf, /substrate_allowed_atespaces = join\(",", var\.substrate_allowed_atespaces\)/);
  assert.match(substrateTf, /for org, space in var\.substrate_atespace_by_org : "\$\{org\}=\$\{space\}"/);
  const cfg = read('packages', 'shared-core', 'src', 'config.js');
  assert.match(
    cfg,
    /SUBSTRATE_ALLOWED_ATESPACES \|\| ''\)[\s\S]{0,120}split\(','\)/,
    'allowedAtespaces no longer parses a comma-separated list',
  );
  assert.match(
    read('packages', 'shared-core', 'src', 'config.js'),
    /parseOrgAtespaces[\s\S]{0,300}pair\.split\('='\)/,
    'atespaceByOrg no longer parses org=space pairs',
  );

  // Unset optional keys stay ABSENT: an empty string here would override the
  // per-org settings value that substrate.js reads before the env default.
  assert.match(
    substrateTf,
    /trimspace\(var\.substrate_atespace\) != "" \? \{ SUBSTRATE_ATESPACE/,
    'SUBSTRATE_ATESPACE must not be emitted empty',
  );
});

test('the plan-facing outputs and the operator doc name the gates that exist', () => {
  // outputs.tf and docs/GCP_DEPLOY.md are what an operator reads after an apply,
  // and every one of these claims was wrong at least once while this root was
  // being written. An output reporting a local that no longer exists fails at
  // plan; one reporting a stale field means the doc and the output disagree
  // about what `receiver_exists` is a proxy for.
  const init = /output "environment_init" \{([\s\S]*?)\n\}/.exec(outputsTf);
  assert.ok(init, 'no environment_init output');
  for (const field of ['receiver_exists', 'org_can_publish']) {
    assert.match(init[1], new RegExp(`${field}\\s*=\\s*local\\.tenant_jobs_on`));
  }
  // The privilege half must name the NARROWER local, or the output documents the
  // exact escalation this split exists to prevent.
  assert.match(init[1], /stack_roles_granted\s*=\s*local\.provisioning_on/);

  const subs = /output "substrate" \{([\s\S]*?)\n\}/.exec(outputsTf);
  assert.ok(subs, 'no substrate output');
  assert.match(subs[1], /actor_endpoint\s*=\s*length\(local\.substrate_actor_env\) > 0/);
  assert.match(subs[1], /actor_invoker\s*=\s*var\.substrate_actor_member/);

  // The doc is where the "why" lives, so it has to name the switches and the
  // three-flag shape of the split, not the two-flag version it started with.
  for (const claim of [
    'provisioner_enabled',
    'substrate_actor_member',
    'anytrue\\(\\[provisioning_enabled, provisioner_enabled, environment_init_enabled\\]\\)',
    'roles/run\\.admin',
    'run\\.invoker',
  ]) {
    assert.match(deployDoc, new RegExp(claim), `docs/GCP_DEPLOY.md no longer explains ${claim}`);
  }
  assert.doesNotMatch(
    deployDoc,
    /tenant_jobs_on = provisioning_enabled \|\| environment_init_enabled/,
    'the doc still describes the two-flag gate this replaced',
  );
});

test('atespace names Terraform accepts are names the app will not silently drop', () => {
  // parseOrgAtespaces skips anything failing its slug regex, and the Python
  // mirror asserts the same shape; a name that only one of them accepts is a
  // binding that refuses at run time with no trace of the typo.
  const slugLiteral = '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$';
  // substrate_atespace, substrate_worker_pool, the list entries and the map values.
  assert.equal(
    variablesTf.split(slugLiteral).length - 1,
    4,
    'every atespace-shaped variable needs the slug validation',
  );
  const js = read('packages', 'shared-core', 'src', 'config.js');
  assert.match(js, /\.test\(space\)/, 'parseOrgAtespaces changed its validation — mirror it here');

  // The name the init job actually writes is `tenant-<slug>`, derived in Python
  // from the deployment slug. Feed THAT through the regex this root validates
  // with: if the two ever disagree, a binding Terraform accepts is one the app
  // drops, and the org then refuses its own runs.
  const py = read('services', 'org', 'app', 'services', 'environment_service.py');
  const formula = /return f"tenant-\{slug\}"/.exec(py);
  assert.ok(formula, 'atespace_for_slug no longer returns tenant-<slug>');
  // An org key carrying a separator would split its own pair on the way in, and
  // parseOrgAtespaces drops the result instead of complaining.
  assert.match(
    varBlock('substrate_atespace_by_org'),
    /regex\("\^\[\^,=\]\+\$"/,
    'substrate_atespace_by_org accepts an org key containing = or , and the pair string would not survive it',
  );
  const derived = 'tenant-t3f9a1b2c4d5';
  for (const name of ['substrate_atespace', 'substrate_worker_pool', 'substrate_allowed_atespaces', 'substrate_atespace_by_org']) {
    // The slug guard specifically: a map variable may carry other can(regex(..))
    // checks (the org key rejects separators), and the one that matters here is
    // the one that has to accept the name the init job writes.
    const guard = /can\(regex\("(\^\[a-z0-9\][^"]*)", /.exec(varBlock(name));
    assert.ok(guard, `${name} declares no slug validation`);
    assert.ok(
      new RegExp(guard[1]).test(derived),
      `${name}'s validation regex ${guard[1]} would reject ${derived}, the atespace the init job writes`,
    );
  }
});

test('the worker pool name the planner selects is one string in four places', () => {
  // What workerSelector matches is the NAME of the WorkerPool: ate-controller
  // stamps `ate.dev/worker-pool=<WorkerPool name>` onto the pool's worker pods,
  // and the ate API compares the selector against those pod-derived labels. Node
  // labels play no part in placement — the substrate.tf label is a copy of the
  // same string, kept so the pool is recognizable in `kubectl get nodes`. So the
  // Terraform variable, the two JS defaults and the install workflow's default
  // all have to agree, or the planner selects a pool that does not exist and
  // every actor sits Pending naming no reason a human would guess. That failure
  // is invisible in a plan: the pool is created, nothing errors.
  const gke = read('deploy', 'gcp', 'terraform-substrate-gke', 'substrate.tf');
  const gkeVars = read('deploy', 'gcp', 'terraform-substrate-gke', 'variables.tf');
  const pool = /resource "google_container_node_pool" "substrate_nodes" \{[\s\S]*?\n\}/.exec(gke);
  assert.ok(pool, 'the substrate worker pool block moved');
  assert.match(pool[0], /taint/, 'the worker pool is no longer tainted — the isolation the label complements');
  assert.match(
    pool[0],
    /"ate\.dev\/worker-pool" = var\.substrate_worker_pool_label/,
    'the worker pool no longer carries the label, so the pool name is untraceable from a node',
  );

  // Three defaults in three languages have to be the ONE string the planner
  // sends: this variable, the JS fallback, and the config.js default.
  const tfDefault = /variable "substrate_worker_pool_label" \{[\s\S]*?default\s*=\s*"([^"]+)"/.exec(gkeVars);
  assert.ok(tfDefault, 'substrate_worker_pool_label has no default');
  const jsDefault = varDefault('substrate_worker_pool');
  assert.equal(`"${tfDefault[1]}"`, jsDefault.trim(),
    'the node label and var.substrate_worker_pool disagree — a pool nothing selects');
  assert.match(
    read('packages', 'shared-core', 'src', 'agent', 'substrate.js'),
    new RegExp(`DEFAULT_WORKER_POOL = '${tfDefault[1]}'`),
    'substrate.js DEFAULT_WORKER_POOL no longer matches the node label',
  );
  assert.match(
    read('packages', 'shared-core', 'src', 'config.js'),
    new RegExp(`SUBSTRATE_WORKER_POOL \\|\\| '${tfDefault[1]}'`),
    'config.js SUBSTRATE_WORKER_POOL fallback no longer matches the node label',
  );

  // The fifth place is the workflow that CREATES the object: a pool named here
  // but not there is the same bug wearing a different hat.
  const wf = read('.github', 'workflows', 'substrate-control-plane.yml');
  assert.match(
    wf,
    new RegExp(`SUBSTRATE_WORKER_POOL: \\\$\\{\\{ vars\\.SUBSTRATE_WORKER_POOL \\|\\| '${tfDefault[1]}' \\}\\}`),
    'the install workflow defaults the WorkerPool name to something the planner will not select',
  );
});

test('the worker pool is tainted with the key atelet tolerates', () => {
  // A node pool reserved for one sandbox class is tainted
  // `ate.dev/sandboxClass=<class>:NoSchedule` — that is the contract, not our
  // invention: the atelet DaemonSet tolerates the key for any value, and
  // ate-controller adds the class's own toleration to every worker pod. Taint
  // the pool with any other key and BOTH are repelled, so the node hosts neither
  // atelet nor workers and no sandbox can ever be created on it — while every
  // pod merely sits Pending. The first substrate cluster shipped exactly that
  // taint (`substrate.ate.dev/workers=true`), which is why this is a test.
  const gke = read('deploy', 'gcp', 'terraform-substrate-gke', 'substrate.tf');
  const taint = /substrate_taint = \{([\s\S]*?)\n  \}/.exec(gke);
  assert.ok(taint, 'local.substrate_taint moved out of substrate.tf');
  assert.match(taint[1], /key\s*=\s*"ate\.dev\/sandboxClass"/,
    'the worker pool taint is no longer the sandboxClass key, so atelet cannot run on it');
  assert.match(taint[1], /value\s*=\s*"gvisor"/,
    'the sandboxClass taint value must name the class the pool runs (gvisor, per sandboxRuntime)');
  assert.doesNotMatch(taint[1], /substrate\.ate\.dev\/workers/,
    'the private taint key is back — nothing tolerates it, so no sandbox is placeable');

  // The WorkerPool the install workflow creates must not re-spell a toleration
  // for the same key: the controller adds it, and a second copy is a drift risk.
  const wf = read('.github', 'workflows', 'substrate-control-plane.yml');
  const step = /- name: Create the WorkerPool\n([\s\S]*?)\n      - name: /.exec(wf);
  assert.ok(step, 'the install workflow no longer creates a WorkerPool — nothing serves actors');
  assert.doesNotMatch(step[1], /^\s*tolerations:/m,
    'the WorkerPool hand-writes a toleration the controller already adds for the sandbox class');
});

test('the worker pool boots on its own disk and inside the regional SSD quota', () => {
  // Actor snapshots stage on the worker BOOT disk (/var/lib/ate/snapshots), so
  // the pool cannot share the generic node-disk variables: at 50 GB pd-standard
  // a resume fails on a full disk rather than evicting a pod. And because
  // pd-balanced bills against the same regional SSD_TOTAL_GB quota as the
  // bundled postgres claim, max_nodes x disk_size is a quota statement, not a
  // sizing preference — 6 x 100 GB overran the 500 GB limit and starved the
  // postgres claim next to it.
  const gke = read('deploy', 'gcp', 'terraform-substrate-gke', 'substrate.tf');
  const from = gke.indexOf('resource "google_container_node_pool" "substrate_nodes"');
  assert.ok(from >= 0, 'the substrate worker node pool moved out of substrate.tf');
  const next = gke.indexOf('resource "', from + 10);
  const pool = gke.slice(from, next === -1 ? undefined : next);
  assert.match(pool, /disk_size_gb\s*=\s*var\.substrate_worker_disk_size_gb/,
    'the worker pool borrowed the shared disk size again — snapshots need their own');
  assert.match(pool, /disk_type\s*=\s*var\.substrate_worker_disk_type/,
    'the worker pool borrowed the shared disk type again');
  assert.doesNotMatch(pool, /disk_size_gb\s*=\s*var\.disk_size_gb/,
    'worker boot disks are sized by var.disk_size_gb, which every other pool shares');
  assert.match(pool, /image_type\s*=\s*"COS_CONTAINERD"/,
    'the docs require COS_CONTAINERD on worker nodes (ComputeClass + the snapshot sysctls)');

  const tfvars = read('deploy', 'gcp', 'terraform-substrate-gke', 'variables.tf');
  const declared = (name) => {
    const m = new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s*=\\s*"?([^"\\n]+)"?\\s*\\n\\}`)
      .exec(tfvars);
    assert.ok(m, `variable "${name}" no longer declares a default`);
    return m[1].trim();
  };
  assert.equal(declared('substrate_machine_type'), 'n4-standard-4',
    'worker nodes moved back onto a mixed-CPU-architecture series (E2), which the substrate docs exclude');
  const maxNodes = Number(declared('substrate_max_nodes'));
  const diskGb = Number(declared('substrate_worker_disk_size_gb'));
  assert.ok(maxNodes * diskGb <= 450,
    `substrate_max_nodes x substrate_worker_disk_size_gb = ${maxNodes * diskGb} GB, ` +
    'over the SSD_TOTAL_GB (500) the regional quota allows once postgres holds its claim');

  const example = read('deploy', 'gcp', 'terraform-substrate-gke', 'terraform.tfvars.example');
  for (const [name, value] of [
    ['substrate_machine_type', 'n4-standard-4'],
    ['substrate_max_nodes', String(maxNodes)],
    ['substrate_worker_disk_size_gb', String(diskGb)],
  ]) {
    assert.ok(new RegExp(`^${name}\\s*=\\s*"?${value}"?\\s*$`, 'm').test(example),
      `terraform.tfvars.example still advertises a different ${name} than the module default`);
  }
});

test('rewriting the postgres claim also re-migrates the database', () => {
  // ate-api-server applies migrations ONLY at startup, so a claim the install
  // deletes and re-provisions leaves a RUNNING control plane on an EMPTY schema:
  // every pod Ready, every query failing with `relation "workers" does not
  // exist`, workers never acquiring an epoch, WorkerPool stuck at 0 ready
  // replicas. It cost a full install run to find; the rewrite and the restart
  // are one change, so the workflow must not contain just the first half.
  const wf = read('.github', 'workflows', 'substrate-control-plane.yml');
  const step = /- name: Set the bundled Postgres volume size\n([\s\S]*?)\n      - /.exec(wf);
  assert.ok(step, 'the Postgres volume-size step moved out of the install job');
  const deletes = /delete pvc data-postgres-0/.test(step[1]);
  if (!deletes) {
    assert.doesNotMatch(wf, /rollout restart deploy ate-api-server/,
      'the install restarts ate-api-server for no reason — it no longer deletes the claim');
    return;
  }
  assert.match(step[1], /recreated=true" >> "\$GITHUB_OUTPUT/,
    'the claim delete no longer reports itself, so the migration step can be skipped silently');
  const restart = /- name: Re-migrate the recreated database\n([\s\S]*?)\n      - name: /.exec(wf);
  assert.ok(restart,
    'the install deletes data-postgres-0 but never restarts ate-api-server — the schema stays missing and no worker ever registers');
  assert.match(restart[1], /steps\.pgsize\.outputs\.recreated == 'true'/,
    'the re-migration step must run exactly when the claim was recreated, not on every install');
  assert.match(restart[1], /rollout restart deploy ate-api-server/,
    'the re-migration step does not restart the only component that applies migrations');
  assert.match(restart[1], /rollout status deploy ate-api-server/,
    'the step must wait for the restarted replicas, or the WorkerPool check below races the rollout');
});
