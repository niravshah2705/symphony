'use strict';

// Does the Deploy to GCP workflow actually reach the substrate variable surface?
//
// #283 made Agent Substrate the only execution pattern, and the same deployment
// that carries it destroys the Cloud Run planner/coder harnesses. So the root
// stack's `substrate_*` variables are no longer an optional integration — they
// are how a deployed agent dials anything. Until now none of them had a CI path:
// the workflow never passed a single one, and the mistake was silent, because
// every consumer (substrate.tf's env maps, config.js, substrate-runner.js)
// falls back to an inert default when its variable is absent. A dark deployment
// plans, applies and reports green.
//
// The invariants, in the order they cost to get wrong:
//   1. The switch has to be reachable. Every substrate variable the root module
//      READS must be set by the apply step; a name with no CI path is a switch
//      an operator can only turn on by editing a workflow.
//   2. Reaching it must not mean turning it on. An unset repo variable stays
//      empty, so a merge cannot silently repoint production at an address
//      nobody reviewed.
//   3. Empty must stay empty where Terraform's default is a real value.
//      substrate.tf's own rule is that a key is absent rather than "", because
//      an empty string beats both the Terraform default and an org setting; so
//      those names are appended conditionally, never with a blank `-var`.
//   4. The cutover itself needs a gate: destroying the last working harness with
//      no control plane to replace it is a broken deployment that no check
//      catches, so the job says so before `terraform apply`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TF = path.join(__dirname, 'terraform');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const tfFile = (name) => fs.readFileSync(path.join(TF, name), 'utf8');

const variablesTf = tfFile('variables.tf');
const deployYml = read('.github', 'workflows', 'deploy.yml');
const deployDoc = read('docs', 'GCP_DEPLOY.md');

/** The whole "Terraform apply" step, up to the next step's header. */
function applyStep(text) {
  const start = text.indexOf('- name: Terraform apply');
  assert.notEqual(start, -1, 'deploy workflow lost the Terraform apply step');
  const next = text.indexOf('\n      - name: ', start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

/** `variable "<name>" { … }` body from variables.tf, or null. */
function varBlock(name) {
  const m = new RegExp(`variable "${name}" \\{([\\s\\S]*?)\\n\\}`).exec(variablesTf);
  return m ? m[1] : null;
}

function varDefault(name) {
  const block = varBlock(name);
  assert.ok(block, `variable "${name}" is not declared in variables.tf`);
  const m = /\n\s*default\s*=\s*(.*)/.exec(`${block}\n`);
  assert.ok(m, `variable "${name}" has no default — CI cannot pass it safely`);
  return m[1].trim();
}

const step = applyStep(deployYml);

// Every substrate variable the root module reads, from the whole root config —
// substrate.tf, iam.tf and outputs.tf all consume them, and a gate that lives in
// only one of the three is the bug this file is about.
const rootSource = fs
  .readdirSync(TF)
  .filter((f) => f.endsWith('.tf'))
  .map(tfFile)
  .join('\n');
const READ = [...new Set([...rootSource.matchAll(/\bvar\.(substrate_[a-z_]+)/g)].map((m) => m[1]))].sort();
assert.ok(READ.length >= 12, `expected the substrate surface, found ${READ.length} names`);

// tfVar -> how CI passes it, line by line so "inside apply_args=( … )" and
// "appended only when the repo variable is set" stay distinguishable. Two shapes
// are legitimate: `${{ vars.X }}` for a scalar, and a shell variable computed
// above the array for a list/map that needs splitting.
const passed = new Map();
for (const raw of step.split('\n')) {
  const line = raw.trim();
  let m = /-var="(substrate_[a-z_]+)=\$\{\{ vars\.([A-Z_]+)((?: \|\| '[^']*')?) \}\}/.exec(line);
  if (m) {
    passed.set(m[1], { repoVar: m[2], fallback: (m[3] || '').trim(), conditional: line.startsWith('[ -n') });
    continue;
  }
  m = /-var="(substrate_[a-z_]+)=\$\{([A-Z_]+)\}/.exec(line);
  if (m) passed.set(m[1], { shellVar: m[2], fallback: '', conditional: false });
}

/** The lines that build a shell arg the apply step feeds to `-var`. */
function shellArgInit(name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(step);
  assert.ok(m, `${name} is never initialised — a -var that references it can pass unset`);
  return m[1];
}

// ---------------------------------------------------------------------------
// 1. Reachability: no substrate switch may exist without a CI path to it.
// ---------------------------------------------------------------------------

test('CI sets every substrate variable the root module reads', () => {
  const unreachable = READ.filter((name) => !passed.has(name));
  assert.deepEqual(
    unreachable,
    [],
    `these substrate variables are read by Terraform but never passed by the deploy workflow, ` +
      `so the pattern stays dark no matter what an operator sets: ${unreachable.join(', ')}`,
  );
});

test('CI sets no substrate variable the root module does not declare', () => {
  for (const name of passed.keys()) {
    assert.ok(varBlock(name), `CI passes ${name}, which variables.tf does not declare`);
  }
});

// ---------------------------------------------------------------------------
// 2-3. Defaults: the switch is off by itself, and an empty CI value can never
//      override a non-empty Terraform default.
// ---------------------------------------------------------------------------

test('the addresses and names that gate the pattern have no CI fallback', () => {
  // `|| 'grpc://…'` here would dial a cluster from every deployment that never
  // opted in — the default would live in two places and disagree.
  for (const name of ['substrate_url', 'substrate_ingress_url', 'substrate_atespace', 'substrate_planner_image', 'substrate_jwks_url', 'substrate_actor_member']) {
    assert.equal(varDefault(name), '""', `${name} should be blank by default in variables.tf`);
    assert.equal(passed.get(name).fallback, '', `${name} must not gain a hardcoded CI default`);
  }
  assert.equal(varDefault('substrate_allowed_atespaces'), '[]');
  assert.equal(varDefault('substrate_atespace_by_org'), '{}');
  // The two collections are split from one repo variable into HCL, so the
  // unset case has to render the Terraform default rather than an empty
  // scalar: `[]` and `{}` mean "key absent", `""` would mean "no spaces".
  for (const [tfVar, shellVar, repoVar, empty] of [
    ['substrate_allowed_atespaces', 'SUBSTRATE_ALLOWED_ATESPACES_ARG', 'SUBSTRATE_ALLOWED_ATESPACES', '[]'],
    ['substrate_atespace_by_org', 'SUBSTRATE_ATESPACE_BY_ORG_ARG', 'SUBSTRATE_ATESPACE_BY_ORG', '{}'],
  ]) {
    assert.equal(passed.get(tfVar).shellVar, shellVar, `${tfVar} is not passed from the computed arg`);
    assert.equal(shellArgInit(shellVar), empty, `${shellVar} must start at the Terraform default ${empty}`);
    assert.match(
      step,
      new RegExp(`if \\[ -n "\\\$\\{\\{ vars\\.${repoVar} \\}\\}"\\s*\\];\\s*then\\s*\\n\\s*${shellVar}="\\$\\(echo`),
      `${shellVar} is rewritten without an emptiness test on vars.${repoVar}`,
    );
    assert.match(
      step,
      new RegExp(`${shellVar}="\\$\\(echo "\\$\\{\\{ vars\\.${repoVar} \\}\\}" \\| jq -Rc`),
      `${shellVar} must be parsed by jq, not interpolated raw into an HCL expression`,
    );
  }
});

test('a real Terraform default is not blanked by an unset repo variable', () => {
  for (const [name, value] of Object.entries(passed)) {
    const dflt = varDefault(name);
    if (dflt === '""' || dflt === '[]' || dflt === '{}' || dflt === 'false' || dflt === 'true') continue;
    assert.ok(
      value.conditional,
      `${name} defaults to ${dflt}; passing it unconditionally means an unset repo ` +
        `variable overrides that default with an empty value`,
    );
  }
});

test('the one boolean CI defaults agrees with Terraform', () => {
  const actorMode = passed.get('substrate_actor_mode');
  assert.equal(varDefault('substrate_actor_mode'), 'false');
  assert.equal(actorMode.fallback, "|| 'false'");
});

// ---------------------------------------------------------------------------
// 4. The cutover gate.
// ---------------------------------------------------------------------------

test('the job refuses to destroy the last harness with no substrate URL', () => {
  const guard = /if grep -qE '([^']*planner[^']*)' primary-plan\.txt \\\s*\n\s*&& \[ -z "\$\{\{ vars\.SUBSTRATE_URL \}\}" \]; then/.exec(step);
  assert.ok(guard, 'the apply step must inspect the saved plan for the harness destroy and test SUBSTRATE_URL');
  assert.match(guard[1], /coder_control|coder_worker/, 'the retired coder services count too');
  assert.match(step, /::error::This plan destroys the last Cloud Run agent harness/);
  const guardAt = step.indexOf('if grep -qE');
  assert.ok(guardAt > step.indexOf('primary-plan.txt'), 'the guard runs on the plan it just produced');
  assert.ok(guardAt < step.indexOf('terraform apply -input=false primary.tfplan'), 'the guard has to stop the apply');
});

test('the docs name the switch an operator has to set', () => {
  assert.ok(deployDoc.includes('SUBSTRATE_URL'), 'docs/GCP_DEPLOY.md must document the SUBSTRATE_URL repo variable');
});
