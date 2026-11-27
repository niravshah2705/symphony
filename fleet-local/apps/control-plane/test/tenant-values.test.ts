import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL_CATALOG, QODER_CATALOG_ENTRY, type ModelCatalogEntry } from '@fleet-local/shared';
import {
  buildTenantValues,
  harnessName,
  mergeTenantBundles,
  type BundleHarnessValue,
  type TenantValuesConfig,
} from '../src/onboarding/tenant-values.ts';

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

const bundleImage = `us-central1-docker.pkg.dev/p/r/claude-bundle@sha256:${'c'.repeat(64)}`;
const bundle = (over: Partial<BundleHarnessValue> = {}): BundleHarnessValue => ({
  name: 'bundle-claude',
  type: 'claude',
  image: bundleImage,
  model: catalog[1]?.id ?? catalog[0].id,
  ...over,
});

test('a bundle appends a harness, a template and a worker without touching the catalog objects', () => {
  const before = input();
  const v = input({ bundles: [bundle()] });
  assert.deepEqual(
    v.harnesses.map((h) => h.name),
    [...before.harnesses.map((h) => h.name), 'bundle-claude'],
  );
  const h = v.harnesses.at(-1)!;
  assert.equal(h.type, 'claude');
  assert.ok(!('command' in h), 'a claude engine must carry no workload.command: the chart fails the release');
  assert.deepEqual(h.env?.map((e) => e.name), ['OTEL_PROPAGATORS', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_RESOURCE_ATTRIBUTES']);
  assert.equal(v.templates.at(-1)?.name, 'bundle-claude-coding');
  assert.equal(v.templates.at(-1)?.modelConfig, bundle().model, 'a bundle may name its own model');
  assert.equal(v.agents.at(-1)?.harness, 'bundle-claude');
});

test('a byo bundle carries its adapter command and an unpinned image carries nothing', () => {
  const v = input({ bundles: [bundle({ name: 'bundle-goose', type: 'byo', adapter: '/usr/local/bin/goose-runtime' })] });
  assert.deepEqual(v.harnesses.at(-1)?.command, ['/usr/local/bin/goose-runtime']);

  // The CRD rejects a tag, and it does so after helm has mutated the release, so an
  // unpinned bundle is dropped from every list rather than rendering a broken one.
  const tagged = input({ bundles: [bundle({ image: 'ghcr.io/x/y:1.2.3' })] });
  assert.deepEqual(tagged.harnesses.map((h) => h.name), input().harnesses.map((h) => h.name));
  assert.equal(tagged.templates.some((t) => t.name === 'bundle-claude-coding'), false);
  assert.equal(tagged.agents.some((a) => a.name === 'bundle-claude-worker'), false);

  assert.throws(() => mergeTenantBundles({}, [bundle({ type: 'byo' })], 'org-uuid'), /needs its adapter command/);
});

test('merging onto a live release replaces the bundle entries and nothing else', () => {
  const live = {
    models: [{ name: 'openai-gpt-4o-mini' }, { name: 'claude-sonnet-4-5' }],
    harnesses: [{ name: 'app', type: 'kagent' }, { name: 'bundle-claude', type: 'byo', image: 'old@sha256:' + '0'.repeat(64) }],
    templates: [{ name: 'assistant', modelConfig: 'openai-gpt-4o-mini' }, { name: 'bundle-claude-coding', modelConfig: 'claude-sonnet-4-5' }],
    agents: [{ name: 'assistant', template: 'assistant', harness: 'app' }, { name: 'bundle-claude-worker', template: 'bundle-claude-coding', harness: 'bundle-claude' }],
  };
  const merged = mergeTenantBundles(live, [bundle({ type: 'byo', adapter: '/usr/local/bin/claude-runtime' })], 'org-uuid') as typeof live;
  assert.deepEqual(merged.harnesses.map((h) => h.name), ['app', 'bundle-claude'], 'one entry per bundle, replaced not appended');
  assert.equal(merged.harnesses[1].image, bundleImage, 'the stale image is gone');
  assert.deepEqual(merged.templates.map((t) => t.name), ['assistant', 'bundle-claude-coding']);
  assert.deepEqual(merged.agents.map((a) => a.name), ['assistant', 'bundle-claude-worker']);
});

test('a merge falls back to a model the release has, and renders no template when it has none', () => {
  const live = {
    models: [{ name: 'openai-gpt-4o-mini' }],
    harnesses: [{ name: 'app', type: 'kagent' }],
    templates: [{ name: 'x-coding', modelConfig: 'openai-gpt-4o-mini' }],
    agents: [{ name: 'x-worker', template: 'x-coding', harness: 'app' }],
  };
  const merged = mergeTenantBundles(live, [bundle()], 'org-uuid') as unknown as { templates: { modelConfig: string }[] };
  assert.equal(merged.templates[1].modelConfig, 'openai-gpt-4o-mini', 'a bundle naming a model the release lacks falls back');

  const bare = mergeTenantBundles({ harnesses: [] }, [bundle()], 'org-uuid') as unknown as { harnesses: unknown[]; templates: unknown[]; agents: unknown[] };
  assert.equal(bare.harnesses.length, 1, 'the harness is still pullable infrastructure worth rendering');
  assert.deepEqual([bare.templates, bare.agents], [[], []], 'a template with no ModelConfig to name would fail the chart');
});
