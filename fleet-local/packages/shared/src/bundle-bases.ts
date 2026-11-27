// Bundle bases: which runtime image a plugin bundle can be built on top of.
//
// This table is checked in rather than read from go/harness/runtime-images.csv
// because the BFF image ships only the fleet-local workspace plus helm and
// kubectl (deploy/bff/Dockerfile) — the CSV, the Go module and the shared-core
// JSON catalogs are not on that filesystem. bundle-bases.test.ts cross-checks
// every row against the CSV when the checkout has it, so the copy cannot drift
// silently; a row that no longer matches its `current: true` line fails there.
//
// The four fields that are load-bearing for a build:
//   family        a requirement line written for `apt-get` does not run on an
//                 alpine base, and vice versa. This is what selects between a
//                 pack's `dockerfile` and `dockerfileAlpine` arrays.
//   harnessType   the chart's `Harness.spec` engine enum (values.yaml). claude
//                 and codex are native engines; every other runtime reaches the
//                 cluster as `byo`, which requires workload.command.
//   adapter       that command, for the `byo` rows only.
//   dispatchable  false means kagent has no `spec.<runtime>` key and no
//                 controller translator yet (docs/RUNTIME_IMAGES.md), so the
//                 image can be built and referenced but a turn will not run on
//                 it. The wizard shows those rows as buildable, not runnable.

export type PkgFamily = 'apk' | 'apt';

/** The engine the tenant chart knows how to render. */
export type BundleHarnessType = 'claude' | 'codex' | 'byo';

export interface BundleBase {
  /** The `runtime` column of go/harness/runtime-images.csv. */
  runtime: string;
  /** The `dockerfile` column: the build that produces this base. */
  dockerfile: string;
  label: string;
  /** Image repository, without a tag or digest. */
  repo: string;
  /** The pinned `version` of the current row; resolved to a digest at build time. */
  version: string;
  family: PkgFamily;
  harnessType: BundleHarnessType;
  /** workload.command, required for a `byo` harness and illegal otherwise. */
  adapter?: string;
  /** The plugin-catalog matrix column whose cells decide pack reachability. */
  matrixColumn: string;
  dispatchable: boolean;
}

// All ten `current: true` rows. claude and codex are the two alpine bases
// (go/harness/{claude,codex}/Dockerfile: FROM alpine:${ALPINE_VERSION}); the
// rest are Debian or Ubuntu derivatives (python:3.14-slim, node:22-slim,
// ubuntu:24.04). Every one ends USER 65532:65532 + WORKDIR /data with the
// adapter as its entrypoint, which the generated Dockerfile has to restore.
export const BUNDLE_BASES: readonly BundleBase[] = [
  { runtime: 'claude', dockerfile: 'go/harness/claude/Dockerfile', label: 'Claude Code', repo: 'ghcr.io/niravshah2705/symphony/claude-runtime', version: '2.1.326', family: 'apk', harnessType: 'claude', matrixColumn: 'claude', dispatchable: true },
  { runtime: 'codex', dockerfile: 'go/harness/codex/Dockerfile', label: 'Codex', repo: 'ghcr.io/niravshah2705/symphony/codex-runtime', version: '0.169.0', family: 'apk', harnessType: 'codex', matrixColumn: 'codex', dispatchable: true },
  { runtime: 'qoder', dockerfile: 'go/harness/qoder/Dockerfile', label: 'Qoder', repo: 'ghcr.io/niravshah2705/symphony/qoder-runtime', version: '1.1.92', family: 'apt', harnessType: 'byo', adapter: '/usr/local/bin/qoder-runtime', matrixColumn: 'qodercli', dispatchable: true },
  { runtime: 'deepagent', dockerfile: 'go/harness/deepagent/Dockerfile', label: 'Deep Agent', repo: 'ghcr.io/niravshah2705/symphony/deepagent-runtime', version: '0.2.9', family: 'apt', harnessType: 'byo', adapter: '/usr/local/bin/deepagent-runtime', matrixColumn: 'deepagent', dispatchable: false },
  { runtime: 'deepseek', dockerfile: 'go/harness/deepseek/Dockerfile', label: 'DeepSeek', repo: 'ghcr.io/niravshah2705/symphony/deepseek-runtime', version: '0.2.2-rc.4', family: 'apt', harnessType: 'byo', adapter: '/usr/local/bin/deepseek-runtime', matrixColumn: 'dsh', dispatchable: false },
  { runtime: 'opencode', dockerfile: 'go/harness/opencode/Dockerfile', label: 'OpenCode', repo: 'ghcr.io/niravshah2705/symphony/opencode-runtime', version: '1.19.6', family: 'apt', harnessType: 'byo', adapter: '/usr/local/bin/opencode-runtime', matrixColumn: 'opencode', dispatchable: false },
  { runtime: 'gemini', dockerfile: 'go/harness/gemini/Dockerfile', label: 'Gemini', repo: 'ghcr.io/niravshah2705/symphony/gemini-runtime', version: '0.68.0', family: 'apt', harnessType: 'byo', adapter: '/usr/local/bin/gemini-runtime', matrixColumn: '', dispatchable: false },
  { runtime: 'pi', dockerfile: 'go/harness/pi/Dockerfile', label: 'Pi', repo: 'ghcr.io/niravshah2705/symphony/pi-runtime', version: '1.5.2', family: 'apt', harnessType: 'byo', adapter: '/usr/local/bin/pi-runtime', matrixColumn: 'pi', dispatchable: false },
  { runtime: 'kilo', dockerfile: 'go/harness/kilo/Dockerfile', label: 'Kilo', repo: 'ghcr.io/niravshah2705/symphony/kilo-runtime', version: '7.8.27', family: 'apt', harnessType: 'byo', adapter: '/usr/local/bin/kilo-runtime', matrixColumn: '', dispatchable: false },
  { runtime: 'goose', dockerfile: 'go/harness/goose/Dockerfile', label: 'Goose', repo: 'ghcr.io/niravshah2705/symphony/goose-runtime', version: '1.60.1', family: 'apt', harnessType: 'byo', adapter: '/usr/local/bin/goose-runtime', matrixColumn: '', dispatchable: false },
];

export function bundleBase(runtime: string): BundleBase | undefined {
  return BUNDLE_BASES.find((b) => b.runtime === runtime);
}

// The image the Harness CR gets is pinned by digest because the CRD rejects a
// tag (DIGEST_PIN); the adapter path is uniform across the runtime images, so a
// base without an explicit adapter is addressed at <repo> basename convention.
export const bundleAdapter = (base: BundleBase): string =>
  base.adapter ?? `/usr/local/bin/${base.runtime}-runtime`;

// The run machine's step list for one bundle build. `mirror` is a no-op that
// reports skipped unless the deployment asked for a local registry copy, and
// `verify` is the only step that proves the cluster can actually pull the ref.
export const BUNDLE_STEPS = [
  { id: 'plan', diagram: 1, deps: [] },
  { id: 'base', diagram: 2, deps: ['plan'] },
  { id: 'generate', diagram: 3, deps: ['base'] },
  { id: 'submit', diagram: 4, deps: ['generate'] },
  { id: 'poll', diagram: 5, deps: ['submit'] },
  { id: 'publish', diagram: 6, deps: ['poll'] },
  { id: 'mirror', diagram: 7, deps: ['publish'] },
  { id: 'apply', diagram: 8, deps: ['mirror'] },
  { id: 'verify', diagram: 9, deps: ['apply'] },
] as const;

export type BundleStepId = (typeof BUNDLE_STEPS)[number]['id'];

// A run is keyed per (org, target), where target names what is being built:
// "<runtime>:<12 hex of what the selection content-addresses to>". A different
// plugin selection is a different target, so it is a new run rather than an
// override of the last one's durable state. The caller decides which stamp — the
// pre-run one (base version + plugin ids) or the registry key (that, plus the base
// digest) — and passes its first twelve hex characters here.
export const bundleTarget = (runtime: string, key: string): string => `${runtime}:${key.slice(0, 12)}`;

