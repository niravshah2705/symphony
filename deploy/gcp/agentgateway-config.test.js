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
