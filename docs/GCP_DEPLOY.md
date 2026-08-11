# GCP deployment (no-cost design)

AI Fleet runs the same code in two profiles, selected entirely by environment
variables. Nothing GCP-specific is required for local development.

## Architecture

- **SPA** → static files on a **GCS bucket** (free-tier hosting). The SPA calls
  the gateway API cross-origin; `public/config.js` carries the gateway URL.
- **gateway** → public **Cloud Run** service (API-only, scale-to-zero). Verifies
  the **Firebase ID token** on every request, publishes planner/coder requests to
  **Pub/Sub**, and serves **SSE** fed by **Firestore** `onSnapshot`.
- **planner** / **coder-control** → internal Cloud Run services (scale-to-zero),
  woken by Pub/Sub push + Cloud Scheduler ticks.
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
`AUTH_MODE=firebase`, project/region, topic names, push audience + SA, and the
gateway's `SPA_ORIGIN` / `API_BASE_URL` / `STREAM_TOKEN_SECRET`. The public
Firebase web config (`FIREBASE_API_KEY` / `FIREBASE_AUTH_DOMAIN`) is injected by
Terraform from the managed web app — no manual key needed; `FIREBASE_PROJECT_ID`
defaults to the project id, and `FIREBASE_ALLOWED_DOMAIN` is optional.

### Deploy — one-shot script (recommended)

`deploy/gcp/deploy.sh` does the whole thing from an operator machine (idempotent):
enables APIs, creates the Terraform state bucket, stages Secret Manager versions
(auto-generates `stream-token-secret`), builds + pushes the shared images,
publishes the SPA to GCS, and applies Terraform in the correct staged order.

```bash
PROJECT_ID=my-proj \
SPA_BUCKET=my-proj-aifleet-spa \        # globally-unique
TF_STATE_BUCKET=my-proj-tfstate \
LINEAR_API_KEY=lin_... \                # required (services won't start without it)
./deploy/gcp/deploy.sh
```

Optional env: `REGION`, `AR_REPO`, `IMAGE_TAG`, `FIRESTORE_LOCATION`, `SPA_ORIGIN`,
`FIREBASE_ALLOWED_DOMAIN` (empty = any verified user), `GITHUB_TOKEN`,
`LANGSMITH_API_KEY`, `SKIP_BUILD=1` (reuse pushed images), plus
`EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USER`,
`EMAIL_SMTP_PASSWORD`, and `EMAIL_FROM` for transactional email. The script
defaults `EMAIL_PUBLIC_APP_URL` to the exact GCS `index.html` URL it publishes;
override it only when a custom domain/CDN serves the SPA. It prints the gateway
URL + SPA URL and the Firebase authorized domains to register.

### Deploy — CI (Cloud Build)

`gcloud builds submit --config cloudbuild.yaml --substitutions=_BUCKET=...,_TF_STATE_BUCKET=...`
runs the same build → SPA-publish → staged `terraform apply` in Cloud Build.
Seed the required agent Secret Manager versions first (the one-shot/bootstrap
scripts do this for you). SMTP credentials use the acyclic flow below.

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

### After either path

In the **Firebase console**: enable the **Google** sign-in provider
(Authentication → Sign-in method), and add the printed gateway URL and the SPA's
GCS origin to Authentication → Settings → **Authorized domains**.

## Skills registry (versioned, GCS + gcsfuse)

The deep-agent **skills** (`packages/shared/src/agent/skills/<skill>/SKILL.md`) can
be served from a **GCS bucket** instead of only the copy baked into the image, so a
skill edit ships without rebuilding/redeploying a service — and so multiple skill
**versions coexist** and a running deployment stays pinned to a known-good one.

**How it fits together**

- **Manifest** — `packages/shared/src/agent/skills/skills-manifest.json` records the
  bundle `version`, `updatedAt`, and a per-skill `{ name, version }` list (mirrors
  `llm-presets.json`). The bundle `version` (e.g. `v1`) is the release token used
  everywhere below.
- **CI publish** — `.github/workflows/publish-skills.yml` runs on any push touching
  `packages/shared/src/agent/skills/**` (or `workflow_dispatch` with a `version`
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
  `packages/shared/src/agent/skills` — existing behavior, unchanged.

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
`packages/shared/src/agent/skills/**`. No `SKILLS_BUCKET` repo variable is
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
- **CORS** reflects only the exact `SPA_ORIGIN` (never `*` with credentials).
- Secrets live in **Secret Manager**, never in images or committed files
  (`data/` stays gitignored).

## Verify a deploy

- `curl https://<gateway>/healthz` → `{"status":"ok"}`.
- Open the GCS SPA URL, sign in via Google, submit a planner/coder request, and
  confirm SSE steps stream in.
- Confirm a direct unauthenticated call to the planner/coder URL is rejected,
  and that everything scales to zero when idle.
