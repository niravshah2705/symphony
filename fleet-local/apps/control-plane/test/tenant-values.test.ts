import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL_CATALOG, QODER_CATALOG_ENTRY, type ModelCatalogEntry } from '@fleet-local/shared';
import { buildTenantValues, harnessName, type TenantValuesConfig } from '../src/onboarding/tenant-values.ts';

const digest = `ghcr.io/niravshah2705/symphony/qoder-runtime@sha256:${'a'.repeat(64)}`;
const claudeDigest = `ghcr.io/niravshah2705/symphony/claude-runtime@sha256:${'b'.repeat(64)}`;
const cfg = (over: Partial<TenantValuesConfig> = {}): TenantValuesConfig => ({
  snapshotRoot: 's3://ate-snapshots',
  litellmUrl: 'http://litellm.litellm.svc.cluster.local:4000',
  qoderRuntimeImage: digest,
  qoderAdapterCommand: '/usr/local/bin/qoder-runtime',
  qoderApiKeyEnv: 'QODER_API_KEY',
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

test('the qoder credential travels as a Secret reference, never as harness env', () => {
  const v = input();
  const model = v.models.find((m) => m.name === 'qoder');
  assert.equal(model?.apiKeySecret, 'litellm-demo-default');
  assert.equal(model?.apiKeySecretKey, 'QODER_API_KEY');
  assert.equal(model?.provider, 'OpenAI');
  assert.equal(model?.apiFormat, 'chatCompletions');
  assert.equal(model?.model, 'openrouter/qwen/qwen3.8-flash');
  const harness = v.harnesses.find((h) => h.name === 'qoder');
  assert.equal(
    (harness?.env ?? []).some((e) => e.name === 'QODER_API_KEY'),
    false,
    'Harness spec.env has no valueFrom: a key there is plaintext in the release',
  );
  assert.deepEqual(
    (harness?.env ?? []).find((e) => e.name === 'QODER_SDK_CUSTOM_BASE_URL_BYOK'),
    { name: 'QODER_SDK_CUSTOM_BASE_URL_BYOK', value: '1' },
  );
});

test('a qoder catalog entry with no image renders no qoder objects', () => {
  const v = input({ cfg: cfg({ qoderRuntimeImage: '' }) });
  for (const list of ['harnesses', 'models', 'templates', 'agents'] as const) {
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
