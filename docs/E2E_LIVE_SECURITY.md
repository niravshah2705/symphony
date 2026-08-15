# Live QA E2E security journey

This runbook covers the recorded Chrome journey in
`.github/workflows/e2e-live.yml`. It is a deliberately destructive QA test: it
creates a synthetic Linear issue and runs the real `plan -> code -> test ->
deploy` path after the read-only audit and security checks pass.

The workflow is not a production smoke test. In this document, "all
environments" means the application surfaces and all four pipeline stages. The
deployment target must be one of `qa`, `test`, `testing`, `stage`, `staging`,
`dev`, or `development`. Run an independent, separately protected workflow if a
second non-production stack needs the same evidence. Never point this workflow
at production or a shared customer repository.

## What the journey proves

The serial suite records three related scenarios:

1. A signed-out visitor can use the explicitly public chat capabilities (a
   generic greeting, project questions, and RAG questions), but both the UI and
   API reject an attempt to execute the pipeline.
2. Tenant A and Tenant B can use their own data. A signed-in user cannot obtain
   the other tenant's objects by changing the UI context, request headers, or
   object identifiers.
3. Tenant A creates one synthetic work item and completes the real plan, code,
   test, approval, deploy, and health-check sequence against a disposable QA
   repository.

Passing is evidence for the configured fixtures and endpoints at that time. It
does not replace service authorization unit tests, a penetration test, or
continuous production monitoring.

## One-time controls

### Protect the GitHub environment

Create a GitHub Actions environment named exactly `qa-e2e` and configure:

- required reviewers who own the QA deployment target;
- prevention of self-review, when the repository plan supports it;
- deployment branches restricted to `main`;
- access to the secrets listed below only through this environment.

The workflow is manual-only, has one non-cancelling concurrency group, and times
out after 90 minutes. A run starts only when the operator selects the
full-deploy checkbox and types `DEPLOY QA E2E` exactly. The first step
also rejects any ref other than `main` and rejects production-like or unknown
deployment environment names.

### Use a dedicated keyless approver identity

Do not reuse the broad deployment service account and do not create a JSON
service-account key. Create a dedicated service account, for example:

```bash
PROJECT_ID="your-gcp-project"
E2E_APPROVER_SERVICE_ACCOUNT="ai-fleet-e2e-approver@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create ai-fleet-e2e-approver \
  --project "$PROJECT_ID" \
  --display-name "AI Fleet protected QA E2E approver"
```

The existing GitHub OIDC provider must map
`google.subject=assertion.sub`. Grant impersonation only to the subject GitHub
issues for this repository's protected environment, not to every workflow in
the repository:

```bash
PROJECT_ID="your-gcp-project"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
POOL_ID="github"
GITHUB_REPOSITORY="OWNER/REPOSITORY"
E2E_APPROVER_SERVICE_ACCOUNT="ai-fleet-e2e-approver@${PROJECT_ID}.iam.gserviceaccount.com"
GITHUB_ENVIRONMENT_SUBJECT="repo:${GITHUB_REPOSITORY}:environment:qa-e2e"

gcloud iam service-accounts add-iam-policy-binding \
  "$E2E_APPROVER_SERVICE_ACCOUNT" \
  --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/subject/${GITHUB_ENVIRONMENT_SUBJECT}"
```

This binding is required in addition to the Cloud Run invoker grant below. The
first lets the exact GitHub environment subject impersonate the service
account; the second lets that service account reach the IAM-gated settings
service. Keep the provider's repository attribute condition as a second
boundary. See `docs/GCP_CICD.md` for the provider creation and resource-name
format. The workflow converts the action's external-account credential into a
temporary impersonated ADC wrapper so the CLI can mint a fresh Cloud Run ID
token after the long pipeline run. That wrapper is mode `0600`, is never
uploaded, and is removed with the browser states.

### Grant only settings invocation

The E2E identity needs `roles/run.invoker` on the settings service so the CLI can
record the deployment approval. It does not need project-wide Cloud Run, Secret
Manager, Firestore, or deployment-administrator roles.

Supply the bare service-account email to Terraform:

```bash
export TF_VAR_e2e_approver_service_account="$E2E_APPROVER_SERVICE_ACCOUNT"
terraform -chdir=deploy/gcp/terraform plan
terraform -chdir=deploy/gcp/terraform apply
```

For other direct operator principals, use a JSON Terraform set:

```bash
export TF_VAR_settings_operator_invokers='["group:platform@example.com","serviceAccount:another-operator@your-gcp-project.iam.gserviceaccount.com"]'
```

`settings_operator_invokers` and `e2e_approver_service_account` are additive to
the backward-compatible `settings_operator_invoker` input. Duplicate members
are removed, and the original Terraform resource address remains unchanged.
Any non-empty direct-invoker input requires
`settings_ingress=INGRESS_TRAFFIC_ALL`; Cloud Run IAM remains the authorization
boundary and no `allUsers` binding is created.

These inputs default to empty. Supply the same `TF_VAR_*` values to every
Terraform executor that manages this state; a one-time local apply followed by
an automated apply without them will reconcile the optional grants away. The
existing deployment workflow is intentionally not changed by this feature. If
only one direct identity is required, its existing
`SETTINGS_OPERATOR_INVOKER=serviceAccount:...` repository variable remains the
backward-compatible persisted path.

## Protected environment configuration

Configure these non-secret variables on the `qa-e2e` environment:

| Name | Value |
| --- | --- |
| `E2E_QA_BASE_URL` | HTTPS origin of the QA web application, with no path fragment. |
| `E2E_QA_SETTINGS_URL` | Terraform's `settings_operator_url` output. |
| `E2E_QA_REPOSITORY` | One allow-listed disposable repository in `OWNER/REPO` form. |
| `E2E_QA_DEPLOY_ENV` | A lowercase approved non-production name, normally `qa`. |
| `E2E_QA_DEPLOY_HEALTH_URL` | A dedicated post-deploy HTTPS health endpoint. |

Configure these protected environment secrets:

| Name | Value |
| --- | --- |
| `GCP_WIF_PROVIDER` | Full resource name of the GitHub OIDC workload identity provider. |
| `GCP_E2E_OPERATOR_SA` | Bare email of the dedicated approver service account. |
| `E2E_QA_TENANT_A_STATE_GZIP_B64` | Gzip-compressed, base64-encoded Playwright storage state for Tenant A. |
| `E2E_QA_TENANT_B_STATE_GZIP_B64` | Gzip-compressed, base64-encoded Playwright storage state for Tenant B. |
| `E2E_QA_FIXTURES_JSON` | The synthetic, disjoint tenant fixture described below. |
| `E2E_QA_REPO_READ_TOKEN` | Optional read-only token used by the preflight audit for a private QA repository. Omit for a public repository. |

Use synthetic test users with the minimum application roles needed by each
scenario. Do not use an owner, super-admin, employee, or customer session.
Playwright storage state contains live cookies and token material: treat the
base64 form as a credential, because base64 is encoding rather than encryption.
For a private repository, scope `E2E_QA_REPO_READ_TOKEN` to metadata/content read
on only the disposable repository. The audit must not print the token or persist
repository responses, and the workflow never includes them in uploaded evidence.

The fixture secret uses this shape (replace every placeholder):

```json
{
  "nonProduction": true,
  "disposable": true,
  "tenantA": {
    "organizationId": "11111111-1111-4111-8111-111111111111",
    "projectId": "22222222-2222-4222-8222-222222222222",
    "linearProjectId": "linear-project-a",
    "canary": "TENANT_A_ONLY_CANARY"
  },
  "tenantB": {
    "organizationId": "33333333-3333-4333-8333-333333333333",
    "projectId": "44444444-4444-4444-8444-444444444444",
    "canary": "TENANT_B_ONLY_CANARY",
    "conversationId": "known-tenant-b-conversation",
    "terminalRunId": "known-terminal-tenant-b-run"
  },
  "pipelineTask": {
    "title": "Update the QA deployment canary",
    "description": "Make one deterministic, reversible change to the disposable QA canary and its test.",
    "priority": 2
  }
}
```

Tenant A and Tenant B must belong to different organizations and must have no
shared project IDs. The Linear projects, repository, branch, deployment target,
provider credentials, and health endpoint must all be synthetic and disposable.
The task description must be precise enough that the agent changes only the QA
canary. Tenant B's known conversation and terminal pipeline run are required as
positive controls before their identifiers are replayed from Tenant A as
cross-tenant probes. `settingsProjectId` and Tenant A `conversationId` or
`terminalRunId` may be supplied when a fixture uses distinct settings IDs or
adds the reciprocal probes. Never place tokens or customer data in the fixture
JSON. Each `canary` is a unique sentinel that must be visible in its own
tenant's resource payload and absent from the other tenant's payload.

## Capture and rotate browser states

From a trusted workstation, install the locked dependencies and capture both
test-user sessions using the repository helper:

```bash
npm ci
npm run e2e:auth:capture
```

The interactive helper captures Tenant A and then Tenant B and writes
`.playwright-auth/tenant-a.json` and
`.playwright-auth/tenant-b.json`; the directory is gitignored. Inspect only the
non-secret account identity shown by the application and confirm the two users
select different organizations. Then write each encoded state directly to its
environment secret without printing it:

To capture just one tenant or to place the state on an encrypted volume, use
`npm run e2e:auth:capture -- --tenant a --output /secure/path/tenant-a.json`
(or `--tenant b`).

```bash
gh secret set E2E_QA_TENANT_A_STATE_GZIP_B64 --env qa-e2e \
  < <(gzip -c .playwright-auth/tenant-a.json | base64 | tr -d '\n')
gh secret set E2E_QA_TENANT_B_STATE_GZIP_B64 --env qa-e2e \
  < <(gzip -c .playwright-auth/tenant-b.json | base64 | tr -d '\n')
```

Delete local states when they are no longer needed. Recapture them after token
revocation, password/MFA changes, membership changes, or the identity provider's
session lifetime. If a state or artifact is exposed, revoke both user sessions
before rerunning.

## Pre-run checklist

Before approving the GitHub environment deployment, verify:

- the selected workflow ref is `main` and contains the expected E2E code;
- the base URL and settings URL resolve to the same QA stack;
- pipeline orchestration and deployment are enabled only for this stack;
- the deployment target and health endpoint cannot update or alias production;
- the repository and Linear project can be reset without preserving the run;
- both tenant sessions are current, have distinct memberships, and contain no
  customer information;
- no other live E2E run is active or awaiting deployment approval.

Run `Live QA E2E security journey` from the Actions tab, select the checkbox,
and enter the exact confirmation phrase. After the protected-environment reviewer
approves it, the job performs the read-only topology/fixture audit first. The
recorded suite cannot start if that audit fails.

## Evidence and cleanup

The browser is Chrome. Video is retained for all scenarios, including failures.
The workflow always stages and uploads three artifacts:

- curated JSON/screenshot evidence from `test-results/live-evidence`;
- the HTML report from `playwright-report/live-evidence`;
- recorded WebM/MP4 files found under `test-results/live-evidence`.

Artifacts are retained for 14 days. Before upload, the workflow excludes trace
archives, ZIP files, HAR/network captures, and duplicate videos from the report
and evidence trees. Playwright auth state is decoded with mode `0600` under
`RUNNER_TEMP`, is never uploaded, and is deleted after the artifact steps. No
workflow step prints the decoded state.

Videos can still show synthetic tenant names and generated source changes. Limit
artifact access to the QA reviewers, keep fixture names non-sensitive, and delete
an artifact early if unexpected data appears. Do not enable Playwright tracing
for this workflow.

After every run, successful or failed:

1. Inspect the evidence summary and the pipeline audit record.
2. Confirm no run remains queued, running, or `awaiting_approval`; cancel it from
   the application if necessary.
3. Reset the disposable repository/deployment and archive or delete the synthetic
   Linear issue according to the QA retention policy.
4. Revoke and recapture a browser state if authentication failed unexpectedly or
   the artifact review suggests credential exposure.

If the audit fails, correct the endpoint, fixture, IAM, or session configuration;
do not bypass it. If the full pipeline fails after creating the work item, use
its recorded run ID for cleanup and preserve only the sanitized artifacts needed
for diagnosis.
