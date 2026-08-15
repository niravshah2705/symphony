# GCP deployment (no-cost design)

AI Fleet runs the same code in two profiles, selected entirely by environment
variables. Nothing GCP-specific is required for local development.

## Architecture

- **SPA** → static files on a **GCS bucket** (free-tier hosting). The SPA calls
  the gateway API cross-origin; `public/config.js` carries the gateway URL.
- **gateway** → public **Cloud Run** service (API-only, scale-to-zero). Verifies
  the **Firebase ID token** on every request, performs EULA/billing/user-scoped
  pipeline preflight, and serves **SSE** fed by **Firestore** `onSnapshot`.
- **stream-token-broker** → private **Cloud Run** service that exposes only
  stream-token mint/verify RPCs. It has its own service account and is the only
  service that retains `stream-token-secret` after migration; the gateway
  service account receives only `roles/run.invoker` on this service. One broker
  instance stays warm by default so token RPCs do not depend on a cold start.
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
- **Firestore** replaces `data/store.json` and relays SSE events. The settings
  service encrypts customer credentials per organization/project; egress
  sidecars resolve and inject them without exposing raw values to agent apps.

Most compute scales to zero. The stream-token broker intentionally keeps one
warm instance, so the deployed stack has a small steady-state Cloud Run cost.

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
gateway's `SPA_ORIGIN` / `API_BASE_URL`. Terraform sets the gateway's
`STREAM_TOKEN_SERVICE_URL` to the private broker URL. The signing secret is
mounted on the broker container, which runs as `stream-token-broker-sa`; it is
not mounted on the shared gateway revision. While the temporary migration gate
is true, unreconciled tenant sidecars can still mount that same secret. The public
Firebase web config (`FIREBASE_API_KEY` / `FIREBASE_AUTH_DOMAIN`) is injected by
Terraform from the managed web app — no manual key needed; `FIREBASE_PROJECT_ID`
defaults to the project id, and `FIREBASE_ALLOWED_DOMAIN` is optional.

`stream_token_min_instances` defaults to `1` because the gateway enforces a
strict two-second broker RPC deadline; waiting for a Cloud Run cold start would
otherwise turn routine mint/verify calls into 503 responses. Setting it to `0`
opts back into scale-to-zero and lower idle cost, but explicitly accepts that
availability risk.

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
API-key mode. The default managed map contains only GitHub; Linear is always a
customer-owned organization/project vault credential. A hosted model is
intentionally not ready until its LLM secret is configured.
Mount managed keys on the settings service only—never on an agent app container.
`CODEX_BACKEND=chatgpt` does not accept `OPENAI_API_KEY`; it requires an
organization-scoped imported Codex token bundle and therefore a matching
dedicated stack. To use a platform-managed OpenAI key, set `CODEX_BACKEND=api`.

### Deploy — one-shot script (recommended)

`deploy/gcp/deploy.sh` does the whole thing from an operator machine (idempotent):
enables APIs, creates the Terraform state bucket, stages Secret Manager versions
(auto-generates `stream-token-secret`), builds + pushes the shared images,
publishes the SPA to GCS, and applies Terraform in the correct staged order.

```bash
PROJECT_ID=my-proj \
SPA_BUCKET=my-proj-aifleet-spa \        # globally-unique
TF_STATE_BUCKET=my-proj-tfstate \
./deploy/gcp/deploy.sh
```

After deployment, an organization or project administrator stores its Linear
credential in Settings. It is encrypted by the settings service and resolved
only by the egress sidecar; it is never mounted on gateway or agent containers.

Optional env: `REGION`, `AR_REPO`, `IMAGE_TAG`, `FIRESTORE_LOCATION`, `SPA_ORIGIN`,
`FIREBASE_ALLOWED_DOMAIN` (empty = any verified user), `GITHUB_TOKEN`,
`LANGSMITH_API_KEY`, `GOOGLE_ANALYTICS_MEASUREMENT_ID` (a public GA4 `G-...`
web-stream id; empty = disabled), `SKIP_BUILD=1` (reuse pushed images), plus
`EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USER`,
`EMAIL_SMTP_PASSWORD`, and `EMAIL_FROM` for transactional email. The script
defaults `EMAIL_PUBLIC_APP_URL` to the exact GCS `index.html` URL it publishes;
override it only when a custom domain/CDN serves the SPA. It prints the gateway
URL + SPA URL and the Firebase authorized domains to register.

### Deploy — CI (Cloud Build)

`gcloud builds submit --config cloudbuild.yaml --substitutions=_BUCKET=...,_TF_STATE_BUCKET=...,_GOOGLE_ANALYTICS_MEASUREMENT_ID=G-XXXXXXXXXX`
runs the same build → SPA-publish → staged `terraform apply` in Cloud Build.
Seed the required agent Secret Manager versions first (the one-shot/bootstrap
scripts do this for you). SMTP credentials use the acyclic flow below.

### Cloud Run revision retention

GitHub Actions, `deploy/gcp/deploy.sh`, and Cloud Build run
`deploy/gcp/prune-cloud-run-revisions.sh` only after a successful full Terraform
apply. The shared sweep covers every Cloud Run service in the supplied project
and region, keeps the newest three revisions, deletes older candidates
oldest-first and synchronously, then verifies the bound. It never changes
traffic: if Cloud Run protects an older active/tagged revision, deletion fails
and the deployment reports the cleanup failure with service/revision context.
Tenant provisioning also bounds each tenant service immediately after reconcile;
the shared sweep is the project-wide backstop.

The Analytics substitution is optional and public. The SPA publish step validates
it and writes it to the no-store `config.js`; omit it to disable collection. See
[Google Analytics](GOOGLE_ANALYTICS.md) for data-stream and verification setup.

The Cloud Build bootstrap owns the empty `email-smtp-user` and
`email-smtp-password` secret containers. It never reads SMTP values and never
passes them through Terraform state. If both secrets already have an enabled
version, the pipeline mounts both as `latest`; if neither does, it deploys with
SMTP authentication disabled. A partial pair fails before the full apply. On a
brand-new Cloud Build-only project, let the first build create the containers,
add both versions with `gcloud secrets versions add`, then rerun the build. The
`_EMAIL_PUBLIC_APP_URL` substitution defaults to the GCS `index.html` object
published by that same build.

For a direct Terraform apply, set `email_public_app_url` explicitly to the SPA
that was actually published and set `email_smtp_auth_enabled=true` only after
both SMTP secrets have an enabled version. Terraform intentionally fails the
email-service plan when the public URL is empty, instead of guessing a Firebase
Hosting URL.

### Stream-token broker migration (two phases)

Existing tenant gateways are Cloud Run services outside the shared Terraform
state. A previously provisioned tenant revision can therefore keep its legacy
stream-token sidecar after the shared gateway has moved to the broker. Removing
`gateway-sa` access to `stream-token-secret` before those revisions are
reconciled would break them on restart.

1. Apply this release with
   `stream_token_legacy_gateway_secret_access=true` (the temporary default).
   Terraform creates the private broker and its service account, grants the
   broker access to the existing secret, grants `gateway-sa` broker invoke
   rights, and moves the shared gateway to `STREAM_TOKEN_SERVICE_URL`. The
   conditional legacy secret grant remains during this phase solely for
   unreconciled tenant revisions. The output
   `stream_token_legacy_gateway_secret_access_enabled = true` is an explicit
   warning that IAM isolation is not complete yet.
2. Verify shared gateway mint/verify and SSE behavior, then reconcile every
   existing tenant gateway as described in
   [Per-tenant deployment](PER_TENANT_DEPLOYMENT.md). Inventory every active
   tenant revision and confirm it has one gateway app container, the broker URL,
   and no `stream-token-proxy` container or `STREAM_TOKEN_SECRET` reference.
3. Persist `stream_token_legacy_gateway_secret_access=false` and apply again.
   For the standard repository pipeline, use a follow-up PR that flips the
   variable default; for a tfvars-managed deployment, commit it to that durable
   deployment input. Do not rely on a one-off CLI override that the next apply
   would undo. Confirm the output is `false` and the only accessor on
   `stream-token-secret` is `stream-token-broker-sa`.

Do not rotate `stream-token-secret` during the topology cutover: old and new
revisions must cross-verify in-flight tokens. Keep the broker and at least one
known-good proxy image throughout the rollback window. Before phase 2, rollback
can restore the old tenant templates directly. After phase 2, restore the
legacy IAM gate and apply it **before** rolling any gateway back to a sidecar.

### After either path

In the **Firebase console**: enable the **Google** sign-in provider
(Authentication → Sign-in method), and add the printed gateway URL and the SPA's
GCS origin to Authentication → Settings → **Authorized domains**.

## Skills registry (versioned, GCS + gcsfuse)

The deep-agent **skills** (`packages/shared-core/src/agent/skills/<skill>/SKILL.md`) can
be served from a **GCS bucket** instead of only the copy baked into the image, so a
skill edit ships without rebuilding/redeploying a service — and so multiple skill
**versions coexist** and a running deployment stays pinned to a known-good one.

**How it fits together**

- **Manifest** — `packages/shared-core/src/agent/skills/skills-manifest.json` records the
  bundle `version`, `updatedAt`, and a per-skill `{ name, version }` list (mirrors
  `llm-presets.json`). The bundle `version` (e.g. `v1`) is the release token used
  everywhere below.
- **CI publish** — `.github/workflows/publish-skills.yml` runs on any push touching
  `packages/shared-core/src/agent/skills/**` (or `workflow_dispatch` with a `version`
  input). It authenticates via WIF and `gsutil rsync`es the skills dir to
  `gs://<bucket>/<version>/` (plus the manifest object). It derives `<bucket>` from
  the `GCP_PROJECT_ID` repo variable the same way Terraform does
  (`<project_id>-aifleet-skills`) — no `SKILLS_BUCKET` repo var is needed. On a push
  the version is read from the manifest; each version lives under its own prefix, so
  publishing a new one **never touches** an older prefix.
- **Mount** — `deploy/gcp/terraform/skills.tf` **CREATES and owns** the bucket (name
  derived as `<project_id>-aifleet-skills`; override with `var.skills_bucket_name`,
  toggle the whole feature with `var.skills_enabled`, default `true`). It has
  uniform bucket-level access, object versioning, and public-access-prevention
  **enforced** (no public access). Terraform mounts it **read-only** on the
  **planner** and **coder** (control service + worker Job) via a gen2 **gcsfuse** GCS
  volume at `/skills`. The planner/coder service accounts get `objectViewer`, and
  the CI deployer gets `objectAdmin` when `var.skills_publisher_member` is set.
- **Version-pinned install** — those services run with `SKILLS_ROOT=/skills` and
  `SKILLS_VERSION=<var.skills_version>`. `packages/shared/src/config.js`
  `resolveSkillsSrc()` resolves the install source to `/skills/<version>`, and
  `installSkills()` copies from there. **Backward-compat:** when `SKILLS_ROOT` is
  unset (local/dev, or a project without the bucket) it falls back to the vendored
  `packages/shared-core/src/agent/skills` — existing behavior, unchanged.

**Cut a new skills version**

1. Edit the skills and bump the manifest `version` (e.g. `v1` → `v2`) + the touched
   per-skill `version`; update `updatedAt`.
2. Merge to `main`. `publish-skills.yml` publishes the new bundle to
   `gs://<bucket>/v2/` — `v1` stays intact, so every deployment still pinned
   to `v1` keeps working.
3. Roll the deployment forward by bumping **`skills_version`** (Terraform var /
   `gh variable set SKILLS_VERSION`) and applying. Only then do planner/coder read
   `v2`. To roll back, set it to `v1` again — the objects are still there.

Set-up (one-off): nothing to pre-create — **Terraform creates the bucket** (name
`<project_id>-aifleet-skills`) and grants the CI deployer write access when you set
`var.skills_publisher_member` to the deployer SA. After the first `terraform apply`,
publish an initial version by running the **Publish Skills Bundle** workflow
(`workflow_dispatch`, `version = v1`) or by pushing a change under
`packages/shared-core/src/agent/skills/**`. No `SKILLS_BUCKET` repo variable is
required — the workflow derives the name from `GCP_PROJECT_ID`.

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
- Open the GCS SPA URL, sign in via Google, submit a planner/coder request, and
  confirm SSE steps stream in.
- Confirm a direct unauthenticated call to the planner/coder URL is rejected,
  and that everything scales to zero when idle.
