// The single mapping from a stored bundle build to a tenant values entry.
//
// Both writers need it: the bundle wizard's `apply` step merges into the live
// release, and onboarding's workflow step re-renders the whole document. If they
// derived the entry separately, a re-onboard could change the engine of a harness
// the owner had running.
//
// The engine and adapter are not stored columns. They come from BUNDLE_BASES by
// runtime, because that table is what pinned the base image the build started
// from; `bundle_builds` records which image resulted.
import { bundleAdapter, bundleBase } from '@fleet-local/shared';
import type { ModelCatalogEntry } from '@fleet-local/shared';
import { bundleHarnessName } from '../onboarding/names.ts';
import type { BundleHarnessValue } from '../onboarding/tenant-values.ts';

export interface BuildImageRow {
  runtime: string;
  image: string;
}

export function bundleHarnessInputs(
  builds: readonly BuildImageRow[],
  catalog: readonly ModelCatalogEntry[] = [],
): BundleHarnessValue[] {
  return builds.flatMap((b) => {
    // A runtime the table no longer names is skipped rather than guessed at: the
    // chart's engine enum is exactly kagent|codex|claude|byo, and `byo` without an
    // adapter command cannot be rendered at all.
    const base = bundleBase(b.runtime);
    if (!base) return [];
    // Prefer a catalog model that runs on this harness: a claude bundle pointed at
    // an OpenAI-wire ModelConfig talks to LiteLLM in a shape the adapter rejects.
    const model = catalog.find((m) => m.runtime === base.runtime)?.id ?? catalog[0]?.id;
    return [{ name: bundleHarnessName(b.runtime), type: base.harnessType, image: b.image, adapter: bundleAdapter(base), model }];
  });
}
