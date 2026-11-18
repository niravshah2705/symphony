'use strict';

// OPT-IN live spec: deploys the sample kagent Harness/Agent into a real per-tenant
// GKE atespace and drives ONE turn whose LLM egress is routed through the
// self-hosted LiteLLM gateway (X-AI-Fleet-Llm-Gateway: litellm).
//
// This is NOT part of default CI. It skips unless every input below is present:
//   KAGENT_LIVE=1                       explicit operator opt-in
//   KAGENT_API_URL=<https origin>       the substrate/kagent API server
//   KAGENT_NAMESPACE=<tenant ns>        e.g. tenant-acme (an existing atespace)
//   KAGENT_ORG_ID=<org uuid>            tenant org whose vault holds litellmApiKey
//   GATEWAY_URL=<https origin>          the fleet gateway that accepts chat turns
//   GATEWAY_TOKEN=<bearer>              a browser/tenant token for that gateway
//   LITELLM_API_KEY_MINTED=1            operator asserts litellmApiKey is seeded
//
// On an ephemeral-Postgres wipe the per-org virtual key is invalidated, so a litellm
// run fails closed (proxy 502) until it is re-minted — that is expected, not a bug in
// the sample. See docs/LLM_GATEWAY.md "Deploy a sample kagent harness in a tenant".

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, expect } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..');
const SAMPLE_MANIFEST = path.join(
  REPO_ROOT,
  'deploy/gcp/terraform-substrate-gke/examples/kagent-litellm-harness.yaml',
);

function present(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim() !== '';
}

const ENABLED = process.env.KAGENT_LIVE === '1'
  && ['KAGENT_API_URL', 'KAGENT_NAMESPACE', 'KAGENT_ORG_ID', 'GATEWAY_URL', 'GATEWAY_TOKEN']
    .every(present)
  && process.env.LITELLM_API_KEY_MINTED === '1';

test.describe('kagent LiteLLM tenant harness (live, opt-in)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!ENABLED, 'set KAGENT_LIVE=1 + cluster/gateway env + LITELLM_API_KEY_MINTED=1 to run');

  const ns = () => process.env.KAGENT_NAMESPACE.trim();

  test('the sample manifest applies into the tenant atespace', () => {
    // kubectl apply is idempotent; --dry-run=server would not prove the CRD accepts it.
    execFileSync('kubectl', ['apply', '-n', ns(), '-f', SAMPLE_MANIFEST], { stdio: 'pipe' });
    const out = execFileSync(
      'kubectl',
      ['get', 'agents.api.kagent.dev', '-n', ns(), '-o', 'jsonpath={.items[*].metadata.name}'],
      { encoding: 'utf8' },
    );
    expect(out).toContain('acme-coding');
  });

  test('a litellm-flagged turn reaches the gateway through the sidecar', async ({ request }) => {
    const base = process.env.GATEWAY_URL.trim().replace(/\/+$/, '');
    const res = await request.post(`${base}/api/agent/run`, {
      headers: {
        authorization: `Bearer ${process.env.GATEWAY_TOKEN.trim()}`,
        'x-ai-fleet-llm-gateway': 'litellm',
        'x-ai-fleet-org-id': process.env.KAGENT_ORG_ID.trim(),
      },
      data: { agentId: 'acme-coding', prompt: 'Reply with the single word: pong' },
    });
    // 502 here means the ephemeral-Postgres wiped the virtual key: re-mint litellmApiKey.
    expect(res.status(), await res.text()).toBeLessThan(500);
    const body = await res.json();
    expect(body).toBeTruthy();
  });
});
