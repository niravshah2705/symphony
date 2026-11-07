# Apply runbook (APPLY.md)

This root is **greenfield**: the cluster it was originally transcribed from was
destroyed before this config was re-pointed at it, so an apply creates resources
instead of adopting them. There is no import pass, no `terraform state rm`, and
no `gke_allow_destroy` gate — if you find yourself looking for one of those, stop
and check which state prefix you are pointed at.

## 1. Init with the remote bucket

```bash
cd deploy/gcp/terraform-substrate-gke
cp terraform.tfvars.example terraform.tfvars   # set project_id + cert_email
terraform init \
  -backend-config="bucket=<YOUR_TF_STATE_BUCKET>" \
  -backend-config="prefix=substrate/gke"
```

Never local state — the CI deploy job and the cluster power workflow both read
the same GCS object, and two writers of one stack is how drift becomes a fight.

## 2. Rehearse in a throwaway project first

Apply here once costs a real cluster in a real project, so prove the plan in a
scratch project before pointing CI at the production one:

```bash
terraform plan -var="project_id=<scratch-project>" -var="cluster_name=substrate-rehearsal" \
  -out=rehearsal.tfplan
terraform apply rehearsal.tfplan
```

Then run `.github/workflows/substrate-control-plane.yml` in `preflight` mode,
then `install`, against the rehearsal cluster. `preflight` reports instead of
dying, which is the point: it is the only thing that tells you whether the
installer can reach the cluster before anything depends on it having done so.

## 3. Converge and verify

```bash
terraform plan   # second run must be EMPTY — any diff is real drift
terraform apply
```

A non-empty second plan on this root is almost always one of three things:

- a field GKE rewrites on its own (a version string, an auto-enabled component),
  which belongs in a `lifecycle { ignore_changes = [...] }` rather than in a
  permanent diff — see the cluster's own block for the precedent;
- `kubectl_manifest` objects whose spec derives from a `latest` URL fetched at
  plan time; pin the version in the variable instead of tolerating the diff;
- something the substrate installer created that this root also claims. The
  installer owns `ate-system`'s contents; this root only claims the *namespace*
  (see `kubernetes_namespace_v1.substrate_system`) so an apply that runs before
  the installer does not die on `namespaces "ate-system" not found`. Do not add
  more installer-owned objects here.

## 4. Spot checks after apply

```bash
gcloud container node-pools list --cluster substrate-multitenant --location asia-south1-a
helm list -A                            # eg, cert-manager (+ agentgateway after H3)
kubectl get gateway,httproute -A
kubectl get certificate -n ate-system   # Ready only after DNS points at substrate_ingress_ip
terraform output substrate_ingress_dns  # the A record to create
```

TLS will not issue until the hostname's A record resolves to
`substrate_ingress_ip` — the front serves HTTP-01 on port 80 precisely so that
creating the record is the only remaining step, and the certificate joins the
Service once it exists.
