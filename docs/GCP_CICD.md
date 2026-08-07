# GitHub Actions CD (deploy on merge to main)

`.github/workflows/deploy.yml` runs on every merge to `main`, but it is
**path-filtered** — a merge only does the work its diff actually requires.
Auth is **keyless** via Workload Identity Federation (WIF) — no service-account
key is stored in GitHub.

## Path-filtered deploys

A `changes` job (via `dorny/paths-filter`) computes a work plan; downstream jobs
are conditional on it:

| Changed paths | What runs |
|---|---|
| `services/gateway/**` (or its Dockerfile) | rebuild **gateway** image → `terraform apply` rolls **only** gateway |
| `services/planner/**` / `services/coder/**` | rebuild that image → apply rolls **only** that service (coder ⇒ coder-control + the worker Job) |
| `packages/shared/**`, root `package.json`/`package-lock.json` | rebuild **all three** images → apply rolls all |
| `deploy/gcp/terraform/**` | `terraform apply` **only** (no image rebuild) |
| `public/**`, `firebase.json` | **Firebase Hosting** deploy only (no images, no Terraform) |
| docs / anything else | nothing runs |

How "roll only one service" works: each unchanged service keeps its
**currently-deployed** image tag (resolved live from Cloud Run) while the
rebuilt service gets the new commit SHA, so `terraform apply` is a no-op for
everything except the service that changed (see the per-service
`*_image_tag` vars in `terraform/{variables,locals}.tf`).

Need a full rebuild + apply of everything (e.g. after a manual hotfix or to
re-converge state)? Trigger the workflow manually with **`deploy_all: true`**
(Actions → Deploy to GCP → Run workflow).

One-time setup below (values pre-filled for project `adlc-9e72f`, number
`819642330335`, repo `niravshah2705/symphony` — change if yours differ).

## 1. Deployer service account + roles

Terraform manages the whole stack, so the deployer SA needs broad admin on the
managed services (still least-privilege vs. Owner — no billing/org access):

```bash
PROJECT=adlc-9e72f
gcloud iam service-accounts create gh-deployer --project "$PROJECT" \
  --display-name "GitHub Actions deployer"
DEPLOYER="gh-deployer@${PROJECT}.iam.gserviceaccount.com"

for role in \
  roles/run.admin roles/cloudscheduler.admin roles/pubsub.admin \
  roles/artifactregistry.admin roles/datastore.owner roles/secretmanager.admin \
  roles/storage.admin roles/iam.serviceAccountAdmin roles/iam.serviceAccountUser \
  roles/resourcemanager.projectIamAdmin roles/serviceusage.serviceUsageAdmin \
  roles/firebase.admin roles/firebasehosting.admin roles/identityplatform.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${DEPLOYER}" --role="$role" --condition=None >/dev/null
done
```

## 2. Workload Identity Federation (bind the SA to this repo)

```bash
PROJECT=adlc-9e72f; PROJNUM=819642330335; REPO=niravshah2705/symphony
DEPLOYER="gh-deployer@${PROJECT}.iam.gserviceaccount.com"

gcloud iam workload-identity-pools create github \
  --project "$PROJECT" --location global --display-name "GitHub"

gcloud iam workload-identity-pools providers create-oidc github-oidc \
  --project "$PROJECT" --location global --workload-identity-pool github \
  --display-name "GitHub OIDC" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition "assertion.repository=='${REPO}'"

# Only this repo may impersonate the deployer SA.
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJNUM}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"
```

Provider resource name (for the `GCP_WIF_PROVIDER` secret):
```
projects/819642330335/locations/global/workloadIdentityPools/github/providers/github-oidc
```

## 3. GitHub repo secrets + variables

```bash
# Secrets (Settings → Secrets and variables → Actions → Secrets)
gh secret set GCP_WIF_PROVIDER --repo niravshah2705/symphony \
  --body "projects/819642330335/locations/global/workloadIdentityPools/github/providers/github-oidc"
gh secret set GCP_DEPLOYER_SA --repo niravshah2705/symphony \
  --body "gh-deployer@adlc-9e72f.iam.gserviceaccount.com"

# Variables (non-secret; Firebase web API key is public by design)
gh variable set GCP_PROJECT_ID   --repo niravshah2705/symphony --body "adlc-9e72f"
gh variable set GCP_REGION       --repo niravshah2705/symphony --body "asia-south1"
gh variable set SPA_BUCKET       --repo niravshah2705/symphony --body "adlc-9e72f-aifleet-spa"
gh variable set TF_STATE_BUCKET  --repo niravshah2705/symphony --body "adlc-9e72f-tfstate"
gh variable set FIREBASE_API_KEY --repo niravshah2705/symphony --body "AIzaSyBBofGcIZP_JzcCHmuhAkoa_sMpdTWj5_8"
# Optional: gh variable set FIREBASE_ALLOWED_DOMAIN --repo niravshah2705/symphony --body "yourco.com"
```

## Prerequisites the pipeline assumes

- **Secret Manager values already seeded** (the pipeline never creates/rotates them):
  `stream-token-secret` and `linear-api-key` must have a version, or the Cloud Run
  revisions won't start. `deploy/gcp/deploy.sh` seeds these; or add manually:
  ```bash
  printf 'REPLACE' | gcloud secrets versions add linear-api-key --project adlc-9e72f --data-file=-
  ```
- The `TF_STATE_BUCKET` exists (created by `deploy.sh` / the first manual apply).
- Firebase console: Google provider enabled + gateway URL and SPA origin in
  **Authorized domains** (see docs/GCP_DEPLOY.md).

## Notes

- Keyless (WIF) — no static SA key in GitHub (cicd-pipeline checklist).
- `concurrency: gcp-deploy` serializes applies so two merges never race the state.
- A rebuilt service's image tag is the commit SHA, so it rolls a fresh Cloud Run
  revision; unchanged services keep their live tag and are left untouched.
- No untrusted event input (PR/commit text, `head_ref`) is used in any `run:` step.
- Path filters read only file paths (`dorny/paths-filter`), never event text.
