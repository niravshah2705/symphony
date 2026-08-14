# Manual local workflows and GitHub Actions wrappers

Operational logic is implemented in repository scripts and is intended to run
from an operator machine. The five GitHub Actions workflows are thin,
`workflow_dispatch`-only alternatives that call those same commands with WIF or
`GITHUB_TOKEN` authentication. None runs from a pull request, push, merge, tag,
path change, or schedule.

| Operation | Canonical local command | Manual GitHub alternative |
|---|---|---|
| Checks | `npm run checks` or `npm run checks -- --suite <suite>` | `gh workflow run checks.yml -f suite=all` |
| CLI release | `npm run cli:release -- --version <semver> [--dry-run]` | `gh workflow run cli-release.yml -f version=<semver>` |
| GCP deploy | `npm run gcp:deploy` with `-- --since <ref>`, `--all`, or `--plan` as needed | `gh workflow run deploy.yml -f deploy_all=<bool> -f changed_since=<ref>` |
| Skills publish | `npm run skills:publish` with `-- --dry-run` (optional `--version` must match the manifest) | `gh workflow run publish-skills.yml -f version=<manifest-version>` |
| Harness registry | `npm run registry:publish` or `npm run registry:publish -- --dry-run` | `gh workflow run sync-harness-registry.yml` |

Run the local commands from the repository root. Every mutating release/deploy/
publish command requires a clean committed worktree. Deployment planning and
the skills/registry dry runs skip cloud access and the clean-tree gate; the CLI
release dry run still stages and validates committed `HEAD` and requires it to
be clean.

## Local operator setup

Install Node.js 22+, Docker, Terraform, the Google Cloud CLI (including
`gsutil`), `jq`, and the GitHub CLI when cutting releases. Authenticate the
operator account rather than putting credentials on a command line:

```bash
gcloud auth login
gcloud auth application-default login
gh auth login
```

Create the ignored deployment configuration from the committed template:

```bash
cp deploy/gcp/.env.example deploy/gcp/.env
chmod 600 deploy/gcp/.env
```

At minimum, set `GCP_PROJECT_ID`, `GCP_REGION`, `SPA_BUCKET`,
`TF_STATE_BUCKET`, and `INTERNAL_API_TOKEN`. The same file supplies optional
Firebase/auth, skills, registry, pipeline, provisioning, and SMTP switches.
Command-line options such as `--since`, `--all`, `--plan`, and `--dry-run`
override the corresponding defaults. The skills publisher's `--version` is a
provenance assertion and must equal the committed manifest version.

## Bootstrap a new GCP project

Run the idempotent bootstrap before the first deployment. It enables APIs,
creates and versions the Terraform state bucket, creates the Pub/Sub service
identity, creates/seeds Secret Manager resources, imports them into Terraform
state, and applies the Artifact Registry prerequisite:

```bash
PROJECT_ID=my-proj \
LINEAR_API_KEY=lin_... \
INTERNAL_API_TOKEN='<strong-random-value>' \
  ./deploy/gcp/bootstrap.sh

npm run gcp:deploy -- --all
```

SMTP authentication is all-or-none: pass `EMAIL_SMTP_USER`,
`EMAIL_SMTP_PASSWORD`, `EMAIL_SMTP_HOST`, and `EMAIL_FROM` together during
bootstrap. Credential values go to Secret Manager; `.env` carries only the
configuration/mount switches.

Two console actions remain: link billing, then enable the Google sign-in
provider in Firebase Authentication. Add the Firebase Hosting domain and the
gateway host to authorized domains if they are not already present.

## Selective deployment behavior

`npm run gcp:deploy` compares `HEAD^...HEAD` by default. `--since <ref>` compares
the merge base of that ref with `HEAD`; `--all` bypasses path selection; and
`--plan` prints the JSON plan before any cloud access. Documentation-only
changes produce an empty plan.

| Changed paths | Planned work |
|---|---|
| A service directory or its Dockerfile | Build that service at the full `HEAD` SHA and apply Terraform |
| `packages/shared/**` or `packages/shared-core/**` | Rebuild every shared-package image consumer except the independent org service, then apply Terraform |
| Root `package.json` or lockfile | Rebuild those same dependency consumers, deploy the SPA, and apply Terraform |
| `services/org/**` | Rebuild org-service and apply Terraform |
| `services/settings/**` | Rebuild settings-service and apply Terraform |
| `deploy/gcp/terraform/**` | Apply Terraform; when the durable pipeline is enabled, also build its stage images |
| `services/proxy/**` or its Dockerfile | Apply Terraform and build the proxy |
| `public/**`, `firebase.json`, or SPA/deploy tooling | Stage and deploy the Firebase Hosting SPA |
| `--all` | Build every image, deploy the SPA, and apply Terraform |

Any plan that applies Terraform also includes the proxy build. Changed images
use the exact full 40-character `HEAD` SHA. Unchanged services keep the
immutable 40-character tag resolved from their live Cloud Run revision; the
deployment fails closed if a required live tag cannot be resolved. Disabled
optional services do not require a live revision.

The default `HEAD^` comparison covers only the newest commit. When a manual
deployment did not run for every commit, pass the last successfully deployed
ref with `--since` (or select `deploy_all` in the wrapper); otherwise earlier
accumulated path changes are outside the selective plan.

A real deployment refuses a dirty worktree. It uses both a per-project local
lock and a generation-fenced object in the Terraform state bucket, so local and
hosted runs cannot overlap across machines. It builds and pushes only the
planned images, deploys the SPA when selected, and then performs one full
Terraform apply with the complete variable set. Inspect any stale deployment
lock before removing it manually.

## SPA release staging

The deploy command copies `public/` to a temporary directory and runs
`scripts/obfuscate-spa.js` there. It generates a deployment-only `config.js`
with the deterministic Cloud Run gateway URL, rewrites a temporary
`firebase.json` to point at that staging directory, and publishes with Firebase
Hosting. The tracked `public/config.js` is never rewritten or restored.

`SPA_OBFUSCATION_STRENGTH` accepts `light` (default), `balanced`, or `maximum`.
Property/global renaming remains disabled so native ES-module exports and DOM
contracts survive. Obfuscation only raises the effort to inspect browser code;
it is not a secret boundary.

## Enable the manual GitHub wrappers

Local execution needs no GitHub deployment setup. To also enable hosted manual
dispatch, authenticate `gh` and include `REPO=owner/repo` during bootstrap:

```bash
PROJECT_ID=my-proj \
REPO=owner/repo \
LINEAR_API_KEY=lin_... \
INTERNAL_API_TOKEN='<strong-random-value>' \
  ./deploy/gcp/bootstrap.sh
```

This creates `gh-deployer`, grants its scoped project roles, creates a GitHub
OIDC workload identity pool/provider bound to that exact repository, and writes
the wrapper configuration:

- Secrets: `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `INTERNAL_API_TOKEN`.
- Required variables: `GCP_PROJECT_ID`, `GCP_REGION`, `SPA_BUCKET`,
  `TF_STATE_BUCKET`, `TF_STATE_PREFIX`, `AR_REPO`, `FIRESTORE_LOCATION`, and
  `SPA_ORIGIN`.
- Optional variables: Firebase/auth, SMTP, pipeline/provisioning,
  `SKILLS_BUCKET`, `SKILLS_VERSION`, and `REGISTRY_BUCKET` settings used by the
  relevant wrapper.

If `gh` is unavailable, bootstrap prints the values that must be entered
manually. WIF is keyless: no service-account JSON key belongs in GitHub.

Examples:

```bash
# Selective deployment from a chosen baseline
gh workflow run deploy.yml \
  -f deploy_all=false \
  -f changed_since=HEAD^

# Full first deployment or explicit convergence
gh workflow run deploy.yml \
  -f deploy_all=true \
  -f changed_since=HEAD^

# Other wrappers
gh workflow run checks.yml -f suite=all
gh workflow run cli-release.yml -f version=1.2.0
gh workflow run publish-skills.yml -f version=v1  # must match skills-manifest.json
gh workflow run sync-harness-registry.yml
```

The wrapper inputs are operator-controlled, but deployments and releases still
bind output to the checked-out full commit SHA. GitHub concurrency protects
wrapper runs. Skills and registry publishers also acquire atomic objects under
`gs://<bucket>/.locks/`, which serializes local operators with hosted wrappers.
If a process is interrupted and leaves a stale lock, inspect it and confirm no
publisher is active before removing that object manually.

## Branch protection and verification

Because Checks is no longer triggered automatically, remove obsolete required
`Checks` status contexts from branch protection. Contributors run
`npm run checks` locally and record the result in the pull request. A maintainer
can manually dispatch the wrapper when a GitHub-hosted confirmation is useful.

After a deployment:

- `curl https://<gateway>/healthz` returns `{"status":"ok"}`.
- The Firebase Hosting SPA signs in and streams planner/coder progress.
- Direct unauthenticated access to internal services is rejected.
- Cloud Run images use immutable full-SHA tags and unchanged services retain
  their previous tag.

`cloudbuild.yaml` remains a separate, manually submitted GCP pipeline. It is not
invoked by these workflows or by repository events.
