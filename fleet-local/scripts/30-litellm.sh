#!/usr/bin/env bash
# Wire the fleet cost-header bridge into LiteLLM:
#   1. vendored flexprice_callback.py (bare UUID + baggage fallbacks) + fleet_metadata.py
#   2. langfuse callback keys from a Secret (no plaintext in helm values)
#   3. helm upgrade --reuse-values: callbacks chain + environmentSecrets
set -euo pipefail
cd "$(dirname "$0")/.."
NS=litellm

kubectl -n "$NS" create configmap litellm-callback \
  --from-file=flexprice_callback.py=deploy/litellm/flexprice_callback.py \
  --from-file=fleet_metadata.py=deploy/litellm/fleet_metadata.py \
  --from-file=fleet_identity.py=deploy/litellm/fleet_identity.py \
  --dry-run=client -o yaml | kubectl apply -f -

LFSK=$(kubectl -n langfuse get secret langfuse-stores -o jsonpath='{.data.langfuse-secret-key}' | base64 -d)
kubectl -n "$NS" create secret generic litellm-langfuse-keys \
  --from-literal=LANGFUSE_PUBLIC_KEY=pk-lf-fleet-local \
  --from-literal=LANGFUSE_SECRET_KEY="$LFSK" \
  --from-literal=LANGFUSE_HOST=http://langfuse-web.langfuse.svc.cluster.local:3000 \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade litellm oci://ghcr.io/berriai/litellm-helm --version 1.109.1 -n "$NS" \
  --reuse-values -f deploy/litellm/values-patch.yaml --timeout 5m --wait

echo "=== helm status (authoritative) ==="
helm status litellm -n "$NS" | sed -n '1,5p'
kubectl -n "$NS" rollout status deploy/litellm --timeout=180s
echo "=== langfuse env present on pod ==="
kubectl -n "$NS" get deploy litellm -o jsonpath='{range .spec.template.spec.containers[0].envFrom[*]}{.secretRef.name}{"\n"}{end}'