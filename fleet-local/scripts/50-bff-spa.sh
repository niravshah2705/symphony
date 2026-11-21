#!/usr/bin/env bash
# Build + load the BFF image, assemble Secret/fleet-bff-env inline from existing
# in-cluster secrets (never printed, never committed), and deploy the control plane.
#   docker build -f deploy/bff/Dockerfile -t fleet-bff:local .   (context = workspace root)
#   kind load docker-image fleet-bff:local --name flexprice-local
set -euo pipefail
cd "$(dirname "$0")/.."
NS=fleet-system
KIND_CLUSTER=${KIND_CLUSTER:-flexprice-local}

command -v docker >/dev/null 2>&1 || { echo "docker required to build the BFF image" >&2; exit 1; }

# --- build + load the arm64 image --------------------------------------------
docker build -f deploy/bff/Dockerfile -t fleet-bff:local .
kind load docker-image fleet-bff:local --name "$KIND_CLUSTER"

# --- assemble fleet-bff-env (keep existing on re-run so sessions survive) -----
if kubectl -n "$NS" get secret fleet-bff-env >/dev/null 2>&1; then
  # Self-heal the T-15.20 shape: a secret assembled while the fetch pointed at
  # the litellm Deployment carries an EMPTY FLEXPRICE_API_KEY (the BFF then
  # crash-loops on "missing required env"). Refill from the source of truth.
  if [ -z "$(kubectl -n "$NS" get secret fleet-bff-env -o jsonpath='{.data.FLEXPRICE_API_KEY}' | base64 -d)" ]; then
    kubectl -n "$NS" patch secret fleet-bff-env --type merge -p "{\"data\":{\"FLEXPRICE_API_KEY\":\"$(kubectl -n litellm get secret litellm-fleet-secrets -o jsonpath='{.data.FLEXPRICE_API_KEY}')\"}}" >/dev/null
    echo "secret fleet-bff-env: empty FLEXPRICE_API_KEY refilled from litellm-fleet-secrets"
  else
    echo "secret fleet-bff-env exists — keeping existing values"
  fi
else
  PGPW=$(kubectl -n flexprice get secret flexprice-postgresql -o jsonpath='{.data.password}' | base64 -d)
  LLKEY=$(kubectl -n litellm get secret litellm-masterkey -o jsonpath='{.data.masterkey}' | base64 -d)
  # Source = the Secret: the litellm chart injects environmentSecrets refs, it
  # does NOT put FLEXPRICE_API_KEY into the Deployment's env (reading it there
  # silently produced an empty value on a fresh cluster).
  FPKEY=$(kubectl -n litellm get secret litellm-fleet-secrets -o jsonpath='{.data.FLEXPRICE_API_KEY}' | base64 -d)
  [ -n "$FPKEY" ] || { echo "litellm-fleet-secrets/FLEXPRICE_API_KEY missing or empty — run setup steps 3+8 first" >&2; exit 1; }
  LFSK=$(kubectl -n langfuse get secret langfuse-stores -o jsonpath='{.data.langfuse-secret-key}' | base64 -d)
  SESS=$(openssl rand -hex 32)
  kubectl -n "$NS" create secret generic fleet-bff-env \
    --from-literal=FLEET_DATABASE_URL="postgres://flexprice:${PGPW}@flexprice-postgresql.flexprice.svc.cluster.local:5432/fleet_control" \
    --from-literal=FLEET_SESSION_SECRET="$SESS" \
    --from-literal=LITELLM_MASTER_KEY="$LLKEY" \
    --from-literal=FLEXPRICE_API_KEY="$FPKEY" \
    --from-literal=LANGFUSE_SECRET_KEY="$LFSK" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "created secret fleet-bff-env"
fi

# --- config + rbac + deployment ----------------------------------------------
kubectl apply -f deploy/bff/configmap.yaml
kubectl apply -f deploy/bff/rbac.yaml
kubectl apply -f deploy/bff/deployment.yaml
# imagePullPolicy + a mutable fleet-bff:local tag: with an unchanged manifest
# `apply` rolls nothing, and a rebuilt image (e.g. new chart templates under
# deploy/charts) would keep running from the OLD pod. Restart so the new image
# is actually the one serving.
kubectl -n "$NS" rollout restart deploy/fleet-bff
kubectl -n "$NS" rollout status deploy/fleet-bff --timeout=240s

echo "=== helm status unaffected; BFF pods ==="
kubectl -n "$NS" get pods -l app=fleet-bff -o wide
echo "BFF+SPA OK — image fleet-bff:local loaded; SPA served at SPA_ROOT"