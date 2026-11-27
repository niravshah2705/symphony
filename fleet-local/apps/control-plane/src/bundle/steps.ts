import { createHash } from 'node:crypto';
import { DIGEST_PIN, bundleBase, bundleTarget, type BundleBase, type BundleStepId, type ModelCatalogEntry } from '@fleet-local/shared';
import { config } from '../config.ts';
import { applyManifest, deleteResource, getJson, helmGetValues, helmUpgradeInstall, kubectl } from '../clients/k8s.ts';
import { arDigest, buildId, buildRequest, bundlePackage, bundleTag, createTarGz, ghcrDigest, localDigest, pullRef, pushRef, uploadContext, type BundleTargets, type CloudBuild } from '../clients/gcp.ts';
import { upsertBundleBuild } from '../db/bundle.ts';
import { listBundleBuilds } from '../db/bundle.ts';
import { bundleAgentName, bundleHarnessName, bundlePullProbe, helmRelease, orgNamespace } from '../onboarding/names.ts';
import { mergeTenantBundles } from '../onboarding/tenant-values.ts';
import type { StepExecutor } from '../onboarding/machine.ts';
import { bundleHarnessInputs } from './harness.ts';
import { renderBundleDockerfile, type BundleEntry } from './dockerfile.ts';
import { packById, requirementLines, selectablePackIds } from './plugins.ts';

// The nine executors behind the bundle wizard. Each one is written to be safe to
// re-run: find-or-create against the registry and Cloud Build, never
// create-then-hope. That is what makes a BFF restart in the middle of a ten-minute
// build a resume rather than a second build, so the step pair below is what a
// reviewer should check when touching any of them.
//
// Everything external arrives through BundleDeps. Not for mockery in tests — the
// tests do use it — but because a step that reaches the network through a named
// dependency has to say which dependency it reaches, and a step that imports the
// client singletons hides it.

export interface BundleSelection {
  runtime: string;
  plugins: string[];
}

export interface BundleDeps {
  targets: BundleTargets;
  resolveBase: (repo: string, version: string) => Promise<string | null>;
  readAr: (path: string, ref: string) => Promise<string | null>;
  readLocal: (host: string, path: string, ref: string) => Promise<string | null>;
  upload: (object: string, gzip: Uint8Array<ArrayBuffer>) => Promise<void>;
  create: (body: ReturnType<typeof buildRequest>) => Promise<CloudBuild>;
  get: (id: string) => Promise<CloudBuild | null>;
  getValues: (release: string, namespace: string) => Promise<Record<string, unknown>>;
  upgrade: (opts: { release: string; chart: string; namespace: string; values: Record<string, unknown> }) => Promise<void>;
  apply: (yaml: string) => Promise<void>;
  remove: (kind: string, name: string, namespace: string) => Promise<void>;
  getPod: <T = unknown>(name: string, namespace: string) => Promise<T | undefined>;
  record: typeof upsertBundleBuild;
  current: (orgId: string) => Promise<Awaited<ReturnType<typeof listBundleBuilds>>>;
  sleep: (ms: number) => Promise<void>;
  chartPath: string;
  modelCatalog: readonly ModelCatalogEntry[];
  pollIntervalMs: number;
  timeoutMs: number;
}

export const defaultDeps = (): BundleDeps => ({
  targets: config,
  resolveBase: (repo, version) => ghcrDigest(repo.replace(/^[^/]+\/[^/]+\/[^/]+\//, '') || repo, version),
  readAr: (path, ref) => arDigest(path, ref),
  readLocal: (host, path, ref) => localDigest(host, path, ref),
  upload: uploadContext,
  create: (body) => createBuildSafe(body),
  get: (id) => getBuildSafe(id),
  getValues: helmGetValues,
  upgrade: helmUpgradeInstall,
  apply: applyManifest,
  remove: deleteResource,
  getPod: <T>(name: string, ns: string) => getJson<T>('pod', name, ns),
  record: upsertBundleBuild,
  current: listBundleBuilds,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  chartPath: config.tenantChartPath,
  modelCatalog: config.modelCatalog,
  pollIntervalMs: 15_000,
  timeoutMs: config.bundleBuildTimeoutMs,
});

// Imported lazily by name so the dependency list above stays the module's public
// surface; these two are the only places the GCP client is reached from a step.
async function createBuildSafe(body: ReturnType<typeof buildRequest>) {
  const { createBuild } = await import('../clients/gcp.ts');
  return createBuild(body);
}
async function getBuildSafe(id: string) {
  const { getBuild } = await import('../clients/gcp.ts');
  return getBuild(id);
}

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined || v === null) throw new Error(`${what} is missing: an earlier step did not record it`);
  return v;
};

/** The AR-side registry path the bundle lives at: <project>/<repo>/<package>. */
const arPath = (targets: BundleTargets, runtime: string): string =>
  `${targets.gcpProjectId}/${targets.bundleArRepo}/${bundlePackage(runtime)}`;

/** `sha256:abc` / `abc` / a full `repo@sha256:abc` -> `sha256:<64 hex>`. */
const normalize = (digest: string): string =>
  `sha256:${digest.replace(/^.*?sha256:/, '')}`;

/** The repo:tag-free base a Harness names: `<host>/<project>/<repo>/<package>`. */
const pullRepo = (targets: BundleTargets, runtime: string): string =>
  pullRef(targets, bundlePackage(runtime), '').replace(/:$/, '');

/** What Cloud Build recorded for the build, if it recorded anything. */
async function getBuildDigest(id: string | undefined, deps: BundleDeps): Promise<string | undefined> {
  if (!id) return undefined;
  const build = await deps.get(id);
  return build?.results?.images?.[0]?.digest;
}

/**
 * The durable identity of one selection: `<runtime>:<12 hex of base + plugin ids>`.
 *
 * This is computable before a run starts, which the registry key is not: `key`
 * folds in the base digest, and reading that digest is step two. So the run rows and
 * the Cloud Build id are keyed here, and a re-run of the same selection resumes this
 * machine instead of starting a second one. Two different plugin sets, or a bumped
 * base version in BUNDLE_BASES, are different targets.
 */
export function runTarget(sel: BundleSelection): string {
  const base = bundleBase(sel.runtime);
  const ids = [...new Set(sel.plugins.map((s) => s.trim()).filter(Boolean))].sort();
  const stamp = createHash('sha256')
    .update([base ? `${base.repo}:${base.version}` : sel.runtime, ...ids].join('\0'))
    .digest('hex');
  return bundleTarget(sel.runtime, stamp);
}

/**
 * The pre-flight answer for a selection, shared by the `plan` executor and the
 * route. A route that only let the machine discover the problem would stream 409
 * worth of information as a step failure after opening the response, and a wizard
 * that cannot say "that pack is unsupported here" before pressing Build is a wizard
 * that spends Cloud Build seconds on a refusal.
 */
export type SelectionCheck =
  | { ok: true; base: BundleBase; entries: BundleEntry[] }
  | { ok: false; status: number; error: string };

export function validateBundleSelection(sel: BundleSelection): SelectionCheck {
  const base = bundleBase(sel.runtime);
  if (!base) return { ok: false, status: 400, error: `unknown harness runtime "${sel.runtime}"` };
  if (!config.bundleEnabled) {
    return { ok: false, status: 409, error: 'bundle builds are disabled (set BUNDLE_ENABLED=true)' };
  }
  const ids = [...new Set(sel.plugins.map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `select at least one plugin: a bundle with none is just the ${base.runtime} base image, which the tenant already has`,
    };
  }
  const unknown = ids.filter((id) => !packById(id));
  if (unknown.length) return { ok: false, status: 400, error: `no such pack: ${unknown.join(', ')}` };

  const offerable = new Set(selectablePackIds(base));
  const refused = ids.filter((id) => !offerable.has(id));
  if (refused.length) {
    const why = refused
      .map((id) => {
        const cell = packById(id)!.cells[base.matrixColumn];
        return cell?.status === 'unsupported'
          ? `${id} is unsupported on ${base.runtime} (blocked on ${cell.blockedOn ?? 'a runtime image'})`
          : `${id} declares no support for ${base.runtime}`;
      })
      .join('; ');
    // A refusal here is deliberate: the alternative is a build that installs a
    // pack onto a runtime where its tools cannot work.
    return { ok: false, status: 409, error: `refused: ${why}` };
  }
  const missing = ids.filter((id) => !requirementLines(packById(id)!.requirements, base.family)?.length);
  if (missing.length) {
    return {
      ok: false,
      status: 409,
      error: `${missing.join(', ')} declare no ${base.family} requirement lines, so there is nothing to install on a ${base.family}-based ${base.runtime} image`,
    };
  }
  const entries: BundleEntry[] = ids.map((id) => {
    const pack = packById(id)!;
    return { id: pack.id, version: pack.version, requirements: pack.requirements };
  });
  return { ok: true, base, entries };
}

export function bundleExecutors(sel: BundleSelection, deps: BundleDeps = defaultDeps()): Record<BundleStepId, StepExecutor<BundleStepId>> {

  const plan: StepExecutor<BundleStepId> = async () => {
    const checked = validateBundleSelection(sel);
    if (!checked.ok) throw new Error(checked.error);
    const { base: b, entries } = checked;
    // The registry key cannot be final until the base digest is known, so plan
    // records the selection and the run target it can already commit to.
    return {
      runtime: b.runtime,
      harnessType: b.harnessType,
      plugins: entries.map((e) => ({ id: e.id, version: e.version })),
      target: runTarget(sel),
    };
  };

  const resolveBase: StepExecutor<BundleStepId> = async () => {
    const checked = validateBundleSelection(sel);
    if (!checked.ok) throw new Error(checked.error);
    const b = checked.base;
    const digest = await deps.resolveBase(b.repo, b.version);
    if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`could not resolve ${b.repo}:${b.version} to a digest — the runtime image is not readable anonymously, so no bundle can be pinned to it`);
    }
    return { baseDigest: digest, baseRef: `${b.repo}@${digest}` };
  };

  const generate: StepExecutor<BundleStepId> = async (ctx) => {
    const checked = validateBundleSelection(sel);
    if (!checked.ok) throw new Error(checked.error);
    const baseRes = need(ctx.results.base, 'base');
    const input = { base: checked.base, baseRef: baseRes.baseRef as string, entries: checked.entries };
    const out = renderBundleDockerfile(input);
    if (out.errors.length) throw new Error(`refused to render: ${out.errors.join('; ')}`);
    return { dockerfile: out.dockerfile, dockerfileSha: createHash('sha256').update(out.dockerfile).digest('hex'), key: out.key, tag: bundleTag(out.key), lines: out.lines.length };
  };

  const submit: StepExecutor<BundleStepId> = async (ctx) => {
    const gen = need(ctx.results.generate, 'generate');
    const planRes = need(ctx.results.plan, 'plan');
    const targets = deps.targets;
    const runtime = planRes.runtime as string;
    const tag = gen.tag as string;
    const pushed = pushRef(targets, bundlePackage(runtime), tag);
    const name = arPath(targets, runtime);

    // The short-circuit that makes the wizard re-runnable: if the tag already
    // exists, the content-addressed key says the image is already what was asked
    // for, and no Cloud Build seconds are spent.
    const existing = await deps.readAr(name, tag);
    if (existing) return { skipped: 'published', digest: existing, pushRef: pushed, tag };

    const dockerfile = gen.dockerfile as string;
    const object = `bundles/${runtime}-${tag}.tar.gz`;
    await deps.upload(object, createTarGz([{ name: 'Dockerfile', body: dockerfile }, { name: '.dockerignore', body: 'Dockerfile\n' }]));
    // Same target the run rows are keyed by, so a resumed run re-attaches to the
    // build it started rather than paying for a second one.
    const id = buildId(ctx.orgId, runTarget(sel));
    const body = buildRequest({ id, object, pullRef: pushed, orgId: ctx.orgId, key: gen.key as string });
    const build = await deps.create(body);
    return { buildId: build.id ?? id, pushRef: pushed, tag };
  };

  const poll: StepExecutor<BundleStepId> = async (ctx) => {
    const sub = need(ctx.results.submit, 'submit');
    if (sub.skipped) return { skipped: sub.skipped as string };
    const id = need(sub.buildId as string, 'build id');
    const deadline = Date.now() + deps.timeoutMs;
    for (;;) {
      const build = await deps.get(id);
      if (!build) throw new Error(`build ${id} is not visible in ${deps.targets.gcpProjectId}: it may have been deleted, so this run cannot conclude`);
      if (build.status === 'SUCCESS') return { status: build.status };
      if (['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED'].includes(build.status)) {
        throw new Error(`build ${id} ${build.status}: ${build.errorMessage ?? build.logsUrl ?? 'no detail'}`);
      }
      if (Date.now() > deadline) throw new Error(`build ${id} still ${build.status} after ${Math.round(deps.timeoutMs / 60000)} minutes — the wizard retries this step, it does not cancel the build`);
      await deps.sleep(deps.pollIntervalMs);
    }
  };

  const publish: StepExecutor<BundleStepId> = async (ctx) => {
    const sub = need(ctx.results.submit, 'submit');
    const planRes = need(ctx.results.plan, 'plan');
    const runtime = planRes.runtime as string;
    const tag = need(sub.tag as string, 'tag');
    const name = arPath(deps.targets, runtime);

    // Ask the registry, not the build: a build's reported digest and the digest a
    // client resolves for the tag can disagree when a later push moved the tag, and
    // the Harness has to name the one the nodes will get.
    const digest = await deps.readAr(name, tag);
    if (!digest) throw new Error(`build succeeded but ${name}:${tag} is not readable in Artifact Registry`);
    const claimed = sub.skipped ? (sub.digest as string) : (await getBuildDigest(sub.buildId as string, deps));
    if (claimed && normalize(claimed) !== normalize(digest)) {
      throw new Error(`${name}:${tag} resolves to ${digest}, not the ${claimed} this build reported — refusing to render a Harness on an image nobody verified`);
    }
    const image = `${pullRepo(deps.targets, runtime)}@${normalize(digest)}`;
    if (!DIGEST_PIN.test(image)) throw new Error(`bundle image ${image} is not digest-pinned`);
    return { image, pullRepo: pullRepo(deps.targets, runtime), digest: normalize(digest), tag, name };
  };

  const mirror: StepExecutor<BundleStepId> = async (ctx) => {
    const pub = need(ctx.results.publish, 'publish');
    const planRes = need(ctx.results.plan, 'plan');
    const runtime = planRes.runtime as string;
    const tag = pub.tag as string;
    if (deps.targets.bundleRegistry === 'ar') {
      // The AR ref the build pushed is already what an internet-facing node pulls.
      return { skipped: 'not-needed', pullRepo: pub.pullRepo as string, pullDigest: pub.digest as string };
    }
    // In kind mode the nodes have no GCP identity, so the Harness must name the
    // local registry — and its digest is a different string than AR's, because a
    // single-platform retag recomputes the manifest. Read it back, never carry it.
    const host = deps.targets.bundlePullHost;
    const path = arPath(deps.targets, runtime);
    const digest = await deps.readLocal(host, path, tag);
    if (digest) return { pullRepo: `${host}/${path}`, pullDigest: normalize(digest), mirrored: true };
    // Not a silent fallback: the mirror is a host-side docker operation the BFF
    // image cannot perform (no docker binary), so the step names the exact command
    // and a retry after running it resumes here with the digest read back.
    throw new Error(
      `${host}/${path}:${tag} is not in the local registry. Mirror it on the docker host, then retry:\n` +
        `  fleet-local/scripts/bundle-mirror.sh ${host} ${path} ${tag} ${deps.targets.gcpRegion}`,
    );
  };

  const apply: StepExecutor<BundleStepId> = async (ctx) => {
    const mir = need(ctx.results.mirror, 'mirror');
    const planRes = need(ctx.results.plan, 'plan');
    const gen = need(ctx.results.generate, 'generate');
    const baseRes = need(ctx.results.base, 'base');
    const runtime = planRes.runtime as string;
    const image = `${need(mir.pullRepo as string, 'mirror pull repo')}@${need(mir.pullDigest as string, 'mirror digest')}`;
    if (!DIGEST_PIN.test(image)) throw new Error(`refusing to render ${image}: a Harness image must be digest-pinned`);

    // The DB is the source of truth for what the tenant's harness list contains, so
    // the write happens first and the merge reads it back. A re-apply therefore
    // converges the release onto the stored state instead of accumulating entries,
    // and a plain re-onboard reproduces every bundle without replaying a build.
    await deps.record(ctx.orgId, {
      runtime,
      image,
      baseDigest: baseRes.baseDigest as string,
      plugins: planRes.plugins as { id: string; version: string }[],
      dockerfileSha: gen.dockerfileSha as string,
      bundleKey: gen.key as string,
    });

    // Read-modify-write rather than a full re-render: only the workflow step owns
    // the project id and Secret name, and a bundle build has no business rewriting
    // the parts of the release it did not come to change.
    const ns = orgNamespace(ctx.orgSlug);
    const release = helmRelease(ctx.orgSlug);
    const live = await deps.getValues(release, ns);
    const values = mergeTenantBundles(
      live,
      bundleHarnessInputs(await deps.current(ctx.orgId), deps.modelCatalog),
      ctx.orgId,
    );
    await deps.upgrade({ release, chart: deps.chartPath, namespace: ns, values });
    return { release, namespace: ns, image, harness: bundleHarnessName(runtime), agent: bundleAgentName(ctx.orgSlug, runtime) };
  };

  const verify: StepExecutor<BundleStepId> = async (ctx) => {
    const applied = need(ctx.results.apply, 'apply');
    const ns = applied.namespace as string;
    const image = applied.image as string;
    const pod = bundlePullProbe(ctx.orgSlug, String(need(ctx.results.generate, 'generate').key ?? ''));
    // The command is overridden to a no-op on purpose: what this step proves is that
    // a node can pull and start the ref, not that the adapter can serve a session —
    // an entrypoint left running would hold the probe in Pending until the deadline.
    // A bundle whose image cannot even run /bin/sh fails as a start error below.
    await deps.apply(
      [
        'apiVersion: v1',
        'kind: Pod',
        'metadata:',
        `  name: ${pod}`,
        `  namespace: ${ns}`,
        '  labels:',
        `    fleet.local/bundle: ${bundleHarnessName(String(need(ctx.results.plan, 'plan').runtime))}`,
        'spec:',
        '  restartPolicy: Never',
        '  activeDeadlineSeconds: 120',
        '  containers:',
        '    - name: probe',
        `      image: ${image}`,
        '      command: ["/bin/sh", "-c", "exit 0"]',
        '  securityContext:',
        '    runAsUser: 65532',
        '    runAsGroup: 65532',
      ].join('\n'),
    );
    const pullFailures = ['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'ErrImagePullNever'];
    const deadline = Date.now() + 180_000;
    let outcome = '';
    try {
      for (;;) {
        const p = await deps.getPod<{ status?: { phase?: string; containerStatuses?: { state?: Record<string, { reason?: string; message?: string }> }[] } }>(pod, ns);
        const waiting = p?.status?.containerStatuses?.[0]?.state?.waiting;
        if (waiting && pullFailures.includes(waiting.reason ?? '')) {
          throw new Error(
            `${image} cannot be pulled in ${ns}: ${waiting.reason} ${waiting.message ?? ''}`.trim() +
              (deps.targets.bundleRegistry === 'kind'
                ? ''
                : ' — the repo needs roles/artifactregistry.reader granted to allUsers, since a node has no GCP identity here'),
          );
        }
        // A reason that is not a pull failure means the image arrived and something
        // about starting it did not — a missing entrypoint binary, an unpullable
        // platform. Naming it separately keeps the fix from looking like a registry
        // problem.
        if (waiting && ['CreateContainerError', 'CreateContainerConfigError', 'RunContainerError'].includes(waiting.reason ?? '')) {
          throw new Error(`${image} pulled but did not start in ${ns}: ${waiting.reason} ${waiting.message ?? ''}`.trim());
        }
        const term = p?.status?.containerStatuses?.[0]?.state?.terminated;
        if (p?.status?.phase === 'Succeeded' || term) {
          outcome = p?.status?.phase ?? term?.reason ?? 'terminated';
          break;
        }
        if (Date.now() > deadline) throw new Error(`${image}: no pull verdict within 180s in ${ns} (phase ${p?.status?.phase ?? 'unknown'})`);
        await deps.sleep(3_000);
      }
    } finally {
      await deps.remove('pod', pod, ns).catch(() => undefined);
    }
    return { pulled: true, outcome, pod };
  };

  return { plan, base: resolveBase, generate, submit, poll, publish, mirror, apply, verify };
}
