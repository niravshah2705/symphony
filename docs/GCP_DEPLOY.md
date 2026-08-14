# GCP deployment (no-cost design)

AI Fleet runs the same code in two profiles, selected entirely by environment
variables. Nothing GCP-specific is required for local development.

## Architecture

- **SPA** → static files on **Firebase Hosting**. The deployment script stages an
  obfuscated copy and generates `config.js` with the gateway URL; tracked source
  files are never rewritten.
- **gateway** → public **Cloud Run** service (API-only, scale-to-zero). Verifies
  the **Firebase ID token** on every request, performs EULA/billing/user-scoped
  pipeline preflight, and serves **SSE** fed by **Firestore** `onSnapshot`.
- **orchestrator** → internal Cloud Run control plane. It imports only
  `@ai-fleet/shared-core` + LangGraph, persists PipelineRun/StageRun state and a
  Firestore checkpointer, and publishes dedicated per-stage commands.
- **planner** / **coder-control** → internal Cloud Run services (scale-to-zero),
  woken by Pub/Sub push + Cloud Scheduler ticks.
- **tester** / **deployer** → internal, scale-to-zero stage services. Their
  agent containers use egress-proxy sidecars and never receive raw provider,
  tracker, repository, or CI credentials. The deployer can invoke only
  repository-allowlisted CI/CD after server policy/approval gates.
- **coder-worker** → a Cloud Run **Job** (one ticket per run, up to 24h) launched
  by coder-control.
- **Firestore** replaces `data/store.json` and relays SSE events. **Secret
  Manager** holds credentials (injected as env; override stored settings).

Idle cost ≈ $0: static SPA + everything scale-to-zero + Firestore free tier.

## Local profile (default — no GCP)

`npm start` uses `STORE_BACKEND=file`, `MESSAGING_MODE=direct`,
`EVENTS_BACKEND=memory`, `AUTH_MODE=disabled`. The gateway serves the SPA
same-origin; planner/coder run their in-process loops; requests are delivered
in-process and worker events reach the gateway's SSE via the local collector
(`start-all.js` wires `EVENTS_SINK_URL`). No emulator needed.

## Cloud profile

Set the env vars documented in `.env.example` (GCP section) on each service:
`STORE_BACKEND=firestore`, `MESSAGING_MODE=pubsub`, `EVENTS_BACKEND=firestore`,
`AUTH_MODE=firebase`, project/region, dedicated pipeline topic names, push audience + SA, and the
gateway's `SPA_ORIGIN` / `API_BASE_URL` / `STREAM_TOKEN_SECRET`. The public
Firebase web config (`FIREBASE_API_KEY` / `FIREBASE_AUTH_DOMAIN`) is injected by
Terraform from the managed web app — no manual key needed; `FIREBASE_PROJECT_ID`
defaults to the project id, and `FIREBASE_ALLOWED_DOMAIN` is optional.

### Durable pipeline prerequisites

Production planner, coder, tester, and deployer revisions must set
`PIPELINE_STAGE_STORE_BACKEND=firestore`. Terraform does this when the pipeline
rollout is enabled. A worker transactionally claims each `StageCommandV1`
idempotency key and stores the final `StageResultV1` before publication. A
redelivery after restart therefore replays the stored result; an expired lease
is recorded as a terminal unknown outcome instead of risking duplicate model,
repository, or deployment side effects.

The tester image compiles and installs `ai-fleet-network-sandbox`, a
capability-free seccomp launcher used for every repository-native command. It
blocks network and metadata-server sockets while retaining local Unix-socket
IPC. Do not remove the launcher, `libseccomp`, or the production
`isolateNetwork` wiring: the tester app and credential sidecar necessarily share
one Cloud Run service identity, so this fail-closed subprocess boundary prevents
repository tests from minting workload credentials.

The pipeline uses four command topics and four result topics. Each service
account can publish only its own result topic (`planner → plan`, `coder → code`,
`tester → test`, `deployer → deploy`), and each result subscription pushes to
the matching `/pubsub/pipeline-stage-results/{stage}` route. Do not collapse
these into a shared result topic: the split is the capability boundary that
prevents a compromised earlier-stage service from forging later-stage results.

The shared agent proxy can resolve only platform-managed credentials because it
is not pinned to one organization. Gateway admission therefore rejects a
customer-selected provider on the shared stack. Customer credentials are
supported by a dedicated stack only, where `FLEET_ORG_ID` matches the request
organization and the sidecar carries the corresponding `PROXY_ORG_ID`.

For a platform-managed hosted LLM, add its environment name and Secret Manager
secret id to `managed_provider_secrets`, and create an enabled secret version
before applying Terraform. The required names are `GEMINI_API_KEY` for
Gemini/Antigravity, `HUGGINGFACE_API_KEY` for Hugging Face,
`ANTHROPIC_API_KEY` for Claude key mode, and `OPENAI_API_KEY` for OpenAI/Codex
API-key mode. The default map contains only Linear and GitHub credentials, so a
hosted model is intentionally not ready until its LLM secret is configured.
Mount managed keys on the settings service only—never on an agent app container.
`CODEX_BACKEND=chatgpt` does not accept `OPENAI_API_KEY`; it requires an
organization-scoped imported Codex token bundle and therefore a matching
dedicated stack. To use a platform-managed OpenAI key, set `CODEX_BACKEND=api`.

### First deployment — bootstrap once

`deploy/gcp/bootstrap.sh` owns the one-time project layer: API enablement,
Terraform state bucket, Pub/Sub service identity, seeded Secret Manager
containers/versions, Terraform imports, and the Artifact Registry prerequisite.
It is idempotent. Authenticate with `gcloud`, then run it before the canonical
deployment command:

```bash
gcloud auth login
gcloud auth application-default login

PROJECT_ID=my-proj \
LINEAR_API_KEY=lin_... \
INTERNAL_API_TOKEN='<strong-random-value>' \
  ./deploy/gcp/bootstrap.sh

cp deploy/gcp/.env.example deploy/gcp/.env
chmod 600 deploy/gcp/.env
# Fill GCP_PROJECT_ID, SPA_BUCKET, TF_STATE_BUCKET, INTERNAL_API_TOKEN, and
# the optional settings in deploy/gcp/.env.

npm run gcp:deploy -- --all
```

Pass `REPO=owner/repo` to the bootstrap only when the manual GitHub wrappers are
also wanted. That additionally creates the deployer service account and WIF
binding and writes the wrapper's repository variables/secrets through the
ambient `gh` login. No service-account key is created.

### Subsequent deployments — canonical local command

The local script computes the same path-sensitive work plan formerly embedded
in GitHub Actions:

```bash
npm run gcp:deploy -- --plan          # print the HEAD^...HEAD plan; no cloud calls
npm run gcp:deploy                    # deploy only that plan
npm run gcp:deploy -- --since <ref>   # compare merge-base(<ref>, HEAD) with HEAD
npm run gcp:deploy -- --all           # rebuild/deploy the complete stack
```

The no-argument `HEAD^` default intentionally covers only the newest commit.
If manual deployment has lagged by more than one commit, use
`--since <last-successfully-deployed-ref>` so every accumulated path change is
planned, or use `--all` for full convergence.

Configuration is loaded from the gitignored `deploy/gcp/.env`; use
`--env-file <path>` for another trusted assignment file. A real deployment
requires a clean, committed worktree and ambient `gcloud`/`gsutil` credentials.
The deploy revision must resolve to a full 40-character SHA. The command holds
both a host-local lock and a generation-fenced object in `TF_STATE_BUCKET` for
the complete mutating run, which prevents a local operator and the manual
GitHub wrapper from publishing or applying concurrently. Inspect a stale lock
before removing it manually.

Changed service images are built and pushed with that immutable SHA. When
Terraform runs, unchanged services retain the full immutable tag resolved from
their live Cloud Run revision; failure to resolve such a tag stops the apply.
The proxy image is included whenever Terraform is required. The script then
runs one complete `terraform apply` with the resolved per-service tags and the
configuration from `.env`.

SPA work is staged under a temporary directory, obfuscated, given a generated
gateway `config.js`, and published with Firebase Hosting. Neither
`public/config.js` nor another tracked source file is changed. A SPA-only plan
does not apply Terraform, while an infrastructure or image plan does.

The optional `cloudbuild.yaml` remains available as a separately submitted,
manual GCP pipeline:

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_BUCKET=...,_TF_STATE_BUCKET=...
```

It is not invoked by the local command or by a repository event.

### Manual GitHub alternative

`.github/workflows/deploy.yml` is a `workflow_dispatch`-only wrapper around
`npm run gcp:deploy`. It provides WIF authentication and deployment concurrency,
but contains no second deployment implementation:

```bash
gh workflow run deploy.yml \
  -f deploy_all=false \
  -f changed_since=HEAD^

# First deploy, region move, or explicit full convergence:
gh workflow run deploy.yml -f deploy_all=true -f changed_since=HEAD^
```

It never runs from a push, merge, path change, tag, or schedule.

### After either deployment path

In the **Firebase console**: enable the **Google** sign-in provider
(Authentication → Sign-in method), and add the printed gateway URL and the SPA's
Firebase Hosting domain to Authentication → Settings → **Authorized domains**.

## Skills registry (versioned, GCS + optional gcsfuse)

The deep-agent **skills** (`packages/shared-core/src/agent/skills/<skill>/SKILL.md`) can
be served from a **GCS bucket** instead of only the copy baked into the image, so a
skill edit ships without rebuilding/redeploying a service — and so multiple skill
**versions coexist** and a running deployment stays pinned to a known-good one.

**How it fits together**

- **Manifest** — `packages/shared-core/src/agent/skills/skills-manifest.json` records the
  bundle `version`, `updatedAt`, and a per-skill `{ name, version }` list (mirrors
  `llm-presets.json`). The bundle `version` (e.g. `v1`) is the release token used
  everywhere below.
- **Manual publish** — `npm run skills:publish` reads the version from the
  manifest. An optional `--version` is an assertion and must match that
  committed value. The command resolves the bucket from
  `SKILLS_BUCKET` or `GCP_PROJECT_ID`, and mirrors the directory to
  `gs://<bucket>/<version>/`. It refreshes both the version-scoped and top-level
  manifest pointers. Deletion is confined to the selected version prefix;
  older versions are never touched.
- **Mount** — `deploy/gcp/terraform/skills.tf` **CREATES and owns** the bucket (name
  derived as `<project_id>-aifleet-skills`; override with `var.skills_bucket_name`,
  toggle the whole feature with `var.skills_enabled`, default `true`). It has
  uniform bucket-level access, object versioning, and public-access-prevention
  **enforced** (no public access). The planner/coder service accounts get
  `objectViewer`, and an operator or manual-wrapper identity can receive
  `objectAdmin` through `var.skills_publisher_member`.
- **Version-pinned install** — when the separate `skills_mount_enabled` toggle is
  enabled, Terraform mounts the bucket read-only on planner/coder via gen2
  gcsfuse and those services run with `SKILLS_ROOT=/skills` and
  `SKILLS_VERSION=<var.skills_version>`. `packages/shared/src/config.js`
  `resolveSkillsSrc()` resolves the install source to `/skills/<version>`, and
  `installSkills()` copies from there. The mount defaults off while its coder
  startup behavior is being validated; with it off, or when `SKILLS_ROOT` is
  unset in local development, the runtime uses the vendored skills.

**Cut a new skills version**

1. Edit the skills and bump the manifest `version` (e.g. `v1` → `v2`) + the touched
   per-skill `version`; update `updatedAt`.
2. Preview, then publish from a clean committed worktree using ambient `gcloud`
   credentials:

   ```bash
   npm run skills:publish -- --version v2 --dry-run
   npm run skills:publish -- --version v2
   ```

   With no `--version`, the command uses the manifest version; when supplied,
   `--version` must match it. `v1` remains intact when `v2` is published. An
   atomic bucket lock prevents this local
   command from racing the manual GitHub wrapper or another operator.
3. If the gcsfuse mount is enabled, set `SKILLS_VERSION=v2` in
   `deploy/gcp/.env` and apply with `npm run gcp:deploy -- --all`. Only then do
   planner/coder read `v2`. Restore `v1` and apply again to roll back.

Set-up (one-off): nothing to pre-create — **Terraform creates the bucket** (name
`<project_id>-aifleet-skills`). `deploy/gcp/.env` may leave `SKILLS_BUCKET`
empty to derive that name. After the first Terraform apply, publish the initial
version with the local command above. The optional GitHub wrapper is manual-only:

```bash
gh workflow run publish-skills.yml -f version=v1
```

It invokes the same local command and is never triggered by a push or path change.

## Harness registry (versioned, GCS)

The harness registry publisher reads the pinned full-SHA sources in
`packages/shared-core/src/agent/registry/sources.json`, builds fresh `original`
and normalized `generic` trees in a temporary directory, and scans both for
secret-like files and forbidden MCP `env`/`headers` fields before publication.
The manifest's `version` selects the GCS prefix.

```bash
npm run registry:publish -- --dry-run  # clone, build, and scan; do not upload
npm run registry:publish               # publish from a clean committed worktree
```

The real publish uses ambient `gcloud` credentials, mirrors only the selected
`gs://<bucket>/<version>/` prefix, and refreshes
`registry-manifest.json`. Configure `REGISTRY_BUCKET` in `deploy/gcp/.env`; it
must match Terraform's `registry_bucket_name` (default `aifleet-registry`). Other
version prefixes remain untouched. A bucket-backed atomic lock serializes the
prefix and manifest update across machines. Inspect a stale `.locks/` object
before removing it manually. The WIF-backed manual wrapper is:

```bash
gh workflow run sync-harness-registry.yml
```

There is no weekly schedule or other automatic trigger.

## Roles & access control (RBAC)

Authorization is **role-based** and enforced **server-side on every `/api` route**
(`services/gateway/src/auth.js` `requirePermission`); the SPA mirrors the same
rules only to hide menu items — never the security boundary. Roles map to four
permission domains (`packages/shared/src/authz.js`):

| Role | workspace (agent) | planning (projects/board/business) | insights (analytics/workflows/troubleshooting) | settings |
|------|------|------|------|------|
| **admin** | write | write | write | write (config, provider keys, roles) |
| **operator** | write | write | write | read |
| **viewer** | read | read | read | read |
| **public** (not signed in) | read | — | — | — |

- **Public/root:** an unauthenticated visitor sees the **read-only Agent workspace** only; every other menu item is hidden and its API returns 401.
- **Menu items hide** when the signed-in role lacks the permission; the Settings item is admin-only.
- **Assigning roles** — set a Firebase custom claim (the user re-logs in to pick it up):
  ```bash
  FIREBASE_PROJECT_ID=<project> node services/gateway/scripts/set-user-role.js user@corp.com admin
  ```
- **Bootstrap** the first admin(s) without a pre-existing admin via the
  `AUTH_ADMIN_EMAILS` (comma-separated) env / repo var; `AUTH_DEFAULT_ROLE`
  (default `viewer`) is what a signed-in user gets before any claim is set.

### Security posture (see the tribal-knowledge checklists)

- planner/coder are **IAM-gated (no `allUsers` invoker)** — only the gateway SA
  and the Pub/Sub push SA may invoke them, via OIDC. Ingress defaults to
  `ALL` (so the gateway's OIDC read-proxy works without a VPC); flip to
  `INTERNAL_ONLY` + Direct VPC egress for network-layer isolation.
- In `firebase` mode the gateway **verifies the Firebase ID token** on every
  request (Google's public keys) and fails closed on a missing/invalid token.
- Pub/Sub push and Cloud Scheduler calls carry **OIDC tokens** verified on
  `/pubsub/*` (audience + expected SA).
- The durable pipeline is fail-safe off until
  `PIPELINE_ORCHESTRATOR_ENABLED=true`; deployment has the separate
  `PIPELINE_DEPLOYMENT_ENABLED=false` default and production approval gate.
- **CORS** reflects only the exact `SPA_ORIGIN` (never `*` with credentials).
- Secrets live in **Secret Manager**, never in images or committed files
  (`data/` stays gitignored).

## Verify a deploy

- `curl https://<gateway>/healthz` → `{"status":"ok"}`.
- Open the Firebase Hosting SPA URL, sign in via Google, submit a planner/coder request, and
  confirm SSE steps stream in.
- Confirm a direct unauthenticated call to the planner/coder URL is rejected,
  and that everything scales to zero when idle.
