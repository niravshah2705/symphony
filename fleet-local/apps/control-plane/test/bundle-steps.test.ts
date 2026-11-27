import test from 'node:test';
import assert from 'node:assert/strict';

// config.ts reads BUNDLE_ENABLED at import and every executor checks it, so the flag
// is set before the module graph loads rather than stubbed afterwards.
process.env.BUNDLE_ENABLED = 'true';
process.env.GCP_PROJECT_ID ??= 'fleet-demo';
process.env.GCP_REGION ??= 'us-central1';
process.env.BUNDLE_REPO ??= 'fleet-bundles';
process.env.BUNDLE_STAGE_BUCKET ??= 'fleet-bundle-stage';

const { BUNDLE_STEPS } = await import('@fleet-local/shared');
const { bundleExecutors, runTarget, validateBundleSelection } = await import('../src/bundle/steps.ts');
const { runMachine } = await import('../src/onboarding/machine.ts');

type Executors = Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
type Values = {
  models: { name: string }[];
  harnesses: { name: string; type: string; image?: string; command?: string[] }[];
  templates: { name: string; modelConfig: string }[];
  agents: { name: string; template: string; harness: string }[];
};

const ctx = {
  orgId: 'org-uuid',
  orgSlug: 'demo',
  orgName: 'Demo',
  userId: 'user-uuid',
  userEmail: 'nirav@example.com',
};
const BASE = 'sha256:' + 'a'.repeat(64);
const BUILT = 'sha256:' + 'b'.repeat(64);
const MIRRORED = 'sha256:' + 'c'.repeat(64);

// The model list is part of the document because the merge validates a bundle
// template against it: a modelConfig that names no models[] entry fails the chart's
// referential check, so an empty list must render no template at all.
const liveValues = (): Values => ({
  models: [{ name: 'claude-sonnet' }, { name: 'gpt-mini' }],
  harnesses: [
    { name: 'app', type: 'kagent' },
    { name: 'claude', type: 'claude', image: `ghcr.io/x/claude-harness@${BASE}` },
  ],
  templates: [{ name: 'claude-sonnet-coding', modelConfig: 'claude-sonnet' }],
  agents: [{ name: 'claude-sonnet-worker', template: 'claude-sonnet-coding', harness: 'claude' }],
});

interface Fake {
  created: string[];
  uploaded: string[];
  upgraded: Values[];
  recorded: { runtime: string; image: string; plugins: unknown[] }[];
  pods: string[];
  removed: string[];
  values: Values;
}

function harness(depsOverride: Record<string, unknown> = {}) {
  const f: Fake = { created: [], uploaded: [], upgraded: [], recorded: [], pods: [], removed: [], values: liveValues() };
  const arTargets = {
    gcpProjectId: 'fleet-demo',
    gcpRegion: 'us-central1',
    bundleArRepo: 'fleet-bundles',
    bundleRegistry: 'ar',
    bundlePullHost: '',
  };
  const deps = {
    targets: arTargets,
    resolveBase: async () => BASE,
    // Null until the build has been created: that is what makes `submit` decide
    // between a short-circuit and a POST.
    readAr: async (_path: string, ref: string) => (ref === BUILT || ref.startsWith('sha256:') ? BUILT : f.created.length ? BUILT : null),
    readLocal: async () => null,
    upload: async (object: string) => void f.uploaded.push(object),
    create: async (body: { id: string }) => {
      f.created.push(body.id);
      return { id: body.id, status: 'SUCCESS', results: { images: [{ digest: BUILT }] } };
    },
    get: async (id: string) => ({ id, status: 'SUCCESS', results: { images: [{ digest: BUILT }] } }),
    getValues: async () => f.values,
    upgrade: async (opts: { values: Values }) => void f.upgraded.push(opts.values),
    apply: async (yaml: string) => void f.pods.push(yaml),
    remove: async (kind: string, name: string) => void f.removed.push(`${kind}/${name}`),
    getPod: async () => ({ status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { reason: 'Completed' } } }] } }),
    // Upsert semantics, like bundle_builds: one current image per runtime, so a
    // re-apply converges on the newest build instead of widening the harness list.
    record: async (_orgId: string, build: { runtime: string; image: string; plugins: unknown[] }) => {
      f.recorded = f.recorded.filter((r) => r.runtime !== build.runtime);
      f.recorded.push(build);
    },
    current: async () => f.recorded,
    sleep: async () => {},
    chartPath: '/charts/kagent-tenant',
    modelCatalog: [
      { id: 'claude-sonnet', label: 'Sonnet', model: 'anthropic/claude-sonnet', runtime: 'claude' },
      { id: 'gpt-mini', label: 'Mini', model: 'openai/gpt-4o-mini', runtime: 'other' },
    ],
    pollIntervalMs: 1,
    timeoutMs: 60_000,
    ...depsOverride,
  };
  const executors = bundleExecutors({ runtime: 'claude', plugins: ['graphify'] }, deps as never) as unknown as Executors;
  return { f, deps, executors };
}

/** Replay the steps up to and including `upto`, carrying each result forward. */
async function runThrough(executors: Executors, upto: string, initial: Record<string, Record<string, unknown>> = {}) {
  const results: Record<string, Record<string, unknown>> = { ...initial };
  for (const def of BUNDLE_STEPS) {
    if (def.id === upto) break;
    results[def.id] = await executors[def.id]({ ...ctx, results });
  }
  return results;
}

test('a selection is validated with the status the route forwards', () => {
  const ok = validateBundleSelection({ runtime: 'claude', plugins: ['graphify', 'graphify', ' code-review-graph '] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.entries.map((e) => e.id), ['graphify', 'code-review-graph'], 'a duplicate id is one install, not two');

  assert.deepEqual(
    { ...(validateBundleSelection({ runtime: 'nope', plugins: ['graphify'] }) as object) },
    { ok: false, status: 400, error: 'unknown harness runtime "nope"' },
  );
  assert.equal((validateBundleSelection({ runtime: 'claude', plugins: [] }) as { status: number }).status, 400);

  // gemini has no matrix column, so no pack has ever been graded against it: the
  // answer is a refusal naming the reason, not a build that installs onto a void.
  const noColumn = validateBundleSelection({ runtime: 'gemini', plugins: ['graphify'] }) as { ok: boolean; status: number; error: string };
  assert.equal(noColumn.ok, false);
  assert.equal(noColumn.status, 409);
  assert.match(noColumn.error, /gemini/);
});

test('the run target is the selection, so a re-run resumes instead of forking', () => {
  const a = runTarget({ runtime: 'claude', plugins: ['graphify', 'code-review-graph'] });
  const b = runTarget({ runtime: 'claude', plugins: ['code-review-graph', 'graphify'] });
  assert.match(a, /^claude:[a-f0-9]{12}$/);
  assert.equal(a, b, 'plugin order is not a new build');
  assert.notEqual(a, runTarget({ runtime: 'claude', plugins: ['graphify'] }), 'a different plugin set is a new run');
  assert.notEqual(a, runTarget({ runtime: 'codex', plugins: ['graphify'] }), 'a different base is a new run');
});

test('all nine steps run in order and leave a digest-pinned harness in the release', async () => {
  const { f, executors } = harness();
  const states: Record<string, unknown> = {};
  const { complete } = await runMachine<never>(BUNDLE_STEPS as never, {
    ctx,
    executors: executors as never,
    loadStates: async () => structuredClone(states) as never,
    saveState: async (_org: string, s: { step: string; status: string; result?: Record<string, unknown> }) => {
      states[s.step] = { status: s.status, result: s.result };
    },
    sleep: async () => {},
  } as never);

  assert.ok(complete, 'every step reported done');
  assert.deepEqual(Object.keys(states), BUNDLE_STEPS.map((s) => s.id));
  assert.equal(f.upgraded.length, 1, 'one helm upgrade');
  assert.equal(f.created.length, 1, 'exactly one Cloud Build job for a new key');

  const values = f.upgraded[0];
  assert.deepEqual(values.harnesses.map((h) => h.name), ['app', 'claude', 'bundle-claude'], 'the existing harnesses are untouched');
  const bundle = values.harnesses[2];
  assert.equal(bundle.type, 'claude');
  assert.match(bundle.image ?? '', new RegExp(`@${BUILT.replace(':', ':')}$`), 'the Harness names the digest the registry reported');
  assert.ok(!bundle.command, 'a claude engine carries no workload.command — the chart fails the release otherwise');

  const template = values.templates.find((t) => t.name === 'bundle-claude-coding');
  assert.equal(template?.modelConfig, 'claude-sonnet', 'a claude bundle gets the catalog model that runs on claude');
  assert.equal(values.agents.find((a) => a.name === 'bundle-claude-worker')?.harness, 'bundle-claude');
  assert.equal(f.recorded[0].plugins.length, 1);
  assert.match(f.pods[0], /image: .*@sha256:/, 'the probe pod names a pinned ref');
  assert.equal(f.removed.length, 1, 'the probe pod is deleted even on success');
});

test('apply converges on the stored build instead of stacking a twin', async () => {
  const { f, executors } = harness();
  const results = await runThrough(executors, 'apply');
  await executors.apply({ ...ctx, results });
  // The second apply reads back the release the first one wrote.
  f.values = f.upgraded[0];
  await executors.apply({ ...ctx, results });

  const names = f.upgraded.at(-1)!.harnesses.map((h) => h.name);
  assert.equal(names.filter((n) => n === 'bundle-claude').length, 1, 'a re-apply replaces the entry, it does not append a second');
  assert.equal(f.upgraded.at(-1)!.templates.filter((t) => t.name === 'bundle-claude-coding').length, 1);
  assert.equal(f.upgraded.at(-1)!.agents.filter((a) => a.name === 'bundle-claude-worker').length, 1);
});

test('submit short-circuits when the content-addressed tag already exists', async () => {
  // A tag lookup by name answers the digest of an image that is already there — the
  // whole point of a content-addressed key.
  const { f, executors } = harness({ readAr: async (_p: string, ref: string) => (/^[a-f0-9]{12}$/.test(ref) ? BUILT : null) });
  const results = await runThrough(executors, 'submit');
  const submitted = await executors.submit({ ...ctx, results });
  assert.equal(submitted.skipped, 'published', 'the tag was already readable, so nothing was uploaded or built');
  assert.equal(f.uploaded.length, 0);
  assert.equal(f.created.length, 0);

  const published = await executors.publish({ ...ctx, results: { ...results, submit: submitted } });
  assert.match(published.image as string, new RegExp(`@${BUILT}$`));
});

test('a kind-mode mirror names the host command, and resumes on its own digest', async () => {
  const kindTargets = {
    gcpProjectId: 'fleet-demo',
    gcpRegion: 'us-central1',
    bundleArRepo: 'fleet-bundles',
    bundleRegistry: 'kind',
    bundlePullHost: 'kind-registry:5000',
  };
  const missing = harness({ targets: kindTargets });
  const results = await runThrough(missing.executors, 'mirror');
  await assert.rejects(
    () => missing.executors.mirror({ ...ctx, results }),
    (err: Error) => {
      assert.match(err.message, /bundle-mirror\.sh kind-registry:5000 fleet-demo\/fleet-bundles\/claude-bundle/);
      return true;
    },
    'the refusal carries the copy-pasteable fix',
  );

  // Once the mirror has run, the step reads the LOCAL digest: the retag recomputes
  // the manifest, so carrying the AR digest forward would name an image nobody has.
  const done = harness({ targets: kindTargets, readLocal: async () => MIRRORED });
  const r = await runThrough(done.executors, 'mirror');
  const mirrored = await done.executors.mirror({ ...ctx, results: r });
  assert.equal(mirrored.pullDigest, MIRRORED);
  assert.equal(mirrored.pullRepo, 'kind-registry:5000/fleet-demo/fleet-bundles/claude-bundle');

  const applied = await done.executors.apply({ ...ctx, results: { ...r, mirror: mirrored } });
  assert.match(applied.image as string, new RegExp(`@${MIRRORED}$`));
});

test('verify turns an unpullable image into a named step failure', async () => {
  const { f, executors } = harness({
    getPod: async () => ({
      status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff', message: 'pull access denied' } } }] },
    }),
  });
  const results = await runThrough(executors, 'verify');
  const applied = await executors.apply({ ...ctx, results });
  await assert.rejects(
    () => executors.verify({ ...ctx, results: { ...results, apply: applied } }),
    (err: Error) => {
      assert.match(err.message, /cannot be pulled in org-demo: ImagePullBackOff pull access denied/);
      assert.match(err.message, /roles\/artifactregistry\.reader/, 'the fix is named, not just the failure');
      return true;
    },
  );
  assert.equal(f.removed.length, 1, 'a failed probe still deletes its pod');
});

test('a base image that cannot be resolved pins nothing', async () => {
  const { executors } = harness({ resolveBase: async () => null });
  const plan = await executors.plan({ ...ctx, results: {} });
  await assert.rejects(() => executors.base({ ...ctx, results: { plan } }), /not readable anonymously/);
});

test('a build that reports a different digest than the registry holds is refused', async () => {
  // The tag answers one digest when submit looks it up and another by the time
  // publish reads it back: somebody pushed to it in between, and the Harness must not
  // be written on the answer the build reported.
  let reads = 0;
  const { executors } = harness({
    readAr: async () => (reads++ === 0 ? BUILT : 'sha256:' + 'd'.repeat(64)),
    create: async (body: { id: string }) => ({ id: body.id, status: 'SUCCESS', results: { images: [{ digest: BUILT }] } }),
  });
  const results = await runThrough(executors, 'publish');
  await assert.rejects(
    () => executors.publish({ ...ctx, results }),
    (err: Error) => {
      assert.match(err.message, /refusing to render a Harness on an image nobody verified/);
      return true;
    },
  );
});
