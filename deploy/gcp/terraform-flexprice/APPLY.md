# APPLY — `terraform-flexprice`

The normal path is the `flexprice_reconcile` job in
`.github/workflows/deploy.yml`, not a workstation. This file exists for the two
cases where a human is in front of it: reviewing a plan CI produced, and
recovering from an apply that stopped converging.

Read `README.md` first. It explains the three-release shape, the patched chart
and the AGPL gate; this file is sequence and commands.

## 0. Prerequisites, in the order they can actually be satisfied

```bash
gcloud container clusters get-credentials substrate-multitenant \
  --region asia-south1-a --project adlc-9e72f
kubectl get nodepool -A >/dev/null 2>&1 || true   # sanity: the context is the right cluster
```

The state prefix is `substrate/flexprice`, in the same bucket the other roots
use:

```bash
terraform init -backend-config="prefix=substrate/flexprice"
```

**The chicken-and-egg in the supply chain.** The chart is installed *from*
Artifact Registry, and Artifact Registry is created *by* this root — so the first
run cannot install anything, because there is nothing to install from. Break it in
this order:

```bash
terraform apply -target=google_artifact_registry_repository.flexprice_app \
                -target=google_artifact_registry_repository.flexprice_chart \
                -target=google_project_service.flexprice_apis
```

Then build and push, then apply the rest. CI does exactly this: the job's
"ensure repos" step is a targeted apply ahead of the image and chart steps.

## 1. Chart and image, from the pinned commit

`deploy/flexprice/VERSION` names the commit everything is derived from. Both
artifacts are built, not pulled — `ghcr.io/flexprice/flexprice` is a private
package and the chart OCI repo answers 401 to an anonymous token request.

```bash
git clone https://github.com/flexprice/flexprice /tmp/flexprice && cd /tmp/flexprice
git checkout 2152453032098000f8b76b07bc869013313ff338

node scripts/flexprice-stage-chart.js \
  --source /tmp/flexprice/internal/ee/infrastructure/helm/flexprice \
  --out /tmp/staged/flexprice --version 1.10.0+fleet.1        # prints the sha256
helm lint /tmp/staged/flexprice                       # chart structure
helm package /tmp/staged/flexprice -d /tmp/pkg
helm push /tmp/pkg/flexprice-1.10.0+fleet.1.tgz \
  oci://asia-south1-docker.pkg.dev/adlc-9e72f/flexprice-chart

helm registry login oci://asia-south1-docker.pkg.dev \
  --username=_json_key --password="$(gcloud auth print-access-token)"   # before push, not after
```

The image is a plain Docker build of that checkout, tagged with something
**meaningful** rather than left to a digest alone:

```bash
docker build -t asia-south1-docker.pkg.dev/adlc-9e72f/flexprice-app/flexprice-app:v2.1.48-fleet1 .
docker push  ...same tag...
```

Record three values in `deploy/flexprice/VERSION`: the image digest, the chart
version, and the patched-chart sha256 the staging script printed. A Terraform
apply with `chart_version` pointing at a chart nobody recorded the sha for is a
deployment of templates whose patches were never re-derived from the pinned
commit.

**Set `image_tag`, not only `image_digest`.** The migration Job's name hashes
`env` plus `<repository>:<tag | .Chart.AppVersion>`, and this chart's `appVersion`
is the constant `"1.0.0"`. With an empty tag, an image-only bump keeps the same
Job name, the new image's versioned migrations never run, and nothing complains —
`/health` does not read the schema. This is the one silent failure in the design.

## 2. Secrets, before the first apply

The five Secret Manager containers exist in state with no versions. Seed each
one out-of-band, then let CI mirror the enabled versions into the Kubernetes
Secret `flexprice-secrets` that `secrets.existingSecret` points at:

```bash
for id in flexprice-postgres-password flexprice-clickhouse-password \
          flexprice-auth-secret flexprice-encryption-key flexprice-api-key-keys; do
  gcloud secrets describe "$id" --project adlc-9e72f     # must exist
done
```

`flexprice-api-key-keys` must pin tenant `00000000-0000-0000-0000-000000000000`,
the seeded tenant the migration creates; a key map with any other tenant id
authenticates nothing and every API call answers 401.

The plane keys are **not** in this list. They are minted after the stack is up by
`scripts/flexprice-provision.js`, because a key Terraform creates is a key whose
rotation is a plan.

Check the render before applying, with the values this root actually sends:

```bash
helm template flexprice-infra /tmp/staged/flexprice -n flexprice \
  --values values/base.yaml --values /tmp/review-infra-overlay.yaml \
  | grep -E 'storageClassName|nodeSelector|timeoutSeconds'
```

Expect: four `storageClassName: "<var.storage_class_name>"`, a nodeSelector +
toleration in all four StatefulSets, and no `timeoutSeconds: 5`/`3` left in the
infra probes.

## 3. Apply, and what the ordering buys

```bash
terraform plan      # expect creates only, 0 destroys
terraform apply
```

`depends_on` fixes the sequence: namespace → pool → infra release → db-init Job +
Temporal → migration release → app release → front. The two `kubectl_manifest`
Jobs between infra and migration are not decoration: the chart never creates the
`temporal` **database**, and the Temporal Deployment/Service are owned here
because the chart's own `templates/infra/temporal.yaml` does not produce the
Service name everything else is configured to reach.

`ingress_hostname` defaults to `""`, which keeps the whole front (address,
Issuer, Certificate, EnvoyProxy, Gateway, HTTPRoute, HTTP redirect) at count 0.
Deploy dark, prove the data plane, then set the hostname and create the one A
record:

```bash
terraform output flexprice_dns_hint
# A record: flexprice.archagentix.com -> 34.x.y.z (region asia-south1, TTL 300)
```

Until that record resolves, the Certificate sits `Pending` with no error message
that names DNS. Nothing in this repo writes Cloud DNS.

## 4. Reading a failed apply

`atomic` + `cleanup_on_fail` mean a release that cannot converge is rolled back
and deleted, so **the cluster shows nothing afterwards**. Look while it is still
failing — CI dumps all of this on a non-zero apply:

```bash
kubectl -n flexprice get pods -o wide
kubectl -n flexprice get events --sort-by=.lastTimestamp | tail -40
helm -n flexprice list
kubectl -n flexprice logs job/flexprice-migration-<hash> --all-containers
```

The four failure modes worth recognising by symptom:

| Symptom | Cause | Fix |
|---|---|---|
| Pod `Pending`, no event naming a failure | missing toleration — the pool is `NoSchedule` and a component template exposes no placement keys | the staged chart injects them; re-run the staging build |
| Postgres/ClickHouse pod restarts forever, `connection reset by peer` in the migration Job | probes not widened (an unpatched chart was pushed) | rebuild from the pinned commit, compare the sha256 |
| Worker crash-loops: `ensure temporal server schedules: describe temporal schedule "credit-grants-processing": Namespace default is not found.` | Temporal's `default` namespace was never registered | check the `flexprice-temporal-bootstrap` Job ran and that `temporalConfig.address` is `flexprice-temporal-frontend:7233` |
| `ErrImagePull` on a node | the node SA lacks `roles/artifactregistry.reader`, or the pull is anonymous Docker Hub | `iam.tf` binding; or set `image_registry_prefix` |

`pending-install`/`pending-upgrade` left in `helm list` means the process was
killed mid-apply rather than the release failing; the next `terraform apply`
resumes it. Do not run `helm rollback` to "clear" it — that desynchronises the
release from what Terraform's state believes.

## 5. What is not declarative, and must not be automated

* **Immutable StatefulSet fields.** Volume templates, `serviceName` and
  `selector` cannot be changed in place; Helm fails with
  `field spec...volumeMounts[0].name is immutable`. The sequence is: taint the
  pool and drain, `helm uninstall` the infra release (the `helm.sh/resource-policy:
  keep` annotation and `Reclaim=Retain` are what protect the data), fix the
  values, re-install, un-drain. A PVC itself is never deleted by any of this —
  deleting one is a greenfield reset, and there is no backup path in this module.
* **Changing `storage_class_name` or `static_ip_name` after the first apply.**
  Both are create-before-destroy in effect; renaming the class orphans the PVCs
  that reference the old name. Treat these as immutable.
* **A chart version bump.** Re-run the staging build, re-record the sha256, and
  then check the two things the chart may silently stop doing: rendering the
  namespace bootstrap Job (see the README) and exposing the placement keys the
  patch assumes.

## 6. Destroy

```bash
terraform destroy
```

The databases survive by intent: `Reclaim=Retain` on the StorageClass plus
`helm.sh/resource-policy: keep` on the PVCs and the class itself mean a destroy
removes workloads, not billing data, and leaves PVs claiming a class name that no
longer exists. That is recoverable (recreate the class with the same name) and it
is also the reason `destroy` here is not a cleanup command. Delete the disks
explicitly if the intent is really to erase the stack, and record that a greenfield
module has no migration *out* — there is no export path, because nothing has ever
been cut over to it.
