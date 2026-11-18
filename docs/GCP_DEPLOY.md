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
- **orchestrator** → the single internal agent service. It hosts the
  browser-facing agent surface (the retired planner/coder routes), the durable
  pipeline control plane (PipelineRun/StageRun state,
  a Firestore checkpointer, per-stage command publishing), and the substrate
  control plane + actor callback. Agent runs themselves execute in substrate
  actors, not in this service.
- **Firestore** replaces `data/store.json` and relays SSE events. The settings
  service encrypts customer credentials per organization/project; egress
  sidecars resolve and inject them without exposing raw values to agent apps.

Most compute scales to zero. The stream-token broker intentionally keeps one
warm instance, so the deployed stack has a small steady-state Cloud Run cost.

## Local profile (default — no GCP)

`npm start` uses `STORE_BACKEND=file`, `MESSAGING_MODE=direct`,
`EVENTS_BACKEND=memory`, `AUTH_MODE=disabled`. The gateway serves the SPA
same-origin; the orchestrator agent surface runs its in-process loops; requests are delivered
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

Production orchestrator revisions must set
`PIPELINE_STAGE_STORE_BACKEND=firestore`. Terraform does this when the pipeline
rollout is enabled. A worker transactionally claims each `StageCommandV1`
idempotency key and stores the final `StageResultV1` before publication. A
redelivery after restart therefore replays the stored result; an expired lease
is recorded as a terminal unknown outcome instead of risking duplicate model,
repository, or deployment side effects.

The substrate actor image (`deploy/gcp/Dockerfile.substrate-actor`) compiles and
installs `ai-fleet-network-sandbox`, a
capability-free seccomp launcher used for every repository-native command. It
blocks network and metadata-server sockets while retaining local Unix-socket
IPC. Do not remove the launcher, `libseccomp`, or the production
`isolateNetwork` wiring: `packages/shared/src/agent/harnesses/deepagent.js` wraps
every production shell command in it unconditionally, and the model-controlled
tests must not mint workload credentials.

The pipeline uses three command topics and three result topics. Each stage
publisher can publish only its own result topic (`orchestrator → plan/code/test`),
and each result subscription pushes to
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
`LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (the agent trace sink pair — seed
both, then add them to `var.managed_provider_secrets` so the settings service can
resolve them; the egress sidecar, never an agent, holds the real values),
`LANGSMITH_API_KEY` (legacy; the dormant `/langsmith` route only — nothing traces
to LangSmith any more), `GOOGLE_ANALYTICS_MEASUREMENT_ID` (a public GA4 `G-...`
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
  **orchestrator** via a gen2 **gcsfuse** GCS
  volume at `/skills`. The orchestrator service account gets `objectViewer`, and
  the CI deployer gets `objectAdmin` when `var.skills_publisher_member` is set.
- **Version-pinned install** — the orchestrator runs with `SKILLS_ROOT=/skills` and
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
   `gh variable set SKILLS_VERSION`) and applying. Only then do the orchestrator and the actors it dispatches read
   `v2`. To roll back, set it to `v1` again — the objects are still there.

Set-up (one-off): nothing to pre-create — **Terraform creates the bucket** (name
`<project_id>-aifleet-skills`) and grants the CI deployer write access when you set
`var.skills_publisher_member` to the deployer SA. After the first `terraform apply`,
publish an initial version by running the **Publish Skills Bundle** workflow
(`workflow_dispatch`, `version = v1`) or by pushing a change under
`packages/shared-core/src/agent/skills/**`. No `SKILLS_BUCKET` repo variable is
required — the workflow derives the name from `GCP_PROJECT_ID`.

## Laya model registry (offline checkpoints, baked into the image)

The **laya-inference** service (`deploy/gcp/Dockerfile.laya-inference` = pip
`laya[serve]`, `laya-serve` on :8000, `POST /v1/systemone`, `GET /health`) serves
its Hugging Face checkpoints **fully offline**: the three checkpoints are
downloaded **at image build time** into `/opt/laya-cache` and the container never
reaches the Hub. A gcsfuse-mounted bundle was tried first and abandoned:
`safetensors` reads over FUSE made each CPU checkpoint build ~3.5 min, and
`laya-serve` preloads *before* binding the port, so no revision ever passed its
startup probe (revisions 00015-00018). The image digest is now the weights pin.

- **Image bake** — `Dockerfile.laya-inference` runs `hf download` for
  `convaiinnovations/laya` (english), `laya-multilingual`, and
  `laya-typed-decisions` into `/opt/laya-cache`, then sets `HF_HUB_OFFLINE=1`,
  `TRANSFORMERS_OFFLINE=1`, `HF_HUB_CACHE=/opt/laya-cache`. Terraform keeps
  `LAYA_DEVICE`/thread caps overridable without a rebuild.
- **GCS bundle (audit/backup only)** — `.github/workflows/publish-laya-models.yml`
  still publishes versioned `<version>/models--…` prefixes +
  `laya-models-manifest.json` (resolved commit SHAs) to the bucket Terraform owns
  (`laya_models.tf`, `<project_id>-aifleet-laya-models`), recording exactly which
  checkpoint revisions correspond to each bundle version. The service no longer
  mounts it.
- **Sizing** — 2 CPU / 8Gi (`var.laya_cpu`/`var.laya_memory`): all three
  checkpoints preload (`LAYA_PRELOAD=1`, `LAYA_MODELS=english,multilingual,
  typed-decisions`, `LAYA_MAX_LOADED=3`) for auto routing; thread caps
  (`LAYA_THREADS`/`OMP`/`MKL`) follow `var.laya_cpu`. The fp16 weights are
  ~2.3GB on disk but CPU inference materializes them as float32 (~4.7GB
  resident) plus ~0.4GB torch overhead, so **8Gi is the floor**: at 4Gi every
  instance was OOM-killed while building the *second* checkpoint (revisions
  00016-00018 each logged one `Agent(repo)` build, then exited silently ~5 min
  in with no traceback — preload is synchronous, so the port never bound and
  the startup probe timed out). The startup probe keeps a 20-min budget
  (15s × 80) and Terraform a 45-min operation wait so a slow build never aborts
  the rollout.
- **Rollout** — change the checkpoint set/revision in the Dockerfile, bump the
  version, and deploy; the rebuilt image (new digest) produces a fresh Cloud Run
  revision automatically. The GCS `laya_model_version` pin no longer drives
  runtime behavior.

**Cut a new model bundle (record only)**

1. Run **Publish Laya Model Bundle** (`workflow_dispatch`, e.g. `version = v2`).
2. Note the commit SHAs in the printed/uploaded `laya-models-manifest.json` and
   match them to the `hf download` revisions in the Dockerfile build log.

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

- the orchestrator is **IAM-gated (no `allUsers` invoker)** — only the gateway SA
  and the Pub/Sub push SA may invoke it, via OIDC. Ingress defaults to
  `ALL` (so the gateway's OIDC read-proxy works without a VPC); flip to
  `INTERNAL_ONLY` + Direct VPC egress for network-layer isolation.
- In `firebase` mode the gateway **verifies the Firebase ID token** on every
  request (Google's public keys) and fails closed on a missing/invalid token.
- Pub/Sub push and Cloud Scheduler calls carry **OIDC tokens** verified on
  `/pubsub/*` (audience + expected SA).
- The durable pipeline is fail-safe off until
  `PIPELINE_ORCHESTRATOR_ENABLED=true`; the deploy stage was retired with the
  Cloud Run deployer (2026-11) and is rejected with `410 pipeline_deploy_retired`.
- **CORS** reflects only the exact `SPA_ORIGIN` (never `*` with credentials).
- Secrets live in **Secret Manager**, never in images or committed files
  (`data/` stays gitignored).

## Substrate agent pattern and environment init (`substrate.tf`)

`substrate.tf` declares no resources. It turns `substrate_*` variables into the
env maps the services read, and decides which workloads receive them.

Everything is empty by default, and while `substrate_url` is blank **no
`SUBSTRATE_*` variable is emitted at all**. That is the state the code already
calls "not configured" (`DEFAULT_SUBSTRATE_URL = ''` in
`packages/shared-core/src/agent/substrate.js`): the pattern stays inert instead
of half-wired, and a run that asks for it refuses before admission rather than
mid-stream. Emitting the other keys anyway would be worse than emitting none — a
deployment that can resolve an atespace but cannot dial anything fails after the
run has been accepted.

```hcl
substrate_url             = "substrate-control.example.com:443" # the switch
substrate_ingress_url     = "https://actors.example.com"        # actor front door
substrate_atespace        = "tenant-t3f9a1b2c4d5"               # this deployment's space
substrate_atespace_by_org = { "01934-…" = "tenant-t3f9a1b2c4d5" } # shared stack: org → space
substrate_allowed_atespaces = ["tenant-t3f9a1b2c4d5"]           # names a request may select
substrate_actor_mode      = true                                # + substrate_jwks_url
substrate_actor_member    = "serviceAccount:substrate-actor@….iam.gserviceaccount.com"
environment_init_enabled  = true                                # org service
```

The same names as repository variables, which is how a deployment turns them on
(`Deploy to GCP → terraform → Terraform apply` passes every one of them; unset
means empty, so a merge cannot repoint production by itself):

```bash
# https://, not grpc://: the client dials with node:http2.connect(), which
# rejects any scheme other than http/https.
gh variable set SUBSTRATE_URL                --body "https://…"   # the switch
gh variable set SUBSTRATE_ATESPACE           --body "tenant-t3f9a2b4c6d8"
gh variable set SUBSTRATE_ATESPACE_BY_ORG    --body "01934-…=tenant-t3f9a2b4c6d8"  # comma-separated org=space
gh variable set SUBSTRATE_ALLOWED_ATESPACES  --body "tenant-t3f9a2b4c6d8,tenant-…" # comma-separated names
gh variable set SUBSTRATE_PLANNER_IMAGE      --body "sha256:…"      # digest, not a tag
gh variable set SUBSTRATE_WORKER_POOL        --body "planner-pool"  # optional: unset keeps the Terraform default
gh variable set SUBSTRATE_JWKS_URL           --body "https://…"     # with SUBSTRATE_ACTOR_MODE
gh variable set SUBSTRATE_ACTOR_MEMBER       --body "serviceAccount:substrate-actor@…"
```

Names whose Terraform default is already a real value (`substrate_worker_pool`,
`substrate_actor_jwt_audience`, `substrate_trust_domain`, `substrate_timeout_ms`,
`substrate_actor_ttl_ms`) are appended only when the repo variable is set: an
empty `-var` would override the default with `""`, which beats both Terraform and
an operator's org settings — the same reason `substrate.tf` omits a key rather
than emitting it blank.

**The harness cutover is gated.** #283 made substrate the only execution
pattern, and the apply that removes the Cloud Run `planner` / `coder-control` /
`coder-worker` services is the one that leaves production with no other way to
run an agent. It fails silently: an unset `substrate_url` is not an error, it is
a stack whose every run is refused as "not configured". So the apply step
greps its own plan for those destroys and stops if `SUBSTRATE_URL` is unset,
before `terraform apply`.

Where the address goes, and where it never goes:

| Workload | Gets | Why |
|---|---|---|
| orchestrator | control plane **+ actor callback pair** | it routes every run to an actor and is the only service with the endpoint that verifies an actor's JWT (`packages/shared/src/agent/framework.js` → `pattern-router.js`) |
| provisioner | control plane | `substrate.atespace` is a call to the control plane; without a URL the step answers SKIPPED forever |
| every other Cloud Run workload | nothing | stage executors inside the boundary. Teaching a workload the control-plane address hands whatever it runs the API that creates, assigns and deletes actors in **other tenants'** atespaces |
| substrate actor | the actor-JWT verification names only (forwarded by `upsertActorTemplate`) | the actor answers its own dispatch; it never drives the pattern |

`SUBSTRATE_TOKEN` (a bearer for the control plane, honoured at
`agent/substrate.js:244`) is deliberately unwired: a credential in these maps
would be printed by an agent `env` and reach every dispatcher. If the control plane
ever requires one it comes in through Secret Manager as a secret env.

**Environment init needs the provisioner, not the provisioning roles.**
`environment_init_enabled = true` publishes `substrate.atespace` on the
`provisioning_topic`, and the provisioner answers that action even with its own
`PROVISIONING_ENABLED=false` (`services/provisioner/src/handler.js:44`). So what
must *exist* is the SA, the service, the topic and the push subscription, and
what must *not* exist is the privilege:

```text
local.tenant_jobs_on = anytrue([provisioning_enabled, provisioner_enabled, environment_init_enabled])
local.provisioning_on = provisioning_enabled           # run.admin, pubsub.admin,
                                                       # cloudscheduler.admin, act-as
```

`run.admin` / `pubsub.admin` / `cloudscheduler.admin` / `serviceAccountUser` stay
behind `provisioning_enabled`: switching on "initialize my environment at login"
must not quietly acquire the ability to stand up tenant stacks. `provisioner_enabled`
is the third way — the receiver on its own, with no init flag and no project roles —
for a deployment that only wants actors to land in their own namespace. The
container's own switch forwards the variable (`PROVISIONING_ENABLED =
tostring(var.provisioning_enabled)`), so the service existing never means the
provisioner is permitted to provision. With provisioning off, `deploy.stack`
records itself COMPLETED with the org's status unchanged — a documented no-op, not
a failure.

**The actor callback is two halves of one decision.** `substrate_actor_mode =
true` plus `substrate_jwks_url` mounts the orchestrator's actor endpoint
(`packages/shared/src/agent/substrate-actor.js`), but Cloud Run answers 403
before that router runs unless the calling identity holds `roles/run.invoker` on
the orchestrator. `substrate_actor_member` names that identity and drives **both** —
`substrate.tf` emits the four `SUBSTRATE_ACTOR_*` names only when it is non-empty,
and `iam.tf` creates the binding from the same variable, with a precondition that
accepts a `serviceAccount:` email or a `principal://` workload identity and
refuses `allUsers` / `allAuthenticatedUsers`. Setting the env without the member
is a dead endpoint; an "anyone" member would be a public prompt endpoint on
behalf of any org, which is why neither half is reachable alone.

Two gaps that wiring these flags exposed:

- The org service had **no publisher grant** on the provisioning topic. A publish
  on its own ADC was a `Permission denied` that no plan mentioned, and it showed
  up as an init step parked in `RUNNING` — which reads as slowness.
- The provisioner container had `PROVISIONING_ENABLED = "true"` hardcoded, so an
  init-only deployment would have been able to create tenant stacks simply by
  existing.

Read the plan once with these on. `terraform output substrate` lists the
rendered env names plus `actor_endpoint` / `actor_invoker` — `actor_endpoint:
false` while `substrate_actor_mode = true` means one of the four gate conditions
failed, and `actor_invoker: ""` names which. `terraform output environment_init`
distinguishes `receiver_exists` / `org_can_publish` from `stack_roles_granted`;
the first two true and the third false is what an init-only deployment is
supposed to look like. You can also assert the split from the plan directly:

```bash
terraform plan -var=environment_init_enabled=true | grep 'roles/run.admin'   # must be empty
```

The CI contract is
[`deploy/gcp/substrate-env.test.js`](../deploy/gcp/substrate-env.test.js). It
checks name agreement, placement, the gate shapes **and the rendered env maps** —
the last group runs `terraform console`, so it needs a root that has been
`init`'ed **against its real backend**: `-backend=false` is not enough, because
`console` refuses to start with an uninitialized backend and this root's backend
is the GCS state bucket. Those renders therefore skip with the reason on a CI
runner that has no credentials, and run on any operator machine that has. Don't
"fix" that by adding `hashicorp/setup-terraform` to the Checks workflow —
installing the binary is the easy half; the missing piece is the backend.
What the structural assertions cannot see is a future local that quietly unions
existence with privilege, and that is what the `grep` above checks.

## Kagent runtime backend (`kagent.tf`)

OFF by default, and inert by default in the same way substrate is: the gateway
answers `GET /api/workflows/kagent/capabilities` with `enabled: false` and every
`POST /api/workflows/agents/:id/publish` on a `backend: 'kagent'` profile with
`503 kagent_not_configured`. Nothing errors — which is precisely why this needs
writing down: a root that renders no `KAGENT_*` env is indistinguishable from a
deployment that does not use kagent.

| Variable | Env name | Default |
|---|---|---|
| `kagent_enabled` | `KAGENT_ENABLED` | `false` |
| `kagent_api_url` | `KAGENT_API_URL` | `""` |
| `kagent_namespace` | `KAGENT_NAMESPACE` | `"kagent"` |
| `kagent_token_file` | `KAGENT_TOKEN_FILE` | `""` |
| `kagent_ca_file` | `KAGENT_CA_FILE` | `""` |
| `kagent_timeout_ms` | `KAGENT_TIMEOUT_MS` | `15000` |

Three things to know before turning it on:

- **The switch and the address are one gate.** `agent/kagent.js` returns no
  client unless `KAGENT_ENABLED` is truthy *and* an API URL resolves, so
  `kagent.tf` emits the pair together or not at all, and `KAGENT_ENABLED` is
  written as the literal `"true"` the parsing regex accepts.
- **Only paths cross into the env map.** The bearer is read from the file named
  by `kagent_token_file` (mounted as a Secret version, the way
  `MEMORY_DATABASE_URL_FILE` mounts `/secrets/memory-db/url`), and
  `KAGENT_KUBECONFIG` is deliberately not wired at all — a kubeconfig is a bundle
  of credentials and exists only for out-of-cluster development. Unset optional
  paths stay **absent** rather than `""`, because an empty path would beat the
  in-cluster mount that kagent.js falls back to and land in the same silent
  dark state as never opting in.
- **The gateway is the only recipient.** It hosts the publish endpoint and runs
  no model-generated code. The substrate map does reach planner and
  coder-control; kagent must not follow it there until something in those
  services imports the adapter, and it never reaches `coder_worker_env`. On the
  cluster side that means a namespaced Role granting the gateway's identity
  get/list/create/update/patch/delete on `*.api.kagent.dev` in `kagent_namespace`
  and on the ConfigMaps it composes there. `get` and `update` are not extras:
  applying an already-published agent is a read-then-replace, because the replace
  must name the stored `resourceVersion`, so a Role without either lets the first
  publish succeed and fails every later one. A wider binding than that and one
  tenant's publish reaches another tenant's agents.

`terraform output kagent` reports `configured`, `switch`, `api_url`, `namespace`,
`env_keys` and `services`; `switch: true` with an empty `api_url` is the
half-configured shape, and `configured: false` there means nothing was emitted.
The CI contract is
[`deploy/gcp/kagent-env.test.js`](../deploy/gcp/kagent-env.test.js), which checks
name agreement in both directions, the credential-shape rule, placement, the
two-part gate, and — the link no env-map check can see — that
`services/gateway/src/index.js` actually hands the adapter to the router.

Its `local.kagent_env` renders run on every CI machine, unlike the substrate
renders above: `kagent.tf`'s locals reference nothing but `var.kagent_*`, so the
test assembles those variable blocks plus the locals file into a scratch root with
no backend and no providers. Same HCL, same values, no credentials needed — and it
proves the thing the renders were ever for, that the string crossing into
`KAGENT_ENABLED` is one `config.js` reads as true.
## Gateway Direct VPC egress (`cloud_run.tf`)

Cloud Run gen2 can put a service's private traffic on a VPC without a Serverless
VPC Access connector. The gateway carries that as an optional block:

```hcl
gateway_vpc_egress_enabled = true                # default false → no block at all
vpc_network                = "default"           # var.vpc_name of terraform-substrate-gke
vpc_subnet                 = "substrate-subnet"  # must be in var.region
vpc_egress_mode            = "PRIVATE_RANGES_ONLY" # or "ALL_TRAFFIC"
```

```bash
gh variable set GATEWAY_VPC_EGRESS_ENABLED --body "true"   # default: unset = false
gh variable set VPC_NETWORK                --body "default"
gh variable set VPC_SUBNET                 --body "substrate-subnet"
gh variable set VPC_EGRESS_MODE            --body "PRIVATE_RANGES_ONLY"  # optional
```

Why each piece is shaped the way it is:

- **Off renders nothing.** `vpc_access` sits inside a `dynamic` over
  `var.gateway_vpc_egress_enabled ? [1] : []`, so a disabled deployment keeps the
  template byte-identical to before instead of carrying an empty block the API
  would still record as a request for VPC configuration.
- **`network_interfaces` is plural.** The provider has no singular
  `network_interface` argument here, and `terraform validate` rejects it (CI runs
  that before any apply). `connector` is deliberately unused — same destination,
  plus a throughput ceiling and another resource to babysit.
- **Both names are required when on.** A `precondition` refuses the plan if
  `gateway_vpc_egress_enabled` is true with either `vpc_network` or `vpc_subnet`
  empty, because "switched on, changed nothing" is the worst state for a flag.
- **`ALL_TRAFFIC` is a different dependency set.** It sends *everything* through
  the VPC, so third-party calls (GitHub, Linear, the LLM hosts, the egress proxy)
  then need the project's Cloud NAT. `PRIVATE_RANGES_ONLY` routes only RFC1918 and
  VPC ranges and leaves the working public path alone.
- **The source IP changes.** Egress instances take addresses from the
  subnetwork's **primary** range (not its `pods`/`services` secondary ranges), so
  whatever allow-lists the old Cloud Run IPs has to learn the range.

**This is plumbing, not a feature — and there is currently nothing on the other
end.** It gives the gateway a route *onto* the VPC; it does not create a
VPC-reachable ateapi endpoint, because `Service api` in `ate-system` is headless
(`ClusterIP: None`) and no internal LB for it exists in this repo. Read
[SUBSTRATE_STATUS.md](SUBSTRATE_STATUS.md) pending 2 before switching it on
expecting a control plane.

The CI contract is
[`deploy/gcp/gateway-vpc-egress.test.js`](../deploy/gcp/gateway-vpc-egress.test.js).

## Observability and alerting (`observability.tf`)

OFF by default. `observability_enabled = true` creates one GCS log bucket
(`<project_id>-aifleet-logs`, objects retired after
`observability_log_retention_days`), a per-service log sink (plus one per Cloud
Run **Job** — a job logs under `cloud_run_job`, so a revision-only filter misses
the hourly money run), four log-based metrics and an alert policy per metric.

| Signal | Log line it counts | Why it pages |
|---|---|---|
| `fleet_egress_cred_unavailable` | `egress cred_unavailable` (sidecar) | the egress boundary refused to inject a credential — fail-closed, so a run either died or fell back to a key nobody meant it to have |
| `fleet_egress_no_route` | `egress no_route` (sidecar) | unmatched prefix. One is a mis-set base URL; a burst is somebody testing whether the sidecar relays |
| `fleet_cost_price_fallback` | `cost estimate priced an unmodeled provider…` | a usage row was priced by guess (`priceMatch=Default`); add the provider to `billing/pricing.js` |
| `fleet_balance_under_<paise>` | `billing balance crossed an alert threshold` | an org's ledger crossed a threshold; the in-product notice already fired, this is the operator-side copy |

Two prerequisites, both silent if wrong:

- **`LOG_FORMAT=json`** is set in `local.common_env`, and it is load-bearing.
  Cloud Logging builds `jsonPayload` only from a line that parses as JSON, so on
  text logs every filter above exists, reads zero, and alerts on nothing.
  `deploy/gcp/observability-config.test.js` asserts the deployment env and every
  filter against the code that emits the line.
- **`observability_notification_channels`** must list at least one channel
  resource name, or no policy is created. The provider cannot make channels and
  email/SMS channels are deprecated upstream, so create a **Pub/Sub topic**
  channel by hand and let a subscriber fan out. Metrics are still collected with
  an empty list; nothing will tell anyone.

The balance thresholds are **not written in HCL**: `alert_thresholds.json` is
generated from `DEFAULT_ALERT_THRESHOLDS_PAISE` in
`packages/shared-core/src/billing/ledger.js` and read by `observability.tf` with
`jsondecode(file(...))`. Do not "tidy" it into a `*.auto.tfvars.json` — that root
gitignores `*.tfvars*` because those files hold real secrets, so a generated
input there would never reach CI and a fresh clone would silently build no
balance alerts:

```bash
npm run observability:inputs        # regenerate after changing the ledger constant
npm run observability:inputs:check  # CI gate
```

Not here, on purpose: GKE Managed Prometheus (disabled in the GKE root because
nothing in this repo scrapes it — log-based metrics answer these four questions),
per-route/per-org metric labels (the `no_route` prefix is attacker-selected, so
labelling it hands anyone on the internet a cardinality-billing lever), a latency
histogram (bucket boundaries for a 404 and a five-minute agent stream in one
histogram would be a guess that renders as a chart), and the Python services
(`org`, `settings` don't use `logger.js`, so they emit no `jsonPayload.meta.*`).

Cost, since both halves are billed: user-defined log-based metrics count as Cloud
Monitoring custom metrics, and the sink bills GCS storage plus write requests.

## Verify a deploy

- `curl https://<gateway>/healthz` → `{"status":"ok"}`.
- Open the GCS SPA URL, sign in via Google, submit a planner/coder request, and
  confirm SSE steps stream in.
- Confirm a direct unauthenticated call to the orchestrator URL is rejected,
  and that everything scales to zero when idle.
