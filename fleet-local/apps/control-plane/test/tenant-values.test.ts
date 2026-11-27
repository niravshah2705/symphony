import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL_CATALOG, QODER_CATALOG_ENTRY, type ModelCatalogEntry } from '@fleet-local/shared';
import { buildTenantValues, harnessName, qoderJobTokenPlaceholder, QODER_TOKEN_PLACEHOLDER, QODER_TOKEN_PLACEHOLDER_ENV, type TenantValuesConfig } from '../src/onboarding/tenant-values.ts';

const digest = `ghcr.io/niravshah2705/symphony/qoder-runtime@sha256:${'a'.repeat(64)}`;
const claudeDigest = `ghcr.io/niravshah2705/symphony/claude-runtime@sha256:${'b'.repeat(64)}`;
const cfg = (over: Partial<TenantValuesConfig> = {}): TenantValuesConfig => ({
  snapshotRoot: 's3://ate-snapshots',
  litellmUrl: 'http://litellm.litellm.svc.cluster.local:4000',
  qoderRuntimeImage: digest,
  qoderAdapterCommand: '/usr/local/bin/qoder-runtime',
  qoderApiKeyEnv: 'QODER_API_KEY',
  qoderBearerOrigins: ['https://openapi.qoder.sh', 'https://center.qoder.sh'],
  qoderGrantOrigins: ['https://*.qoder.sh'],
  qoderModelBaseUrl: 'https://api.qoder.sh',
  customClaudeImage: claudeDigest,
  ...over,
});
const catalog: ModelCatalogEntry[] = [...DEFAULT_MODEL_CATALOG, { ...QODER_CATALOG_ENTRY }];
const input = (over: Partial<Parameters<typeof buildTenantValues>[0]> = {}) =>
  buildTenantValues({
    orgId: 'org-uuid',
    orgSlug: 'demo',
    projectId: 'proj-uuid',
    secretName: 'litellm-demo-default',
    catalog,
    cfg: cfg(),
    ...over,
  });

test('the qoder agent binds a byo harness carrying the pinned image and command', () => {
  const v = input();
  const harness = v.harnesses.find((h) => h.name === 'qoder');
  assert.ok(harness, 'qoder harness missing');
  assert.equal(harness.type, 'byo');
  assert.match(harness.image ?? '', /@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(harness.command, ['/usr/local/bin/qoder-runtime']);
  assert.equal(v.agents.find((a) => a.name === 'qoder-worker')?.harness, 'qoder');
  assert.equal(harnessName('qoder'), 'qoder');
});

// The Qoder agent dials Qoder itself. LiteLLM is out of the path, and the tenant's
// credential never enters the release: it is named as a Secret reference the egress
// gateway substitutes per call.
test('the qoder model config points at the Qoder endpoint with a Secret reference', () => {
  const v = input();
  const model = v.models.find((m) => m.name === 'qoder');
  assert.equal(model?.baseUrl, 'https://api.qoder.sh');
  assert.equal(model?.provider, 'OpenAI');
  assert.equal(model?.apiFormat, 'chatCompletions');
  assert.equal(model?.model, 'qwen3.8-flash');
  assert.equal(model?.apiKeySecret, 'litellm-demo-default');
  assert.equal(model?.apiKeySecretKey, 'QODER_API_KEY');
  assert.equal(model?.defaultHeaders?.['x-fleet-org-id'], 'org-uuid');
});

test('the credential is substituted at the gateway, never written into the release', () => {
  const v = input();
  assert.equal(v.egress.length, 1);
  const policy = v.egress[0];
  assert.equal(policy.name, 'qoder');
  // kagent requires an exact origin for authentication, so only the hosts that send
  // `Bearer <job token>` carry the credential. The model hosts send a locally-derived
  // `Bearer COSY.<envelope>` instead, so they are granted without authentication —
  // substituting over a signature is what breaks the turn.
  const auth = (key: string) => ({
    header: 'authorization',
    prefix: 'Bearer ',
    secretRef: { name: 'litellm-demo-default', key },
  });
  assert.deepEqual(policy.destinations, [
    { origin: 'https://openapi.qoder.sh', authentication: auth('QODER_API_KEY') },
    { origin: 'https://center.qoder.sh', authentication: auth('QODER_API_KEY') },
    { origin: 'https://*.qoder.sh' },
  ]);
  assert.equal(v.agents.find((a) => a.name === 'qoder-worker')?.egress?.join(','), 'qoder');

  // The runtime needs *a* token to put in its header; the gateway swaps the
  // placeholder for the Secret's value outside the sandbox.
  const harness = v.harnesses.find((h) => h.name === 'qoder');
  assert.deepEqual(
    (harness?.env ?? []).find((e) => e.name === QODER_TOKEN_PLACEHOLDER_ENV),
    { name: QODER_TOKEN_PLACEHOLDER_ENV, value: qoderJobTokenPlaceholder() },
  );
  assert.equal(QODER_TOKEN_PLACEHOLDER, 'kagent-egress-placeholder');
  for (const name of ['QODER_API_KEY', 'QODER_PAT', 'QODER_REFRESH_TOKEN']) {
    assert.equal(
      (harness?.env ?? []).some((e) => e.name === name),
      false,
      `Harness spec.env has no valueFrom: ${name} there is plaintext in the release`,
    );
  }
});

test('a bearer origin that is also in the grant list is authenticated once', () => {
  const v = input({
    cfg: cfg({
      qoderBearerOrigins: ['https://openapi.qoder.sh', 'https://openapi.qoder.sh'],
      qoderGrantOrigins: ['https://openapi.qoder.sh', 'https://*.qoder.sh'],
    }),
  });
  assert.deepEqual(
    v.egress[0].destinations.map((d) => d.origin),
    ['https://openapi.qoder.sh', 'https://*.qoder.sh'],
  );
});

test('a qoder catalog entry with no image renders no qoder objects', () => {
  const v = input({ cfg: cfg({ qoderRuntimeImage: '' }) });
  for (const list of ['harnesses', 'models', 'templates', 'agents', 'egress'] as const) {
    assert.equal(
      v[list].some((e) => JSON.stringify(e).includes('qoder')),
      false,
      `${list} still mentions qoder`,
    );
  }
  // The rest of the tenant is untouched by the switch.
  assert.equal(v.agents.length, DEFAULT_MODEL_CATALOG.length);
  assert.equal(v.harnesses.map((h) => h.name).join(','), 'app,claude,codex,custom-claude');
});

// The custom-claude harness arrives from main (#361), where it was rendered
// inline in the workflow step. It lives here now, so onboarding and a sync run
// still render it: an org that loses it cannot start its existing custom agents.
test('custom-claude is always rendered, on the digest-pinned fleet image', () => {
  const v = input();
  const harness = v.harnesses.find((h) => h.name === 'custom-claude');
  assert.equal(harness?.type, 'claude');
  assert.equal(harness?.image, claudeDigest);
  assert.deepEqual(harness?.env, v.harnesses.find((h) => h.name === 'app')?.env);
});

test('an empty CUSTOM_CLAUDE_IMAGE renders no custom-claude harness', () => {
  const v = input({ cfg: cfg({ customClaudeImage: '' }) });
  assert.equal(v.harnesses.some((h) => h.name === 'custom-claude'), false);
  assert.equal(v.harnesses.map((h) => h.name).join(','), 'app,claude,codex,qoder');
});

test('the other runtimes render exactly as before', () => {
  const v = input();
  assert.deepEqual(v.models.find((m) => m.name === 'nemotron-claude'), { name: 'nemotron-claude', provider: 'Anthropic', model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free' });
  assert.equal(v.models.find((m) => m.name === 'nemotron-codex')?.apiFormat, 'responses');
  assert.equal(v.models.find((m) => m.name === 'mock')?.defaultHeaders?.['x-fleet-org-id'], 'org-uuid');
  assert.equal(v.agents.find((m) => m.name === 'mock-worker')?.harness, 'app');
  assert.equal(v.tenant.snapshotRoot, 's3://ate-snapshots/demo');
  assert.equal(v.namespace, 'org-demo');
  assert.deepEqual(v.commonLabels, { 'fleet.local/org-id': 'org-uuid', 'fleet.local/project-id': 'proj-uuid' });
});
