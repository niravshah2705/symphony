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
(auto-generates `stream-token-secret`), builds + pushes the three images,
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
`LANGSMITH_API_KEY`, `SKIP_BUILD=1` (reuse pushed images). The script prints the
gateway URL + SPA URL and the Firebase authorized domains to register.

### Deploy — CI (Cloud Build)

`gcloud builds submit --config cloudbuild.yaml --substitutions=_BUCKET=...,_TF_STATE_BUCKET=...`
runs the same build → SPA-publish → staged `terraform apply` in Cloud Build.
Create the Secret Manager versions first (the script does this for you).

### After either path

In the **Firebase console**: enable the **Google** sign-in provider
(Authentication → Sign-in method), and add the printed gateway URL and the SPA's
GCS origin to Authentication → Settings → **Authorized domains**.

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
