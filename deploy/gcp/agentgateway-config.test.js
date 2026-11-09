'use strict';

// Structural invariants for the agentgateway seam (Stage F), which ships DARK: the
// route exists, the vault key exists, and the sidecar can resolve a trusted origin —
// but nothing on the client side builds a /agentgw base URL yet, so no run is routed
// through it until the substrate root renders the address. Every assertion here is
// about the two ways a dark seam becomes a live outage: an origin Terraform accepts
// and the sidecar then refuses (fail-closed 502 in production), or the real gateway
// address leaking onto an agent container (open relay with a credential attached).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const { EGRESS_ROUTES, EGRESS_SECRET_KEYS } = require('@ai-fleet/shared-core/egress');
const { normalizeTrustedUpstream } = require('../../services/proxy/src/credentials');

const cloudRun = read('deploy', 'gcp', 'terraform', 'cloud_run.tf');
const variables = read('deploy', 'gcp', 'terraform', 'variables.tf');

/** A Python tuple literal, sliced from `NAME: ` to its closing paren. */
function pyTuple(file, name) {
  const source = read(...file.split('/'));
  const start = source.indexOf(`${name}: `);
  assert.notEqual(start, -1, `${name} not found in ${file}`);
  const from = source.indexOf('(', start);
  const to = source.indexOf('\n)', from);
  return source.slice(from, to === -1 ? source.length : to);
}

/** A Python dict literal, sliced from `NAME = {` to its closing brace. */
function pyDict(file, name) {
  const source = read(...file.split('/'));
  const start = source.indexOf(`${name} = {`);
  assert.notEqual(start, -1, `${name} not found in ${file}`);
  const to = source.indexOf('\n}', start);
  return source.slice(start, to === -1 ? source.length : to);
}

test('/agentgw is an env-pinned target route, never a static upstream', () => {
  const route = EGRESS_ROUTES.agentgateway;
  // resolveUpstream returns route.upstream RAW, bypassing normalizeTrustedUpstream.
  // A gateway that fans out to the internet and holds a real provider key must not
  // be able to name its own origin from the table.
  assert.equal(route.target, 'agentgateway');
  assert.equal(route.upstream, undefined);
  assert.equal(route.auth, 'apiKey');
  assert.equal(route.scheme, 'bearer');
  assert.equal(route.secretKey, 'fleetGatewayApiKey');
  // optionalCredential would make the route anonymous (fail-open). Never here.
  assert.equal(route.optionalCredential, undefined);
  // exact would pin the whole path, and MCP + A2A ride this prefix as sub-paths.
  assert.equal(route.exact, undefined);
});

test('the dark state is real: no client-side module names the gateway', () => {
  // Decision #1 puts agentgateway *in front of* LiteLLM physically, so
  //  - LLM_GATEWAY_MODES stays {langsmith, litellm} (per-request, never per-deployment), and
  //  - there is no CONFIG.AGENTGATEWAY block, because a second enable knob could only
  //    disagree with AGENTGATEWAY_PROXY_UPSTREAM, which already fails closed 502.
  // This asserts the deviation instead of trusting it: the route table and the
  // sidecar are the only two places the name appears in code.
  for (const file of [
    'packages/shared-core/src/config.js',
    'packages/shared/src/config.js',
    'packages/shared/src/agent/llm.js',
    'packages/shared/src/egress.js',
  ]) {
    assert.doesNotMatch(read(...file.split('/')), /agentgate|agentgw/i, `${file} must not name the gateway yet`);
  }
  assert.doesNotMatch(read('packages', 'shared-core', 'src', 'config.js'), /LLM_GATEWAY_MODES[\s\S]*?agentgateway/);
});

test('agentgateway has a vault key and the platform never holds one', () => {
  // The sidecar resolves fleetGatewayApiKey from the org's vault via the same path as
  // litellmApiKey; a managed entry would put a platform gateway master key behind every
  // tenant's virtual key.
  assert.ok(EGRESS_SECRET_KEYS.includes('fleetGatewayApiKey'), 'the sidecar must be allowed to ask for it');
  const secrets = 'services/settings/app/models/secrets.py';
  assert.match(pyTuple(secrets, 'SECRET_KEYS'), /"fleetGatewayApiKey"/);
  assert.match(pyTuple(secrets, 'CUSTOMER_ONLY_SECRET_KEYS'), /"fleetGatewayApiKey"/);
  // BROWSER_WRITABLE_SECRET_KEYS is a COMPUTED tuple, so assert on its exclusion
  // literal (`not in (...)`): an org-writable gateway key would repoint platform
  // traffic at an arbitrary origin.
  const writable = pyTuple(secrets, 'BROWSER_WRITABLE_SECRET_KEYS');
  assert.match(writable.slice(writable.indexOf('not in (')), /"fleetGatewayApiKey"/);
  assert.doesNotMatch(
    pyDict('services/settings/app/services/secrets_service.py', 'MANAGED_ENV'),
    /"fleetGatewayApiKey"/,
    'agentgateway is customer-only; there is no managed gateway key to mount',
  );
});

test('the Terraform guard never admits an origin the sidecar will refuse', () => {
  // The var's validation regex and normalizeTrustedUpstream are the same rule written
  // in two languages. If TF accepts a value the runtime rejects, `terraform validate`
  // is green and the first agentgw run 502s.
  const decl = variables.slice(variables.indexOf('variable "agentgateway_proxy_upstream"'));
  const literal = decl.match(/can\(regex\("([^"]+)",/);
  assert.ok(literal, 'agentgateway_proxy_upstream must carry a validation regex');
  const tfAccepts = new RegExp(literal[1].replace(/\[:space:\]/g, '\\s'));

  const runtimeAccepts = (value) => {
    try {
      normalizeTrustedUpstream(value, 'AGENTGATEWAY_PROXY_UPSTREAM');
      return true;
    } catch (_) {
      return false;
    }
  };

  for (const value of [
    'http://agentgateway-gateway.substrate.svc.cluster.local:9900',
    'https://gw.example.com',
    'https://gw.example.com/',
    'http://127.0.0.1:15080',
  ]) {
    assert.ok(tfAccepts.test(value), `TF must accept ${value}`);
    assert.ok(runtimeAccepts(value), `TF accepts ${value} but the sidecar refuses it — a green apply, a live 502`);
  }
  // Anything the sidecar rejects for shape must be caught at plan time too. The
  // guards are not equal — normalizeTrustedUpstream allows a path on the target
  // (`https://gw/x` -> origin + /x) and the Terraform rule does not — and TF being the
  // STRICTER of the two is the safe direction: no value passes validate and then 502s.
  for (const value of [
    'https://user:pw@gw.example.com',
    'https://gw.example.com@evil.test',
    'https://gw.example.com?token=1',
    'https://gw.example.com#frag',
    'grpc://gw.example.com:9900',
  ]) {
    assert.ok(!runtimeAccepts(value), `${value} must be refused at runtime`);
    assert.ok(!tfAccepts.test(value), `TF must reject ${value} at plan time`);
  }
});

test('the gateway origin is sidecar-only', () => {
  // Same invariant as LITELLM_PROXY_UPSTREAM, one gateway later: it appears exactly
  // once in cloud_run.tf, inside local.proxy_plain_env (the container map consumed only
  // by `containers { name = "egress-proxy" }`). An agent container that learned it could
  // drive an arbitrary target through a prefix that forwards any sub-path.
  const hits = [...cloudRun.matchAll(/AGENTGATEWAY_PROXY_UPSTREAM/g)];
  assert.equal(hits.length, 1, 'the origin may be published from one place only');
  const start = cloudRun.indexOf('proxy_plain_env = merge(');
  const end = cloudRun.indexOf('planner_env = merge(');
  assert.ok(start !== -1 && end > hits[0].index, 'that place is the sidecar env map');

  const proxyMap = cloudRun.slice(start, end);
  assert.match(
    proxyMap,
    /trimspace\(var\.agentgateway_proxy_upstream\) != "" \? \{\n\s+AGENTGATEWAY_PROXY_UPSTREAM = trimspace\(var\.agentgateway_proxy_upstream\)\n\s*\} : \{\},/,
    'an empty origin must publish nothing, so the route stays dark instead of defaulting',
  );
  // local.egress_env is the map the agent containers actually receive.
  const egressEnv = cloudRun.slice(cloudRun.indexOf('egress_env = {'), cloudRun.indexOf('}', cloudRun.indexOf('EGRESS_PROXY_URL')));
  assert.doesNotMatch(egressEnv, /AGENTGATEWAY/, 'agent containers hold the sentinel and the sidecar address, nothing else');
});

// ---------------------------------------------------------------------------
// The GKE half (Stage H): agentgateway.tf in deploy/gcp/terraform-substrate-gke
// renders the gateway the /agentgw route forwards to. The seams above are what
// make the route resolvable; these are what keep the rendered gateway from
// becoming a second, unaudited credential path.
// ---------------------------------------------------------------------------

const GKE = ['deploy', 'gcp', 'terraform-substrate-gke'];
const [agentgw, gkeVars, tfvars, gkeOutputs, substrate] =
  ['agentgateway.tf', 'variables.tf', 'terraform.tfvars.example', 'outputs.tf', 'substrate.tf'].map((file) => read(...GKE, file));
const litellmConfig = read('deploy', 'litellm', 'config.yaml');

const tfStringList = (source, name) => {
  const block = source.match(new RegExp(`${name} = \\[([^\\]]*)\\]`, 'm'));
  assert.ok(block, `${name} not found`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map(([, value]) => value).filter((v) => !v.startsWith('#'));
};

test('the gateway allowlist equals the LiteLLM catalog it fronts', () => {
  // One rule, two renderers. agentgateway matches the inbound `model` exactly
  // the way LiteLLM does (config.yaml's `model_name` is matched verbatim), so a
  // divergence is not cosmetic: a model absent from the allowlist 403s mid-run
  // and a model present there but not served 500s. Both look like a gateway bug.
  const served = [...litellmConfig.matchAll(/^\s*-\s+model_name:\s*(\S+)$/gm)].map(([, m]) => m);
  assert.ok(served.length > 0, 'deploy/litellm/config.yaml must define a catalog');
  const allowed = tfStringList(tfvars, 'agentgateway_models');
  assert.deepEqual(new Set(allowed), new Set(served), 'tfvars example allowlist must equal the LiteLLM model_list');

  // And the variable itself stays deny-by-default: a tfvars file is what an
  // operator edits, the default is what a forgetful apply gets.
  const decl = gkeVars.slice(gkeVars.indexOf('variable "agentgateway_models"'));
  assert.match(decl, /default\s*=\s*\[\]/, 'no allowlist means no model is allowed');
  assert.match(agentgw, /__agentgateway_models_unset__/, 'the empty case renders a rule that cannot match');
});

test('Terraform renders names and hashes, never live material', () => {
  // The CLAUDE.md invariant, applied to this root: state is readable by anyone
  // with container.admin, which is the CI deployer identity. So the only key
  // bytes in these files may be the sha256 form the ConfigMap wants.
  assert.match(agentgw, /keyHash\s+= hash/, 'virtual keys enter as hashes');
  assert.doesNotMatch(agentgw, /resource "kubernetes_secret_v1"/, 'no Secret is written from here');
  assert.match(
    agentgw,
    /secretRef = \{ name = var\.agentgateway_provider_key_secret \}/,
    'the provider key Secret is named, never populated',
  );
  const keysVar = gkeVars.slice(gkeVars.indexOf('variable "agentgateway_virtual_keys"'));
  assert.match(keysVar, /\^sha256:\[0-9a-f\]\{64\}\$/, 'a raw key pasted into tfvars must fail at plan time');
  assert.match(agentgw, /user_id = "org:\$\{org_id\}"/, 'the metric label is the join key to a usage record');
});

test('one whole policy, one gateway class, one pinned chart pair', () => {
  // agentgateway documents that separate policies can overwrite one another
  // while both still report ACCEPTED/ATTACHED. Two AgentgatewayPolicies here is
  // not a style break, it is an auth rule that no longer applies.
  const policies = [...agentgw.matchAll(/kind\s*=\s*"AgentgatewayPolicy"/g)];
  assert.equal(policies.length, 1, 'render exactly one policy, and never patch it piecemeal');
  assert.match(agentgw, /mode              = "Strict"/, 'an anonymous request must 401, never pass');
  assert.match(agentgw, /gatewayClassName = "agentgateway"/);
  // The chart installs the control plane only; the data plane is per-Gateway, so
  // the IP and the pool pinning have to live in AgentgatewayParameters.
  assert.match(agentgw, /kind       = "AgentgatewayParameters"/);
  assert.match(agentgw, /networking\.gke\.io\/load-balancer-ip-addresses/, 'GKE needs the annotation as well as loadBalancerIP');
  assert.match(agentgw, /yamlencode\(\{ nodeSelector = local\.system_node_selector \}\)/, 'the controller is pinned to the system pool');
  assert.doesNotMatch(agentgw, /set \{|set = \[/, 'chart values are yamlencoded, not dotted --set paths that can silently miss');
  for (const release of ['agentgateway_crds', 'agentgateway']) {
    const block = agentgw.slice(agentgw.indexOf(`resource "helm_release" "${release}"`));
    assert.match(block.slice(0, 900), /version\s*=\s*var\.agentgateway_version/, `${release} must be version-pinned`);
  }
  assert.match(gkeVars.slice(gkeVars.indexOf('variable "agentgateway_version"')), /default\s*=\s*"v\d+\.\d+\.\d+"/, 'no latest tag');
});

test('the a2a seam is closed by admission, not by a policy', () => {
  // Decision #3: a listener and nothing behind it. `from = "None"` is the
  // strongest available no, because Gateway API enforces it before any
  // credential is examined, and it cannot be undone by a forgotten policy.
  const gateway = agentgw.slice(agentgw.indexOf('resource "kubectl_manifest" "agentgateway_gateway"'));
  const a2a = gateway.slice(gateway.indexOf('name     = "a2a"'));
  assert.match(a2a.slice(0, 600), /from = "None"/, 'no HTTPRoute may attach to the a2a listener');
  assert.doesNotMatch(agentgw, /agentgateway_a2a_route|agentgateway_a2a_deny/, 'no placeholder backend, no agent card');

  // …and the reason stays written down. The seam is one line from being opened
  // (`from = "None"` → `"Same"`), and the case against opening it is a
  // non-obvious one: an actor's address dies with the run, so a card is not
  // merely premature but stale-by-construction. If that prose goes, the flip
  // looks like a formatting change.
  const doc = read('docs', 'SUBSTRATE_INTEGRATION.md');
  const section = doc.slice(doc.indexOf('## 12. A2A'));
  assert.notEqual(section, -1, 'the a2a scope section was deleted while the seam stayed');
  assert.match(section, /the planner/, 'it must name who would publish a card');
  assert.match(section, /allowedRoutes\.namespaces\.from/, 'it must name the line that opens the seam');
  assert.match(section, /suspend|delete/, 'it must say why an actor address cannot back a card');
});

test('the substrate root can hand the sidecar an origin it will accept', () => {
  // Both addresses the outputs print are candidate AGENTGATEWAY_PROXY_UPSTREAM
  // values, and a value normalizeTrustedUpstream refuses is a fail-closed 502 on
  // the first flagged run — with a green apply behind it.
  const clusterOrigin = 'http://agentgateway-proxy.agentgateway-system.svc.cluster.local:80';
  const publicOrigin = 'https://gw.example.com';
  for (const value of [clusterOrigin, publicOrigin]) {
    assert.doesNotMatch(value, /\?|@|#/);
    normalizeTrustedUpstream(value, 'AGENTGATEWAY_PROXY_UPSTREAM');
  }
  // The public origin only exists with a hostname, and the dark default must be
  // the empty one: a front nobody asked for is a second public credential hop.
  assert.match(gkeOutputs, /agentgateway_url[\s\S]*?local\.agentgateway_front \? "https:\/\/\$\{var\.agentgateway_ingress_hostname\}" : null/);
  assert.match(gkeVars.slice(gkeVars.indexOf('variable "agentgateway_enabled"')), /default\s*=\s*false/);
  assert.match(tfvars, /agentgateway_enabled = false/);
});

test('each public front registers itself as an ACME solver parent', () => {
  // The bug this replaces was a hardcoded parentRef naming a Gateway that no
  // longer exists: cert-manager then retries forever and the only symptom is a
  // hostname serving a stale certificate. So the list is built by concat and
  // every front appends itself — including agentgateway.
  assert.match(substrate, /acme_solver_parent_refs = concat\(/);
  assert.match(
    substrate,
    /local\.agentgateway_front \? \[\s*\{ name = var\.agentgateway_gateway_name, namespace = var\.agentgateway_namespace, kind = "Gateway" \},?\s*\] : \[\]/,
    'the gateway front must join the solver parents when it exists',
  );
});
