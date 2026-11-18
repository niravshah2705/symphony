'use strict';

// Contract test for the substrate / agentgateway public fronts.
//
// Two bugs lived here at once, and no existing check could see either one.
//
//   * The Envoy data-plane Service bound its static IP through
//     `networking.gke.io/load-balancer-ip-addresses`, fed with the address's
//     VALUE. GKE forwards that string into the forwarding rule's `address`
//     field, which validates against an address-NAME regex, so the create 400s,
//     no forwarding rule exists, the Service sits at `EXTERNAL-IP <pending>`
//     and the Gateway reports `Programmed=False / AddressNotAssigned`. Nothing
//     in a `terraform plan` says so: the apply is green, DNS is right, the
//     certificate is issued, every pod is Running.
//   * The control-plane route's backend defaulted to `ateapi:8443`, a Service
//     that `ate-setup` has never created (it makes `api` on 443 `grpc` and 8445
//     `exchange`). The route stays `Accepted=True` and only
//     `ResolvedRefs=False / BackendNotFound` admits it is routing to nothing.
//
// Both fields LOOK interchangeable — same address, same port, one obvious
// spelling — which is exactly why they need pinning rather than review.
// And the Service name is not free: the control-plane bearer's audience is
// `${service}.ate-system.svc`, so the Terraform default, ConfigMap
// ate-api-authentication and the rotator's `--audience` are one value written
// in three files. A half-change here trades a 404 for a 16 UNAUTHENTICATED.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const GKE_DIR = path.join('deploy', 'gcp', 'terraform-substrate-gke');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const substrateTf = read(GKE_DIR, 'substrate.tf');
const agentgwTf = read(GKE_DIR, 'agentgateway.tf');
const gkeVars = read(GKE_DIR, 'variables.tf');
const rootTokenTf = read('deploy', 'gcp', 'terraform', 'substrate_token.tf');
const rotateYml = read('.github', 'workflows', 'substrate-token-rotate.yml');

const ANNOTATION = 'networking.gke.io/load-balancer-ip-addresses';

const lines = (source, needle) => source.split('\n').filter((line) => line.includes(needle));

// The `variable "x" { ... }` block's scalar default, as written in Terraform.
function tfDefault(name) {
  const block = gkeVars.match(new RegExp(`variable "${name}" \\{[\\s\\S]*?\\n\\}`));
  assert.ok(block, `variable "${name}" is not declared in the substrate GKE root`);
  const def = block[0].match(/default\s*=\s*"?([^"\n]+?)"?\s*$/m);
  assert.ok(def, `variable "${name}" declares no default`);
  return def[1];
}

// Each front, the address resource behind it, and the file that renders it.
const FRONTS = [
  { label: 'substrate-ingress', source: substrateTf, address: 'substrate_ip' },
  { label: 'agentgateway front', source: agentgwTf, address: 'agentgateway_ip' },
];

test('the static IP annotation is fed the address NAME, not its value', () => {
  for (const { label, source, address } of FRONTS) {
    const found = lines(source, 'load-balancer-ip-addresses');
    assert.equal(found.length, 1, `${label}: render exactly one bind annotation, not two that can disagree`);
    const ref = new RegExp(`google_compute_address\\.${address}(?:\\[0\\])?\\.(\\w+)`);
    const attr = found[0].match(ref);
    assert.ok(attr, `${label}: the annotation must resolve to a ${address} attribute`);
    assert.equal(
      attr[1],
      'name',
      `${label}: ${ANNOTATION} takes the address name — an IP literal is rejected by `
        + 'the forwarding-rule create, which leaves the Gateway AddressNotAssigned with a green apply',
    );
  }
});

test('the deprecated loadBalancerIP field keeps the address VALUE, deliberately unlike the annotation', () => {
  for (const { label, source, address } of FRONTS) {
    const found = lines(source, 'loadBalancerIP').filter((line) => line.includes('google_compute_address'));
    assert.ok(found.length >= 1, `${label}: the front must still pin loadBalancerIP while the field exists`);
    for (const line of found) {
      assert.match(line, new RegExp(`google_compute_address\\.${address}(?:\\[0\\])?\\.address`),
        `${label}: loadBalancerIP wants the IP, so this is not a place to "fix" to .name`);
      assert.doesNotMatch(line, new RegExp(`google_compute_address\\.${address}(?:\\[0\\])?\\.name\\b`),
        `${label}: an address NAME here is the mirror-image mistake`);
    }
  }
});

test('the control-plane backend defaults name the Service that actually exists', () => {
  // Verified against the live ate-system: `svc/api` (headless) exposes
  // 443 -> grpc and 8445 -> exchange, and `svc/ateapi` is not found.
  assert.equal(tfDefault('substrate_ateapi_service'), 'api',
    'ateapi is the proto package in the path match, not the Service name');
  assert.equal(tfDefault('substrate_ateapi_port'), '443', 'there is no 8443 anywhere in ate-system');
  // A literal left behind in the route would silently outrank the variable.
  assert.doesNotMatch(substrateTf, /8443/, 'the route backend comes from the variables only');
});

test('the route reads its backend from the variables, so an operator can repoint it without a PR', () => {
  const route = substrateTf.slice(substrateTf.indexOf('resource "kubectl_manifest" "substrate_control_plane_route"'));
  assert.ok(route.length > 0, 'the control-plane route resource is missing');
  assert.match(route, /- name: \$\{var\.substrate_ateapi_service\}/);
  assert.match(route, /port: \$\{var\.substrate_ateapi_port\}/);
  // deploy.yml threads both from repo variables; a default nobody can override
  // is how the wrong one survived as long as this one did. Tolerant of `$NAME`
  // versus `${NAME}` — the point is that a CI path exists, not the shell spelling.
  const deployYml = read('.github', 'workflows', 'deploy.yml');
  for (const [envKey, varName] of [
    ['SUBSTRATE_ATEAPI_SERVICE', 'substrate_ateapi_service'],
    ['SUBSTRATE_ATEAPI_PORT', 'substrate_ateapi_port'],
  ]) {
    assert.match(deployYml, new RegExp(`-var="${varName}=\\$\\{?${envKey}\\}?\\"`),
      `${varName} has no CI path from the ${envKey} repo variable`);
  }
});

test('the Service name, the token audience and the minting job are one value in three files', () => {
  const audience = `${tfDefault('substrate_ateapi_service')}.ate-system.svc`;
  assert.equal(audience, 'api.ate-system.svc');
  // ConfigMap ate-api-authentication carries exactly this audience; the two
  // places in the repo that state it must agree with the route backend, or the
  // corrected route reaches a healthy Service that refuses every token.
  assert.ok(rootTokenTf.includes(audience), `substrate_token.tf no longer names ${audience}`);
  assert.match(rotateYml, new RegExp(`vars\\.SUBSTRATE_ATEAPI_AUDIENCE \\|\\| '${audience}'`),
    'the rotator must default to the same audience the control plane validates');
  assert.doesNotMatch(rootTokenTf + rotateYml, /ateapi\.ate-system\.svc/,
    'no credential may be minted for the Service name that does not exist');
});
