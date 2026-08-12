# Release promotion process

Production uses one exact, long-lived `release` branch. `main` remains the
integration/default branch:

`feature PR → main → automated main-to-release PR → release → production`

After a change merges to `main`, the **Prepare Release PR** workflow opens (or
reuses) one PR from `main` into `release`. New `main` commits automatically
update that open PR. The production workflows accept only a merged,
same-repository PR whose head is `main` and whose base is `release`.

| Event | Production effect |
|---|---|
| Feature PR opened or merged into `main` | Checks run; no deployment |
| Push to `main` | Opens or updates the release PR; no deployment |
| Release PR closed without merge | None |
| Direct push to `release` | None (also block this with branch rules) |
| `main` → `release` PR merged | Path-filtered GCP deploy; affected skills publish |
| Manual workflow run from `main` or another ref | Production jobs are skipped |
| Manual workflow run explicitly from `release` | Break-glass redeploy of already promoted code |

## One-time repository setup

Do this before merging the workflow change that enables release promotion.

1. Create `release` at the commit currently running in production. If production
   is current `main`, use that SHA; otherwise use the actual deployed SHA.

   ```bash
   git push origin <currently-deployed-commit-sha>:refs/heads/release
   ```

2. Add a branch ruleset for the exact `release` branch:

   - require a pull request and at least one approval;
   - require the four jobs from the **Checks** workflow;
   - dismiss stale approvals and require approval of the latest push;
   - require resolved conversations;
   - block direct pushes, force pushes, deletion, and bypasses (including admins).

3. Keep **merge commits** enabled and merge promotion PRs with **Create a merge
   commit**; do not enable a linear-history rule on `release`. Do not squash or
   rebase a `main` → `release` PR: `main` must become an ancestor of `release` so
   the next promotion contains only new commits.

4. In Settings → Actions → General → Workflow permissions, enable **Allow
   GitHub Actions to create and approve pull requests**. The workflow only uses
   this setting to create the PR; it never approves or merges it.

5. Create a protected GitHub Environment named `production`, restrict its
   deployment branch to `release`, and add required reviewers if a second
   approval at deployment time is desired. Image publishing, SPA publishing,
   Terraform, and skills publishing all reference this environment.

6. Restrict the GCP Workload Identity provider to the repository and
   `refs/heads/release`. The current bootstrap creates or updates that provider
   condition. If the provider predates this release process, rerun the bootstrap
   or apply the equivalent `update-oidc --attribute-condition` before treating
   the release gate as the production trust boundary.

   ```bash
   PROJECT_ID=my-gcp-project
   REPO=owner/repository
   gcloud iam workload-identity-pools providers update-oidc github-oidc \
     --project "$PROJECT_ID" \
     --location global \
     --workload-identity-pool github \
     --attribute-condition "assertion.repository=='${REPO}' && assertion.ref=='refs/heads/release'"
   ```

7. GitHub Actions and `cloudbuild.yaml` are alternative deployment entry
   points. Disable any automatic Cloud Build trigger when GitHub Actions is the
   production pipeline. If Cloud Build is retained instead, its external branch
   trigger must match only `^release$`. Operator `deploy.sh`, direct Terraform,
   and manual Cloud Build submissions are break-glass paths and need equivalent
   IAM/process restrictions.

GitHub currently places PR workflow runs created or updated by `GITHUB_TOKEN`
into an approval-required state. Approve the Checks run after the release PR is
opened or synchronized. Later pushes to `main` update the same PR. If unattended
PR checks are required, replace `GITHUB_TOKEN` with a narrowly scoped GitHub App
token; do not use a broad personal token.

## Normal release

1. Merge reviewed feature/fix PRs into `main`.
2. Open the automatically created `main` → `release` PR and review the aggregate
   production diff.
3. Wait for required Checks and approvals. If `main` changes, stale approvals
   must be dismissed by the branch rule.
4. Merge with **Create a merge commit**.
5. The GCP deploy and, when its paths changed, skills publication start from the
   merged `release` commit. They remain path-filtered; “full flow” means the
   production pipeline is gated as a whole, not that every unchanged image is
   rebuilt.

## Retry and break-glass operations

If a release PR was closed, either merge another change to `main` or manually
run **Prepare Release PR** to create a fresh one.

To rebuild and reconcile every deployable component from the already promoted
`release` commit:

```bash
gh workflow run deploy.yml --ref release -f deploy_all=true
```

To republish a skills version from the already promoted release tree:

```bash
gh workflow run publish-skills.yml --ref release -f version=v1
```

Both production workflows guard their jobs with `refs/heads/release`, so
selecting another ref in the Actions UI produces skipped production jobs.
