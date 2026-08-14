# Region migration — moving the stack to India (`asia-south1`)

This repo's default region is **`asia-south1`** (Mumbai). Changing a repository
default does **not** move a running deployment: the operator must change the
deployment configuration and run a full apply. A region move is a
destroy-and-recreate operation for several resources and an irreversible data
decision for Firestore. Follow this runbook to cut over.

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

The deployment stages a generated `config.js` (the SPA's `__API_BASE__`) and
updates the gateway CORS allowlist through Terraform, so the Firebase Hosting
SPA follows the new gateway URL without editing tracked source. The SPA origin
(`…web.app`) is unchanged.

## 1. Cut over the relocatable resources

Point the canonical local deployment at India by editing `deploy/gcp/.env`:

```dotenv
GCP_REGION=asia-south1
```

Re-run the bootstrap layer in the new region so the destination Artifact
Registry exists before image builds. Supply the same custom bucket values used
in `deploy/gcp/.env` if they differ from these defaults:

```bash
PROJECT_ID=adlc-9e72f \
REGION=asia-south1 \
SPA_BUCKET=adlc-9e72f-aifleet-spa \
TF_STATE_BUCKET=adlc-9e72f-tfstate \
  ./deploy/gcp/bootstrap.sh
```

Then rebuild every image into the new-region registry and apply the move:

```bash
npm run gcp:deploy -- --all
```

The deployment requires a clean committed `HEAD` and ambient `gcloud`
authentication.

For the manual GitHub wrapper, update its repository variable and explicitly
dispatch the full deployment:

```bash
gh variable set GCP_REGION --repo niravshah2705/symphony --body "asia-south1"
gh workflow run deploy.yml -f deploy_all=true -f changed_since=HEAD^ \
  --repo niravshah2705/symphony
```

The bootstrap's targeted prerequisite apply moves Artifact Registry; the full
deployment then replaces the `us-central1` Cloud Run services / Job / GCS
bucket / Scheduler jobs with `asia-south1` resources. No manual cleanup of the
old region is required because Terraform owns them.

## 2. Firestore — pick ONE (this is the data decision)

Firestore currently lives in **`nam5`** and holds settings / conversations /
issue state. Its location is permanent.

### Option A — Keep Firestore in the US (no data loss, default)
Keep `FIRESTORE_LOCATION=nam5` in `deploy/gcp/.env` (or leave the manual
wrapper's repository variable unset). Compute runs in India, Firestore in the
US. This preserves data but adds India↔US round-trip latency on every store
read/write. You can migrate later.

### Option B — Recreate it empty in India (data loss)
Only if the current data is disposable.

```bash
# 1) Delete the existing (default) database — THIS DELETES ALL DATA.
gcloud firestore databases delete --database="(default)" --project adlc-9e72f

# 2) Set FIRESTORE_LOCATION=asia-south1 in deploy/gcp/.env, then re-apply.
npm run gcp:deploy -- --all
```

### Option C — Migrate the data (export → import, preserves data)
Brief downtime while the database is recreated.

```bash
PROJECT=adlc-9e72f
BUCKET=gs://${PROJECT}-firestore-export      # create in a nearby region first:
gcloud storage buckets create "$BUCKET" --project "$PROJECT" --location asia-south1

# 1) Export the current (nam5) database.
gcloud firestore export "$BUCKET/pre-india" --project "$PROJECT"

# 2) Recreate (default) in India (deletes nam5; data is safe in the export).
gcloud firestore databases delete --database="(default)" --project "$PROJECT"
# Set FIRESTORE_LOCATION=asia-south1 in deploy/gcp/.env, then create the India DB:
npm run gcp:deploy -- --all

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
  enabled shared-stack services; the `us-central1` ones are gone.

## Rollback

```bash
# Restore GCP_REGION=us-central1 in deploy/gcp/.env, then:
npm run gcp:deploy -- --all
```

For the manual wrapper, set the `GCP_REGION` repository variable back to
`us-central1` and dispatch `deploy.yml` with `deploy_all=true`.

(If you migrated Firestore, also reverse `FIRESTORE_LOCATION` and re-run the
export/import in the other direction — the data won't come back on its own.)
