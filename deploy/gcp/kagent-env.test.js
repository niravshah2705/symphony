'use strict';

// Structural invariants for the kagent environment surface: kagent.tf's env map,
// the variables behind it, which workloads receive it, and the code that actually
// reads the names.
//
// This mirrors deploy/gcp/substrate-env.test.js deliberately. The failure mode is
// the same quiet one: every KAGENT_* consumer
// (packages/shared-core/src/config.js KAGENT, agent/kagent.js) falls back to an
// inert default when its variable is absent, so a root that forgets to render the
// map does not fail — publish keeps answering 503 kagent_not_configured and the
// capabilities list stays empty, which looks exactly like "this deployment does
// not use kagent" to whoever is reading it.
//
// kagent adds a second class the substrate surface never had, which is why this
// file exists rather than a few more lines in that one: the adapter has THREE
// links that must all be present for an address to mean anything — the env map,
// CONFIG.KAGENT, and the gateway passing the adapter into the router. services/
// gateway/src/index.js called createWorkflowsRouter() with no adapter for a whole
// stage of this work, so a perfectly rendered KAGENT_API_URL was read by nothing
// and every publish was a 503 no plan could explain. The "the names are wired to
// a consumer" test below is what keeps that seam from going dark again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TF = path.join(__dirname, 'terraform');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const tfFile = (name) => fs.readFileSync(path.join(TF, name), 'utf8');

const kagentTf = tfFile('kagent.tf');
const variablesTf = tfFile('variables.tf');
const cloudRunTf = tfFile('cloud_run.tf');
const provisionerTf = tfFile('provisioner.tf');
const pipelineTf = tfFile('pipeline.tf');
const outputsTf = tfFile('outputs.tf');
const deployDoc = read('docs', 'GCP_DEPLOY.md');
const configJs = read('packages', 'shared-core', 'src', 'config.js');
const kagentJs = read('packages', 'shared-core', 'src', 'agent', 'kagent.js');
const gatewayIndex = read('services', 'gateway', 'src', 'index.js');
const gatewayRoutes = read('services', 'gateway', 'src', 'routes', 'workflows.js');

// ---------------------------------------------------------------------------
// terraform console, to check what the HCL actually RENDERS — reading kagent.tf
// proves which names are assigned, not that the value crosses into the JS regex
// that parses it.
//
// Unlike substrate-env.test.js, this does NOT evaluate the real root. That root's
// backend is the GCS state bucket, so its renders need credentials and skip on a
// plain CI runner; the class they catch (a local that renders a shape the JS side
// cannot use) is worth checking on every run when it does not have to. kagent.tf's
// two locals reference nothing but var.kagent_*, so the variables it actually
// declares plus the locals file go into a scratch root with no backend and no
// providers, which init's offline. Same HCL, same values, every machine.
//
// What this CANNOT catch: a variable that stops being declared in the real root,
// or a kagent.tf that quietly starts referencing local.substrate_env. The
// structural assertions below run against the real files, and `terraform validate`
// in the deploy job is what proves the root as a whole still composes.
// ---------------------------------------------------------------------------

const os = require('node:os');

/** Every `variable "kagent_*" { … }` block from the real root, verbatim. */
function kagentVariableBlocks() {
  const blocks = variablesTf.match(/^variable "kagent_[a-z_]+" \{[\s\S]*?^\}/gm) || [];
  const names = blocks.map((b) => /variable "(kagent_[a-z_]+)"/.exec(b)[1]);
  for (const needed of ['kagent_enabled', 'kagent_api_url', 'kagent_namespace', 'kagent_token_file', 'kagent_ca_file', 'kagent_timeout_ms']) {
    assert.ok(names.includes(needed), `variable "${needed}" is no longer a top-level block, so the render root cannot reproduce it`);
  }
  return blocks.join('\n\n');
}

let scratch = null;
function renderRoot() {
  if (scratch) return scratch;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kagent-render-'));
  fs.writeFileSync(path.join(scratch, 'main.tf'), `${kagentVariableBlocks()}\n\n${kagentTf}\n`);
  execFileSync('terraform', ['init', '-backend=false', '-input=false'], {
    cwd: scratch, timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  process.once('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* tmp cleanup */ } });
  return scratch;
}

function tfEval(expr, vars = {}) {
  const env = { ...process.env, TF_IN_AUTOMATION: '1' };
  for (const [name, value] of Object.entries(vars)) env[`TF_VAR_${name}`] = String(value);
  return execFileSync('terraform', ['console'], {
    cwd: renderRoot(), input: `${expr}\n`, env, timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'],
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

/** Every `process.env.KAGENT_*` read in shipped code (tests excluded). */
function envNamesRead() {
  const dirs = [
    path.join(ROOT, 'packages', 'shared-core', 'src'),
    path.join(ROOT, 'services', 'gateway', 'src'),
    path.join(ROOT, 'services', 'orchestrator', 'src'),
    path.join(ROOT, 'services', 'provisioner', 'src'),
  ];
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
        for (const [, name] of read(path.relative(ROOT, full))
          .matchAll(/process\.env\.(KAGENT_[A-Z0-9_]+)/g)) names.add(name);
      }
    }
  };
  for (const dir of dirs) if (fs.existsSync(dir)) walk(dir);
  return names;
}

/** Names the kagent env map actually assigns, comments stripped. */
function envNamesEmitted() {
  const code = kagentTf.replace(/^\s*#.*$/gm, '');
  return new Set([...code.matchAll(/\b(KAGENT_[A-Z0-9_]+)\s*=/g)].map(([, n]) => n));
}

/** The body of a `NAME = merge(...) }` env local, in the root file that declares it. */
function envLocal(name, text = cloudRunTf) {
  const start = text.indexOf(`  ${name} = merge(`);
  assert.notEqual(start, -1, `${name} local not found`);
  const ends = [text.indexOf('\n  )', start), text.indexOf('\n  }', start)]
    .filter((i) => i > -1);
  assert.ok(ends.length, `${name} local does not close`);
  return text.slice(start, Math.min(...ends));
}

function varBlock(name) {
  const re = new RegExp(`variable "${name}" \\{([\\s\\S]*?)\\n\\}`);
  const m = re.exec(variablesTf);
  return m ? m[1] : null;
}

function varDefault(name) {
  const block = varBlock(name);
  assert.ok(block, `variable "${name}" is not declared in variables.tf`);
  const m = /\n\s*default\s*=\s*(.*)/.exec(`${block}\n`);
  assert.ok(m, `variable "${name}" has no default — every kagent switch must be off by itself`);
  return m[1].trim();
}

const CONFIGURED = {
  kagent_enabled: 'true',
  kagent_api_url: 'https://kubernetes.default.svc',
  kagent_namespace: 'fleet-agents',
  kagent_timeout_ms: '15000',
};

test('Terraform emits only KAGENT_* names that shipped code reads', () => {
  const read$ = envNamesRead();
  const emitted = envNamesEmitted();
  assert.ok(read$.size >= 6, `expected the kagent surface to be at least 6 names, saw ${read$.size}`);
  for (const name of emitted) {
    assert.ok(read$.has(name), `${name} is set by kagent.tf but no running code reads process.env.${name}`);
  }
});

test('every kagent setting the code can honor is reachable from Terraform', () => {
  // The operator-facing direction: a name config.js reads that this root never
  // sets can only be smuggled in as a raw tfvars or secret, i.e. invisible in a
  // plan and undocumented in the one place an operator looks.
  const emitted = envNamesEmitted();
  const unsurfaced = [...envNamesRead()].filter((name) => !emitted.has(name));
  // KAGENT_KUBECONFIG is the ONE accepted gap, for the same reason
  // SUBSTRATE_TOKEN is: a kubeconfig is a bundle of credentials, and a
  // credential-bearing path has no business in a plaintext env map on a hosted
  // service. It exists for out-of-cluster local development only.
  assert.deepEqual(unsurfaced, ['KAGENT_KUBECONFIG'], 'kagent.tf must surface every non-credential KAGENT_* name');
  assert.match(
    kagentTf,
    /KAGENT_KUBECONFIG[\s\S]{0,600}(credentials|credential)/,
    'the reason KAGENT_KUBECONFIG stays unwired has to live next to the omission',
  );
});

test('no credential-shaped key is ever emitted into the kagent env map', () => {
  // KAGENT_TOKEN_FILE and KAGENT_CA_FILE pass this on purpose: they are paths,
  // and the secret they name arrives mounted, the way MEMORY_DATABASE_URL_FILE
  // names /secrets/memory-db/url. A KAGENT_TOKEN with a bearer in it would not,
  // and would also be printed by any `env` in a container that inherited it.
  for (const name of envNamesEmitted()) {
    assert.doesNotMatch(
      name,
      /(TOKEN|SECRET|KEY|PASSWORD)$/,
      `${name} looks like a credential; KAGENT_* is a plaintext env map`,
    );
  }
});

test('the kagent env reaches the gateway and nothing that runs model code', () => {
  assert.match(envLocal('gateway_env'), /local\.kagent_env,/);
  // The substrate pair does reach the orchestrator and the provisioner; kagent
  // must not follow it there until something in those services imports the
  // adapter, or a cluster identity silently widens the blast radius of a service
  // that only dispatches runs.
  const orchestrator = envLocal('orchestrator_env', pipelineTf);
  assert.match(
    orchestrator,
    /local\.substrate_env,/,
    'the orchestrator stopped carrying substrate env, so the doesNotMatch below is vacuous — retarget it at whatever map does run model code',
  );
  assert.doesNotMatch(
    orchestrator,
    /local\.kagent_env,/,
    'orchestrator_env gained kagent env — nothing in that service imports agent/kagent.js',
  );
  assert.doesNotMatch(provisionerTf, /local\.kagent_env,/, 'the provisioner does not publish agent CRDs');
});

test('an address and a switch are one gate, never a half-pair', () => {
  // kagent.js: `if (!config.enabled || !apiUrl) return null`. Emitting the URL
  // without KAGENT_ENABLED (or vice versa) renders a deployment that plans clean
  // and publishes nothing.
  assert.match(
    kagentTf,
    /kagent_enabled = var\.kagent_enabled && trimspace\(var\.kagent_api_url\) != ""/,
    'both halves must gate the map; either alone is the dark state',
  );
  const keys = [...kagentTf.replace(/^\s*#.*$/gm, '')
    .matchAll(/\b(KAGENT_[A-Z0-9_]+)\s*=/g)].map(([, n]) => n);
  assert.ok(keys.includes('KAGENT_ENABLED') && keys.includes('KAGENT_API_URL'));
});

test('the kagent surface is dark until an operator names a cluster', () => {
  assert.equal(varDefault('kagent_enabled'), 'false', 'publishing CRDs is opt-in, never a side effect of an address');
  assert.equal(varDefault('kagent_api_url'), '""');
  assert.equal(varDefault('kagent_token_file'), '""', 'a mounted token path is a deployment decision');
  assert.equal(varDefault('kagent_ca_file'), '""');
  // The default namespace is the upstream install default, and it is a scope: the
  // adapter's Role reaches only this name, so a typo is a publish into a
  // namespace the platform was never granted.
  assert.equal(varDefault('kagent_namespace'), '"kagent"');
  assert.match(
    varBlock('kagent_namespace'),
    /can\(regex\("\^\[a-z0-9\]\(\[a-z0-9-\]\{0,61\}\[a-z0-9\]\)\?\$"/,
    'kagent_namespace lost its DNS-label validation',
  );
  assert.match(
    varBlock('kagent_api_url'),
    /default\s*=\s*""/,
    'kagent_api_url must default empty so the backend is inert',
  );
});

test('the rendered kagent map is the shape the JS side parses', (t) => {
  if (!TF_RENDER.ok) return t.skip(`terraform console unavailable: ${TF_RENDER.reason}`);
  // Nothing set: inert, which is what a default apply ships.
  assert.deepEqual(tfMap('local.kagent_env'), {});
  // A switch with no address is the half-pair, and it must render as nothing.
  assert.deepEqual(tfMap('local.kagent_env', { kagent_enabled: 'true' }), {});
  assert.deepEqual(tfMap('local.kagent_env', { ...CONFIGURED, kagent_enabled: 'false' }), {});

  const on = tfMap('local.kagent_env', CONFIGURED);
  assert.equal(on.KAGENT_API_URL, CONFIGURED.kagent_api_url);
  assert.equal(on.KAGENT_NAMESPACE, 'fleet-agents');
  assert.match(on.KAGENT_TIMEOUT_MS, /^\d+$/, 'numbers cross the wire as strings');
  // The value Terraform writes has to be one the JS truthiness regex accepts.
  // "1" or "yes" here would render a configured cluster that kagent.js reads as
  // disabled, which is indistinguishable from the operator never opting in.
  assert.equal(on.KAGENT_ENABLED, 'true');
  assert.match(
    configJs,
    /\/\^\(1\|true\|yes\|on\)\$\/i\.test\(process\.env\.KAGENT_ENABLED/,
    'config.js no longer parses KAGENT_ENABLED as 1|true|yes|on — Terraform emits "true", so a shape change here silently disables a configured cluster',
  );

  // Unset optional paths stay ABSENT: an empty KAGENT_TOKEN_FILE would beat the
  // in-cluster mount kagent.js falls back to, and the token read would then fail
  // into the same silent null client as an unconfigured deployment.
  const bare = tfMap('local.kagent_env', CONFIGURED);
  for (const key of ['KAGENT_TOKEN_FILE', 'KAGENT_CA_FILE']) {
    assert.ok(!(key in bare), `${key} was emitted empty while unset`);
  }
  const mounted = tfMap('local.kagent_env', {
    ...CONFIGURED, kagent_token_file: '/secrets/kagent-token/token',
  });
  assert.equal(mounted.KAGENT_TOKEN_FILE, '/secrets/kagent-token/token');
});

test('the names the gateway emits are read by a gateway that is wired to a client', () => {
  // The third link, and the one no env-map test can see: the router refuses
  // unless it was handed an adapter. Passing none makes KAGENT_* dead config
  // even though config.js parses them and kagent.js would work.
  assert.match(gatewayIndex, /require\('@software-factory\/shared-core\/agent\/kagent'\)/);
  assert.match(
    gatewayIndex,
    /createWorkflowsRouter\(\{[\s\S]{0,120}kagentAdapter:\s*kagent,/,
    'the gateway builds the workflows router without the kagent adapter, so every publish is a 503 whatever the env says',
  );
  // …and the refusal is explicit rather than a crash on a missing client.
  assert.match(gatewayRoutes, /503\)\.json\(\{ error: 'kagent_not_configured' \}\)/);
  assert.match(kagentJs, /if \(!config\.enabled \|\| !apiUrl\) return null/, 'the client gate both halves of the switch');
});

test('the plan-facing output names both halves of the gate', () => {
  const block = /output "kagent" \{([\s\S]*?)\n\}/.exec(outputsTf);
  assert.ok(block, 'no kagent output — an apply cannot report what it emitted');
  for (const field of ['configured', 'switch', 'api_url', 'env_keys', 'services']) {
    assert.match(block[1], new RegExp(`${field}\\s*=`), `output.kagent no longer reports ${field}`);
  }
  assert.match(block[1], /configured\s*=\s*local\.kagent_enabled/);
  assert.match(block[1], /switch\s*=\s*var\.kagent_enabled/);
  // The recipient list is a claim about cloud_run.tf, and this is the only place
  // it is checked; a stale ["gateway", "planner"] documents a widening.
  assert.match(block[1], /services\s*=\s*local\.kagent_enabled \? \["gateway"\] : \[\]/);
});

test('the operator doc names the gates that exist', () => {
  // docs/GCP_DEPLOY.md is what someone reads when publish says
  // kagent_not_configured, so every claim in it has to be a claim about this
  // root. The substrate section earned the same check by being wrong at least
  // once while it was being written.
  for (const claim of [
    'kagent_enabled',
    'kagent_token_file',
    'KAGENT_KUBECONFIG',
    'namespaced Role',
  ]) {
    assert.match(
      deployDoc,
      new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `docs/GCP_DEPLOY.md no longer explains ${claim}`,
    );
  }
  // The placement claim has to live IN the kagent section: "orchestrator" appears
  // throughout this doc for other reasons, so a whole-file match would pass even
  // if the section went back to naming a recipient that no longer exists.
  const section = /^## Kagent runtime backend[\s\S]*?(?=^## )/m.exec(deployDoc);
  assert.ok(section, 'docs/GCP_DEPLOY.md lost its "Kagent runtime backend" section');
  assert.match(
    section[0],
    /orchestrator/,
    'the kagent section no longer names the workload the substrate map reaches and kagent must not',
  );
  // The Cloud Run agent harness was retired, so its per-service env locals no
  // longer exist to name. A doc that still points at one places the kagent
  // boundary on a workload nobody deploys, which reads as permission to widen it.
  assert.doesNotMatch(
    section[0],
    /planner_env|coder_control_env|coder_worker_env/,
    'the kagent section names a retired Cloud Run harness local as if it were still a recipient',
  );
});
