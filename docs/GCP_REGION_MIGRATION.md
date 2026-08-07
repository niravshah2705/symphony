# Region migration — moving the stack to India (`asia-south1`)

This repo's default region is now **`asia-south1`** (Mumbai). Merging the region
PR only changes **defaults** — it does **not** move the running deployment,
because a region move is a destroy-and-recreate for several resources and an
irreversible data decision for Firestore. Follow this runbook to cut over.

## What moves vs. what doesn't

| Resource | Behavior on region change |
|---|---|
| Cloud Run gateway / planner / coder-control + coder-worker Job | **Recreated** in the new region (`location` is force-new). **New gateway URL.** Brief downtime. |
| Artifact Registry repo | Recreated in the new region — images must be **rebuilt** there. |
| GCS SPA bucket | Recreated (bucket location is immutable). Harmless — the SPA is on Firebase Hosting now. |
| Cloud Scheduler jobs | Recreated in the new region. |
| Cloud Run IAM bindings | Follow their services. |
| Pub/Sub topics/subs, Secret Manager (auto-replicated), IAM, service accounts, WIF, Firebase Hosting | **Global — no change.** |
| **Firestore** | **Cannot move in place** (`location_id` is immutable). Stays in `nam5` unless you migrate the data — see below. |

New URLs after cutover (project number `819642330335`):

```
gateway  https://gateway-819642330335.asia-south1.run.app
planner  https://planner-819642330335.asia-south1.run.app   (internal)
coder    https://coder-control-819642330335.asia-south1.run.app (internal)
AR repo  asia-south1-docker.pkg.dev/adlc-9e72f/ai-fleet
```

`public/config.js` (the SPA's `__API_BASE__`) and the gateway CORS allowlist are
regenerated automatically by CD, so the SPA follows the new gateway URL with no
manual edit. The SPA origin (`…web.app`) is unchanged.

## 1. Cut over the relocatable resources

```bash
# Point CD at India (this is the switch that actually moves things):
gh variable set GCP_REGION --repo niravshah2705/symphony --body "asia-south1"

# Rebuild ALL images into the new-region registry AND terraform-apply the move.
# A normal merge only builds changed services, so use the deploy_all escape hatch:
#   GitHub → Actions → "Deploy to GCP" → Run workflow → deploy_all: true
gh workflow run deploy.yml -f deploy_all=true --repo niravshah2705/symphony
```

The single apply destroys the `us-central1` Cloud Run services / Job / AR repo /
GCS bucket / Scheduler jobs and creates fresh ones in `asia-south1` — no manual
cleanup of the old region is required (Terraform owns them).

## 2. Firestore — pick ONE (this is the data decision)

Firestore currently lives in **`nam5`** and holds settings / conversations /
issue state. Its location is permanent.

### Option A — Keep Firestore in the US (no data loss, default)
Do nothing. Leave the `FIRESTORE_LOCATION` repo var unset (→ `nam5`). Compute
runs in India, Firestore in the US. Works, but adds India↔US round-trip latency
on every store read/write. You can migrate later.

### Option B — Recreate it empty in India (data loss)
Only if the current data is disposable.

```bash
# 1) Delete the existing (default) database — THIS DELETES ALL DATA.
gcloud firestore databases delete --database="(default)" --project adlc-9e72f

# 2) Tell CD to create Firestore in India, then re-apply.
gh variable set FIRESTORE_LOCATION --repo niravshah2705/symphony --body "asia-south1"
gh workflow run deploy.yml -f deploy_all=true --repo niravshah2705/symphony
```

### Option C — Migrate the data (export → import, preserves data)
Brief downtime while the database is recreated.

```bash
PROJECT=adlc-9e72f
BUCKET=gs://${PROJECT}-firestore-export      # create in a nearby region first:
gcloud storage buckets create "$BUCKET" --project "$PROJECT" --location asia-south1

# 1) Export the current (nam5) database.
gcloud firestore export "$BUCKET/pre-india" --project "$PROJECT"

# 2) Recreate (default) in India (deletes the nam5 DB — data is safe in the export).
gcloud firestore databases delete --database="(default)" --project "$PROJECT"
gh variable set FIRESTORE_LOCATION --repo niravshah2705/symphony --body "asia-south1"
gh workflow run deploy.yml -f deploy_all=true --repo niravshah2705/symphony   # creates the India DB

# 3) Import into the new India database.
gcloud firestore import "$BUCKET/pre-india" --project "$PROJECT"
```

## 3. Post-cutover checks

- `curl -sI https://gateway-819642330335.asia-south1.run.app/api/auth/config` → `200`.
- Open `https://adlc-9e72f.web.app`, sign in with Google, confirm the workspace
  loads and SSE streams. If sign-in popup errors on an unauthorized domain, add
  the new gateway `run.app` host under Firebase Auth → **Authorized domains**
  (the SPA origin `web.app` is already authorized and unchanged).
- `gcloud run services list --project adlc-9e72f --region asia-south1` shows the
  three services; the `us-central1` ones are gone.

## Rollback

```bash
gh variable set GCP_REGION --repo niravshah2705/symphony --body "us-central1"
gh workflow run deploy.yml -f deploy_all=true --repo niravshah2705/symphony
```

(If you migrated Firestore, also reverse `FIRESTORE_LOCATION` and re-run the
export/import in the other direction — the data won't come back on its own.)
