'use strict';

// Structural invariants for the gateway's Direct VPC egress block.
//
// This switch is off by default, which is exactly why it needs tests: nothing
// exercises the on path until an operator turns it on in production, and every
// way to get it wrong there is silent. A singular `network_interface` is a plan
// error (cheap). An empty `vpc_network` with the flag true, or an `egress`
// literal that overrode the variable, is not — the service deploys, keeps its
// old routing, and reads as switched on.
//
// The second half is scope. Egress changes the SOURCE IP of everything the
// service sends into the VPC range, so a block that leaked onto a second service
// would move traffic nobody reviewed. Today the gateway is the only one, on
// purpose (planner/coder are being retired); this file pins that so widening it
// stays a decision rather than a copy-paste.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TF = path.join(__dirname, 'terraform');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const tfFile = (name) => fs.readFileSync(path.join(TF, name), 'utf8');

const variablesTf = tfFile('variables.tf');
const cloudRunTf = tfFile('cloud_run.tf');
const deployYml = read('.github', 'workflows', 'deploy.yml');
const deployDoc = read('docs', 'GCP_DEPLOY.md');
const statusDoc = read('docs', 'SUBSTRATE_STATUS.md');

const VARS = ['vpc_network', 'vpc_subnet', 'vpc_egress_mode', 'gateway_vpc_egress_enabled'];

/** The body of `variable "<name>" { … }` from variables.tf, or null. */
function varBlock(name) {
  const m = new RegExp(`variable "${name}" \\{([\\s\\S]*?)\\n\\}`).exec(variablesTf);
  return m ? m[1] : null;
}

function varDefault(name) {
  const block = varBlock(name);
  assert.ok(block, `variable "${name}" is not declared in variables.tf`);
  const m = /\n\s*default\s*=\s*(.*)/.exec(`${block}\n`);
  assert.ok(m, `variable "${name}" has no default — an egress switch must be off by itself`);
  return m[1].trim();
}

/** Text of every top-level `resource "type" "name" { … }` block, keyed by name. */
function resourceBlocks(text, type) {
  const out = {};
  const starts = [...text.matchAll(new RegExp(`^resource "${type}" "([^"]+)" \\{`, 'gm'))];
  for (const [i, m] of starts.entries()) {
    const end = starts[i + 1] ? starts[i + 1].index : text.length;
    out[m[1]] = text.slice(m.index, end);
  }
  return out;
}

const services = resourceBlocks(cloudRunTf, 'google_cloud_run_v2_service');

// ---------------------------------------------------------------------------
// The variables: present, typed, and inert without an operator.
// ---------------------------------------------------------------------------

test('the egress switches exist and are off (or empty) by themselves', () => {
  assert.equal(varDefault('gateway_vpc_egress_enabled'), 'false');
  assert.equal(varDefault('vpc_network'), '""');
  assert.equal(varDefault('vpc_subnet'), '""');
  for (const name of VARS) {
    assert.match(varBlock(name), /description\s*=\s*<<-EOT|description\s*=\s*"/, `${name} needs a description`);
  }
});

test('vpc_egress_mode accepts only the two values the API defines', () => {
  const block = varBlock('vpc_egress_mode');
  assert.equal(varDefault('vpc_egress_mode'), '"PRIVATE_RANGES_ONLY"');
  // A typo here is not caught by validate — the API accepts the plan and then
  // routes traffic somewhere the operator did not ask for, so the enum is pinned.
  const validation = /validation\s*\{([\s\S]*?)\n\s*\}/.exec(block);
  assert.ok(validation, 'vpc_egress_mode must carry a validation block');
  for (const mode of ['PRIVATE_RANGES_ONLY', 'ALL_TRAFFIC']) {
    assert.ok(validation[1].includes(`"${mode}"`), `validation must allow ${mode}`);
  }
  assert.match(validation[1], /contains\(\s*\[/);
});

test('the flag says it is plumbing, and the docs say there is no destination yet', () => {
  // The failure this guards is an operator reading "gateway_vpc_egress_enabled"
  // as "the planner can now reach ateapi". It cannot: `Service api` is headless.
  assert.match(varBlock('gateway_vpc_egress_enabled'), /plumbing/i);
  assert.match(statusDoc, /ClusterIP: None|headless/);
  assert.match(statusDoc, /gateway_vpc_egress_enabled/);
  assert.match(deployDoc, /headless/);
});

// ---------------------------------------------------------------------------
// The block: gated, correctly spelled, and on exactly one service.
// ---------------------------------------------------------------------------

test('the vpc_access block disappears entirely when the flag is off', () => {
  assert.match(
    cloudRunTf,
    /gateway_vpc_access\s*=\s*var\.gateway_vpc_egress_enabled\s*\?\s*\[1\]\s*:\s*\[\]/,
    'the dynamic must key off a 0/1-element list, not an always-present block',
  );
  const gateway = services.gateway;
  assert.match(gateway, /dynamic "vpc_access" \{\s*\n\s*for_each = local\.gateway_vpc_access/);
});

test('the nested block is network_interfaces (plural) and names no connector', () => {
  const gateway = services.gateway;
  assert.match(gateway, /network_interfaces \{/);
  // `network_interface { }` is not an argument of vpc_access; keep the plural
  // from regressing into the form that reads more natural.
  assert.doesNotMatch(cloudRunTf, /\nnetwork_interface\s*\{/);
  assert.doesNotMatch(gateway, /connector\s*=/, 'a paid Serverless VPC Access connector is deliberately unused');
});

test('egress, network and subnetwork all come from variables, not literals', () => {
  const block = /dynamic "vpc_access" \{[\s\S]*?\n    \}/.exec(services.gateway);
  assert.ok(block, 'no dynamic vpc_access block on the gateway');
  assert.match(block[0], /egress\s*=\s*var\.vpc_egress_mode\b/);
  assert.match(block[0], /network\s*=\s*var\.vpc_network\b/);
  assert.match(block[0], /subnetwork\s*=\s*var\.vpc_subnet\b/);
});

test('only the gateway has egress, and enabling it requires both names', () => {
  const withEgress = Object.entries(services).filter(([, body]) => /vpc_access/.test(body)).map(([name]) => name);
  assert.deepEqual(withEgress, ['gateway'], `Direct VPC egress leaked onto: ${withEgress.join(', ')}`);
  // Every service in the root, not just cloud_run.tf's three: the other thirteen
  // live in their own files, and a block copied into one of them would not show
  // up in the check above.
  const all = fs.readdirSync(TF).filter((f) => f.endsWith('.tf'));
  const joinsVpc = all.filter((f) => /network_interfaces\s*\{/.test(tfFile(f)));
  assert.deepEqual(joinsVpc, ['cloud_run.tf'], `another file joined the VPC: ${joinsVpc.join(', ')}`);
  assert.equal(
    (cloudRunTf.match(/^\s+network_interfaces \{/gm) || []).length,
    1,
    'exactly one service may join the VPC until the planner/coder question is settled',
  );
  const lifecycle = /lifecycle \{([\s\S]*?)\n  \}/.exec(services.gateway);
  assert.ok(lifecycle, 'the gateway resource lost its lifecycle block');
  const preconditions = [...lifecycle[1].matchAll(/precondition \{([\s\S]*?)\n    \}/g)];
  assert.ok(
    preconditions.some(([, body]) => /var\.gateway_vpc_egress_enabled/.test(body)
      && /var\.vpc_network/.test(body)
      && /var\.vpc_subnet/.test(body)),
    `gateway_vpc_egress_enabled=true with an empty network or subnetwork must fail the plan (checked ${preconditions.length} preconditions)`,
  );
});

// ---------------------------------------------------------------------------
// CI: every switch is reachable from a repo variable, with the same default.
// ---------------------------------------------------------------------------

test('deploy.yml passes every egress variable it declares, and vice versa', () => {
  for (const name of VARS) {
    assert.match(deployYml, new RegExp(`-var="${name}=\\$\\{\\{`), `deploy.yml never sets ${name}`);
  }
  for (const [, name] of deployYml.matchAll(/-var="(vpc_[a-z_]+|gateway_vpc_egress_enabled)=/g)) {
    assert.ok(varBlock(name), `deploy.yml sets ${name}, which variables.tf does not declare`);
  }
});

test("CI's fallbacks match the Terraform defaults", () => {
  // A `|| 'true'` here would turn the switch on for every deployment that never
  // set the repo variable — the default would live in two places and disagree.
  const lines = Object.fromEntries(
    [...deployYml.matchAll(/-var="(vpc_[a-z_]+|gateway_vpc_egress_enabled)=\$\{\{ vars\.([A-Z_]+)(?: \|\| '([^']*)')? \}\}/g)]
      .map(([, tfVar, , fallback]) => [tfVar, fallback]),
  );
  assert.equal(lines.gateway_vpc_egress_enabled, 'false');
  assert.equal(lines.vpc_egress_mode, 'PRIVATE_RANGES_ONLY');
  // The two names have no fallback on purpose: unset must stay empty, and an
  // empty name is what the precondition above refuses the plan for.
  assert.equal(lines.vpc_network, undefined, 'vpc_network must not gain a hardcoded CI default');
  assert.equal(lines.vpc_subnet, undefined, 'vpc_subnet must not gain a hardcoded CI default');
});

test('the docs name the same four switches CI sets', () => {
  for (const [ciVar, tfVar] of [
    ['GATEWAY_VPC_EGRESS_ENABLED', 'gateway_vpc_egress_enabled'],
    ['VPC_NETWORK', 'vpc_network'],
    ['VPC_SUBNET', 'vpc_subnet'],
    ['VPC_EGRESS_MODE', 'vpc_egress_mode'],
  ]) {
    assert.ok(deployDoc.includes(ciVar), `docs/GCP_DEPLOY.md never mentions the ${ciVar} repo variable (${tfVar})`);
  }
  assert.match(deployDoc, /Cloud NAT/, 'ALL_TRAFFIC depends on Cloud NAT; the doc must say so');
});
