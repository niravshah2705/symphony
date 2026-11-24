#!/usr/bin/env bash
# Install the Substrate (ATE) control plane on a local kind cluster.
#
# Why not just the two helm commands: the substrate chart deploys workloads
# whose volumes are PodCertificateRequests for the custom signers
# podidentity/servicedns/postgres.podcert.ate.dev. Kubernetes core only signs
# kubernetes.io/*, so the signer controller, its CA pools, the actor-id pools
# and the postgres connection secrets are the installer's job, not the
# chart's. kubectl-ate v1.0.1 would do this, but it hard-requires
# certificates.k8s.io/v1beta1, which kind nodes on k8s 1.37 no longer serve
# (it works on the v1 API; only the installer's check is stale).
#
# Prereqs: running docker, the kind cluster, kubectl on that context, go 1.24+.
# Usage: CONTEXT=kind-flexprice-local [SUBSTRATE_SRC=~/substrate] ./install-substrate-local.sh
set -euo pipefail

CONTEXT="${CONTEXT:-kind-flexprice-local}"
NS="ate-system"
VERSION="${VERSION:-v1.0.1}"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/kagent-dev/substrate}"
CHART_REPO="oci://ghcr.io/kagent-dev/substrate/helm"
SUBSTRATE_SRC="${SUBSTRATE_SRC:-$HOME/git/ate/substrate}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

# 1. Source checkout at the version matching the images.
if ! git -C "$SUBSTRATE_SRC" rev-parse "v$VERSION" >/dev/null 2>&1; then
  git -C "$SUBSTRATE_SRC" fetch https://github.com/kagent-dev/substrate.git "refs/tags/v$VERSION:refs/tags/v$VERSION"
fi
WORKTREE="$(dirname "$SUBSTRATE_SRC")/substrate-v$VERSION"
git -C "$SUBSTRATE_SRC" worktree add "$WORKTREE" "v$VERSION" 2>/dev/null || true

# 2. CRDs before anything that validates against them.
helm upgrade --install substrate-crds "$CHART_REPO/substrate-crds" \
  --namespace "$NS" --create-namespace --wait

# 3. Bootstrap: signer CA pools + podcertificate-controller, actor-id pools,
# api authn config, bundled postgres, egress mitm pool. Idempotent; existing
# CA pools are kept (rotating them invalidates every issued identity).
cd "$WORKTREE"
go build -o /tmp/ate-setup ./cmd/ate-setup
/tmp/ate-setup deploy ate-system --kind --context "$CONTEXT" \
  --image-repo "$IMAGE_REPO" --image-tag "$VERSION" \
  --atenet-dataplane agentgateway \
  --credential-provider='{"name":"k8s.io"}' \
  --sandbox-classes=gvisor

# 4. Database roles/schema + the connection secrets the chart reads.
# Names and DSN format are the substrate chart's defaults; the DSNs point at
# pod certificates, so step 5 mounts them.
kubectl exec -n "$NS" postgres-0 -c postgres -- \
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --single-transaction \
  --username=postgres --dbname=atepg \
  --set=substrate_schema=substrate --set=substrate_owner_role=substrate_owner \
  --set=substrate_owner_user=substrate_owner_user --set=substrate_owner_password= \
  --set=substrate_readwrite_role=substrate_readwrite \
  --set=substrate_readwrite_user=substrate_readwrite_user --set=substrate_readwrite_password= \
  < pkg/postgressetup/setup.sql
for user_role in "substrate_readwrite_user:substrate-postgres-readwrite:readWriteConnectionString" \
                 "substrate_owner_user:substrate-postgres-owner:ownerConnectionString"; do
  user="${user_role%%:*}"; rest="${user_role#*:}"
  secret="${rest%%:*}"; key="${rest#*:}"
  dsn="postgresql://$user@postgres.$NS.svc:5432/atepg?sslmode=verify-full&sslrootcert=/run/servicedns.podcert.ate.dev/trust-bundle.pem&sslcert=/run/postgres.podcert.ate.dev/$user.pem&sslkey=/run/postgres.podcert.ate.dev/$user.pem"
  kubectl create secret generic "$secret" -n "$NS" \
    --from-literal="$key=$dsn" --dry-run=client -o yaml | kubectl apply -f -
done

# 5. Hand workloads over to the chart (single source of truth for upgrades).
# --force-conflicts: step 3 applied the same fields under a different manager.
helm upgrade --install substrate "$CHART_REPO/substrate" \
  --namespace "$NS" --wait --timeout 10m --force-conflicts \
  --set postgres.clientCertificates.enabled=true

# 6. Smoke test: signers running, trust bundles published, everything ready.
kubectl -n "$NS" wait --for=condition=Ready pod -l app=postgres --timeout=5m >/dev/null
kubectl get clustertrustbundles | grep podcert.ate.dev
kubectl rollout status deploy/ate-api-server -n "$NS" --timeout=5m
echo "substrate installed; verify with: kubectl get pods -n $NS"
