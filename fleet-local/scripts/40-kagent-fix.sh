#!/usr/bin/env bash
# Fix the kagent release and switch the controller to trusted-proxy auth.
#   - helm upgrade --reuse-values + deploy/kagent/values-patch.yaml
#     (auth.mode=trusted-proxy, userIdClaim=email, ui forwarded-header allowlist)
#   - remove a stale NotReady Agent in the kagent namespace (if any). The Ready
#     prototype agents in org-nirav are NOT touched — they are re-adopted in P5.
#   - apply the LOAD-BEARING :8083 NetworkPolicy (controller JWT is unverified).
set -euo pipefail
cd "$(dirname "$0")/.."
NS=kagent

helm upgrade kagent oci://ghcr.io/kagent-dev/kagent/helm/kagent --version 1.0.0 -n "$NS" \
  --reuse-values -f deploy/kagent/values-patch.yaml --timeout 15m --wait

kubectl -n "$NS" delete agent org-nirav-worker --ignore-not-found >/dev/null 2>&1 || true
kubectl apply -f deploy/networkpolicy/kagent-controller.yaml

echo "=== helm status (authoritative, not the exit code) ==="
helm status kagent -n "$NS" | sed -n '1,6p'
echo "=== controller auth mode ==="
kubectl -n "$NS" get cm kagent-controller -o yaml | grep -A2 'auth:' | sed -n '1,4p'
kubectl -n "$NS" rollout status deploy/kagent-controller --timeout=180s
kubectl -n "$NS" get pods -o wide
echo "KAGENT FIX OK"