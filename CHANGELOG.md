# Changelog

All notable changes to AI Fleet (tech-symphony). Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is not yet
tagged by semver, so entries are grouped by the date they landed on `main`.

## 2026-08-10

### Added

- **Sign in with Microsoft** — an optional **Continue with Microsoft** button
  (`signInWithPopup(new OAuthProvider('microsoft.com'))`) alongside Google. Both
  providers federate into the same Firebase session, so the gateway/Python token
  verification is unchanged. Each provider is availability-gated by a flag in
  `/api/auth/config` (`AUTH_GOOGLE_ENABLED`, default on; `AUTH_MICROSOFT_ENABLED`,
  default off) with an optional `MICROSOFT_TENANT`/`AZURE_TENANT_ID`; when both are
  on the card shows Google first, Microsoft below. The Azure client secret stays
  in the Firebase console (never in env). See `docs/ACCESS_MODEL.md`.

## 2026-08-08

A large multi-part release: the organization/access model, a new agent harness,
a hierarchical settings service, a skills registry, an SSE refactor, and
supporting CI/infra. Delivered as focused PRs (numbers in parentheses).

### Added

- **Antigravity SDK harness** (#57) — a fourth agent harness alongside DeepAgent,
  OpenAI Codex SDK, and Anthropic Claude Agent SDK. Registered in
  `agent/runtimes.js` and backed by `@google/genai` (Gemini) — the `interactions`
  managed-agent API with a `generateContent` fallback (there is no npm
  `google-antigravity` package). Adds a matching `antigravity` LLM provider so
  the harness is not downgraded, and exposes it in the Settings + Workflows UI.
- **Hierarchical settings-policy service** (#60) — a new internal, IAM-gated
  FastAPI + Firestore microservice (`services/settings`) storing org → project →
  user **include/exclude** policy over four domains (Harness, Tools, Skills,
  Plugins). A cascade resolver enforces that excluding an item at a higher scope
  blocks it for every lower scope; a lower scope can only narrow. Reached through
  the gateway at `/api/settings-policy/*` (dual-token S2S; `/me` is auth-only).
  Ships a settings-policy UI.
- **Provider keys as per-scope settings** (#65) — `GEMINI_API_KEY` (and provider
  keys generally) can be configured per org/project/user as a **masked,
  write-only** value. Browser responses only reveal `{ set: bool }`; the
  plaintext is served solely over an IAM-gated internal endpoint that the gateway
  refuses to proxy. The Antigravity harness resolves its key from the effective
  settings, falling back to the `GEMINI_API_KEY` env/store.
- **Settings-policy enforcement at agent build** (#65) — `agent/framework.js` and
  `agent/runtimes.js` prune tools/skills and downgrade an excluded harness
  according to the resolved effective policy (fail-open when no scope is present,
  e.g. local single-user).
- **Three-tier access model** (#50) — anonymous read-only + basic RAG →
  authenticated org-less **personal projects** → organization member. Verified
  Firebase users are JIT-provisioned as org-less. Documented in
  `docs/ACCESS_MODEL.md`.
- **Google One Tap sign-in** (#50, #52) — Google Identity Services One Tap
  exchanged into a Firebase session via `signInWithCredential` (nonce-bound),
  with the popup as a fallback. The public OAuth client id is served via
  `/api/auth/config` and managed in Secret Manager by Terraform.
- **Organization management service** (#48) — the vendored FastAPI service ported
  from Postgres/SQLAlchemy to Firestore (Organizations → Projects → Tasks with
  RBAC), deployed as an internal, IAM-gated Cloud Run service behind the gateway.
- **Personal projects** (#50) — single-owner, org-less projects at
  `users/{uid}/projects/{id}`; adding collaborators requires creating an
  organization first.
- **Skills registry on GCS** (#56, #62) — versioned skill bundles + a manifest in
  a Terraform-created GCS bucket, a `publish-skills.yml` CI workflow, and a
  version-pinned install path (`SKILLS_ROOT`/`SKILLS_VERSION`) via a read-only
  gcsfuse mount so multiple versions coexist (mount currently gated off — see
  Known limitations).
- **RubricMiddleware** (#31) — a deepagents rubric completion-review contract
  applied uniformly across all four SDK harnesses (checklist + grade→revise loop;
  opt-in, fail-open).
- **Stacked PRs for dependent coder tasks** (#29) — a dependent coder task stacks
  its PR on an unmerged blocker branch and is auto-retargeted to `main` once the
  blocker merges (`stackLinks` store + `agent/stack-reconcile`).
- **CI Checks workflow** (#54, #55) — `.github/workflows/checks.yml` runs the Node
  unit tests, Playwright e2e, and the org + settings pytest suites on every PR and
  push to `main`. Added org/personal-project and full org-flow e2e specs.

### Changed

- **"Local Models" → "BYoM" (Bring Your Own Model)** (#59) — full rename and key
  migration (`localLlm*` → `byom*`; deployment tier `local` → `byom`), folding
  Hugging Face's hosted router into BYoM. Includes a backward-compatible store
  migration so existing data keeps working.
- **Frontend polling replaced by SSE** (#58) — a global workspace SSE channel now
  streams agent status / jobs / coder / gate updates; the three 5-second polling
  loops were removed (local display timers and one-shot seed loads retained).

### Fixed

- npm lockfile out of sync with the `@ai-fleet/cli` workspace, which broke every
  Docker image build (#51).
- org service `Dockerfile` ran `pip install .` before copying the source (#53).
- Terraform-managed seeding of `org-jwt-secret` and the One Tap client id (#52);
  the settings-service JWT secret is likewise auto-seeded via `random_password`.
- Skills gcsfuse mount gated off after it broke coder-control startup (#64).
- e2e stabilization: SSE isolation and rewrites of tests coupled to the removed
  polling (#61, #63); rubric/runtimes test parse fix (#31).

### Infrastructure & Deploy

- New internal Cloud Run services (org, settings) reached only through the gateway
  (Google OIDC S2S + IAM; no public invoker). Terraform-managed JWT secrets
  (auto-seeded via `random_password`, no manual step). Path-filtered CD so a merge
  rolls only what changed. Skills GCS bucket + least-privilege IAM created by
  Terraform.

### Known limitations / deferred

- **Skills gcsfuse mount** is gated off (`skills_mount_enabled = false`): mounting
  the read-only GCS volume under the gen2 execution environment fails
  coder-control's startup probe. Enabling it needs a validated coder-control
  gen2/fuse startup, an initially-published bucket version, and a
  `resolveSkillsSrc` empty-mount fallback. The bucket is created; services use the
  image's vendored skills meanwhile (no regression).
- **Gemini key + policy enforcement on the async Pub/Sub planner/coder path**:
  `ctx` is not yet populated there (those jobs run without a live user token, and
  pushing a plaintext key through Pub/Sub would be a secrets-in-transit
  regression). That path defaults to allow-all + `GEMINI_API_KEY` env fallback; a
  token-bearing/S2S act-as path activates it later.
