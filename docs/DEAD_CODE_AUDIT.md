# Dead-code audit — 2026-11-20

A repo-wide sweep for code that nothing references, done to size the codebase
before more routing logic moves out to the kagent APIs. This page records **what
was removed, what was deliberately kept, and what is still open** — so the next
reader re-derives the judgement instead of trusting it.

## Method

The repo has no committed graph index (`docs/code-graph/`, `.code-review-graph/`
and `graphify-out/` are all gitignored and were absent), so the audit was done by:

1. **Reachability.** BFS over `require()` / dynamic `import()` from every real
   entrypoint: root + per-workspace `package.json` `main`/`bin`/`start`/job
   scripts, `scripts/start-all.js`, `deploy/gcp/Dockerfile.*` CMD, `.github/workflows/*`,
   `cloudbuild.yaml`, and `node --test`'s discovery of `*.test.js`.
2. **Per-symbol reference sweep.** For each export, a repo-wide whole-word search
   across `.js .mjs .cjs .json .md .tf .yml .py`, minus its own defining file.
3. **Dynamic-dispatch exclusion.** Anything resolved by computed key
   (`require(path.join(dir, \`${name}.workflow.js\`)`, registry maps, `CONFIG[key]`,
   namespace requires like `registry.foo`) was checked by namespace, not by name,
   and is **not** flagged even when the bare symbol has no textual consumer.

Re-run it the same way; do not reuse the line numbers below as authority — they
drift. `npm run graph:build` gives a better index if one is present.

## Removed

Everything here had **zero** references outside its own file (and its own test).

| Removed | Why it was provably dead |
|---|---|
| `packages/shared-core/src/agent/registry/loader.js` (+ `.test.js`) | The only importer anywhere was `loader.test.js:17`. None of `loadHarnessRegistry`, `resolveRegistrySrc`, `resolveHarnessRegistryDir`, `loadRegistryManifest` or `selectForRuntime` appear anywhere else in the repo. The live converter path is the sibling `registry/index.js`, used by `scripts/build-harness-registry.js:33`. |
| `services/gateway/src/capability-view.js` (+ `.test.js`) and the `GET /api/capabilities` route | No caller in `public/js/`, `e2e/`, `packages/cli`, `services/billing`, or docs. The SPA consumes `/api/workflows/kagent/capabilities` instead. See *Risk* below. |
| `e2e-live/kagent-litellm-tenant.spec.js` | `playwright.live.config.js` has `testDir: './e2e-live'` but only two `testMatch`es (`security-evidence`, `full-pipeline`), so this spec could never be collected. |
| `archive/gateway-agent-endpoints/` | Its own README declared it historical reference with nothing imported. The sole pointer to it was a comment in `services/orchestrator/src/routes/codex.js`, reworded here. |
| `diagrams/archify/` (1.4 MB) | Generated HTML/PNG/JSON visual-check output, no inbound references, and it carried a hardcoded absolute path from a different machine. Top-level `diagrams/*.png` and `*.excalidraw` **are** referenced by `README.md` and were kept. |
| `SWAGGER_INDEX.md`, `SWAGGER_QUICK_REFERENCE.md`, `SWAGGER_DEPLOYMENT_CHECKLIST.md` (root) | 892 lines that only cross-linked each other; no inbound link from `README.md`, `AGENTS.md`/`CLAUDE.md` or `docs/`. The canonical Swagger docs live in `docs/SWAGGER_*.md`. |
| `dreamy-launching-emerson.md`, `deep-agent-llm.png` (root) | Zero references; generated plan scratch and an orphan image. |
| `integrations/openswe/__pycache__/*.pyc` | Committed build artifact. `.gitignore` now has `__pycache__/` + `*.pyc` so it cannot return. |

Total: ~2,300 lines of application code and ~1.9 MB of files.

**Risk, called out honestly:** deleting `GET /api/capabilities` removes live HTTP
surface. Its handler is gated `requireAuthenticated() + requirePermission('settings')
+ requireOrganizationContext() + requireBillingCaller`, and `requireBillingCaller`
is what an internal service-to-service caller must satisfy — so an out-of-repo
consumer cannot be excluded by grep alone. It is trivially restorable from
`git log` if an operator or dashboard turns out to call it.

## Deliberately kept (these look dead to a naive sweep)

- **`go/adk`, `go/api`, `go/core`, `go/pkg` (~1.6 MB).** No `go build` step exists
  in `cloudbuild.yaml` or any workflow, which reads as orphaned — but
  `go/harness/*/Dockerfile:15-19` `COPY`s all four into the builder, and
  `.github/workflows/build-runtime-images.yml` builds those images. **Alive.**
- **`packages/shared-core/src/agent/diagnostics.js`.** 10 of its 11 exports have no
  consumer, but `runDiagnostics` is used by
  `services/orchestrator/src/routes/observability.js:7`. Only its export list is
  bloated, not the file.
- **`firebase.json` + `firestore.rules`.** Feels like a pre-GKE leftover; it is
  asserted by `deploy/gcp/analytics-config.test.js:80` and deployed by
  `deploy-secrets.yml`. **Alive** (hosting, not the Firebase backend).
- **`scripts/reset-aifail.js`, `scripts/backfill-billing-source.js`.** Zero
  references, but both are self-documenting dry-run/`--apply` operator tools —
  the unreferenced-by-design category. Kept; only delete if the underlying
  `aifail` / billing-source flow is itself retired.
- **`scripts/flexprice-spike/`, `scripts/models-label-group.js`,
  `integrations/openswe/local_docker_sandbox.py`.** Wired to npm scripts, README
  instructions, or `docs/OPENSWE_SETUP.md` respectively.

## Still open

Tracked in Linear (see the linked follow-up issue), in rough order of value:

1. **The OpenSWE coder path — code says dead, infra says live.** `runCoder`
   (`packages/shared/src/agent/coder.js`) and `runPlannedCoder` have no non-test
   caller: `services/orchestrator/src/coding-stage.js` imports `runPlannedCoderLocal`
   directly. Both were the *only* routes to `runOpenSwe`, so
   `packages/shared/src/agent/openswe.js` is unreachable — yet `cloud_run.tf`,
   `deploy/gcp/deploy.sh` and `cloudbuild.yaml` still deploy OpenSWE. Decide which
   side is wrong before deleting either.
2. **The CLM inference backend.** `SKILL_ROUTER_BACKEND` defaults to `laya`
   (`packages/shared-core/src/config.js`) and `CLM_INFERENCE_URL` is never set in
   `cloud_run.tf`, so `routeWithClm` would dial `localhost:8089`. Candidate:
   `services/clm-inference/` + `skill-router/clm-client.js` +
   `terraform/clm_inference.tf` (~390 lines). Needs an ops confirmation first.
3. **~250 lines of never-imported exports** in live modules — e.g.
   `probeRepositoryAvailability` / `isRepositoryAvailabilityError`
   (`packages/shared/src/agent/availability.js`), `resolveEffectiveSettings`
   (`settings-client.js`, referenced only by a comment in `plan.js`),
   `getPlanningConfig` (`shared-core/src/store.js`), `drawOrderForDebit`
   (`billing/credits.js`, only its own tests), `DirectStageCommandBus`
   (`pipeline/bus.js`), `cashfreeAdapter`
   (`services/billing/src/payment-providers.js`), `redactPan`
   (`services/identity-verification/src/identity.js`). Pruning these shrinks public
   surface without changing behaviour.
4. **Four internal POST routes with no caller** — `POST /internal/pipeline/results/:stage`,
   `POST /internal/pipeline/results` (`services/orchestrator/src/app.js`),
   `POST /internal/pipeline/stage/:stage` (`pipeline-stage.js`). Terraform only wires
   the `/pubsub/pipeline-stage*` variants.
5. **Duplicated helpers:** `packages/shared-core/src/agent/oauth.js` re-implements
   `base64url` / verifier+challenge / state that `pkce.js` already provides, and its
   login flow mirrors `claude-oauth.js` with the same export names.

## Verification of this change

`npm test` → 2,570 tests, 2,564 pass, 5 skipped, 1 fail. The failure is
`scripts/marketing-site.test.js` demanding a generated `marketing/` tree that does
not exist in a fresh worktree (`run node scripts/build-marketing-site.js`). It is
environmental: `marketing/` is untracked build output, and this change touches no
file under `scripts/` nor the marketing build, so it fails identically on a clean
`origin/main` worktree.
