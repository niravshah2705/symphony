#!/usr/bin/env bash
# Setup step 1 — kind cluster + ingress-nginx edge.
#   - kind cluster "flexprice-local": single control-plane, kindest/node v1.37.0,
#     host 0.0.0.0:80/443 -> node (deploy/setup/kind-config.yaml — same shape as
#     the running cluster; substrate needs 1.37 for certificates.k8s.io/v1).
#   - ingress-nginx via HELM chart 4.10.1 (controller v1.10.x) with hostPort
#     80/443 data path, snippet annotations allowed (identity-header stripping
#     in deploy/ingress/*.yaml depends on it) and watch-ingress-without-class
#     (the flexprice Ingresses carry no ingressClassName).
# Idempotent; safe to re-run.
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../.."
source "$SD/_common.sh"

CLUSTER=flexprice-local
ensure_helm_repos

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  say "creating kind cluster $CLUSTER (this pulls the v1.37.0 node image once)"
  kind create cluster --config deploy/setup/kind-config.yaml
else
  say "kind cluster $CLUSTER already exists — keeping it"
fi
kubectl config use-context "kind-$CLUSTER"

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --version 4.10.1 --namespace ingress-nginx --create-namespace \
  -f deploy/setup/ingress-nginx-values.yaml --timeout 10m --wait

kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=180s
# kind's node port 80/443 must answer on the host or every *.fleet.dev /
# flexprice.local URL below dies later with a confusing auth error instead.
# Any HTTP answer counts — a bare 404 from nginx with no Ingress is healthy.
code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1/ || true)
[ "$code" != "000" ] && say "edge :80 answering (http $code)" \
  || warn "nothing on host :80 — check 'docker port ${CLUSTER}-control-plane 80' and the ingress-nginx Pod"
say "STEP1 OK — node $(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}'), ingress-nginx deployed"
