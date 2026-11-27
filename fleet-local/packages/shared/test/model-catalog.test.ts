import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL_CATALOG,
  DIGEST_PIN,
  QODER_CATALOG_ENTRY,
  parseModelCatalog,
  withQoderCatalog,
} from '../src/index.ts';

const digest = `ghcr.io/niravshah2705/symphony/qoder-runtime@sha256:${'3'.repeat(64)}`;

test('parseModelCatalog accepts the qoder runtime and keeps experimental', () => {
  const catalog = parseModelCatalog(
    JSON.stringify([
      { id: 'mock', label: 'Mock', model: 'mock-gpt', default: true },
      { id: 'qoder', label: 'Qoder', model: 'openrouter/qwen/qwen3.8-flash', runtime: 'qoder', experimental: true },
    ]),
  );
  assert.equal(catalog[1]?.runtime, 'qoder');
  assert.equal(catalog[1]?.experimental, true);
});

test('parseModelCatalog rejects an unknown runtime, naming all four', () => {
  assert.throws(
    () => parseModelCatalog(JSON.stringify([{ id: 'x', label: 'X', model: 'm', runtime: 'opencode' }])),
    /runtime must be kagent\|claude\|codex\|qoder/,
  );
});

test('parseModelCatalog rejects a non-boolean experimental flag', () => {
  assert.throws(
    () => parseModelCatalog(JSON.stringify([{ id: 'x', label: 'X', model: 'm', experimental: 'yes' }])),
    /experimental must be a boolean/,
  );
});

test('the shipped catalog does not carry qoder by default', () => {
  assert.equal(
    DEFAULT_MODEL_CATALOG.some((m) => m.runtime === 'qoder'),
    false,
  );
  assert.equal(QODER_CATALOG_ENTRY.runtime, 'qoder');
  // Not experimental: the BYO canary passed, so the row is offered in the chat picker
  // and a new tenant's onboarding waits on its agent like every other runtime.
  assert.equal(QODER_CATALOG_ENTRY.experimental, undefined);
});

test('withQoderCatalog appends only when an image is configured', () => {
  const base = [...DEFAULT_MODEL_CATALOG];
  assert.equal(withQoderCatalog(base, ''), base);
  const withQ = withQoderCatalog(base, digest);
  assert.equal(withQ.length, base.length + 1);
  assert.equal(withQ.at(-1)?.runtime, 'qoder');
  // Appending must not mutate the caller's array or the shared entry.
  assert.equal(base.length, 5);
  withQ.at(-1)!.label = 'mutated';
  assert.notEqual(QODER_CATALOG_ENTRY.label, 'mutated');
});

test('an explicit qoder row in FLEET_MODELS wins over the appended one', () => {
  const custom = [{ id: 'qoder', label: 'My Qoder', model: 'openrouter/qwen/other', runtime: 'qoder' as const }];
  assert.deepEqual(withQoderCatalog(custom, digest), custom);
});

test('DIGEST_PIN accepts a manifest digest and refuses a tag', () => {
  assert.equal(DIGEST_PIN.test(digest), true);
  assert.equal(DIGEST_PIN.test('ghcr.io/niravshah2705/symphony/qoder-runtime:latest'), false);
  assert.equal(DIGEST_PIN.test('qoder-runtime@sha256:abc'), false);
});
