#!/usr/bin/env bash
# P1 edge: keep ingress-nginx, add oauth2-proxy (upstream mode) + TLS Ingresses for
# app.fleet.dev and kagent.fleet.dev. The header-sanitize configuration-snippet on those
# Ingresses requires allow-snippet-annotations=true on the controller (kind ships
# it false). We enable it and restart the controller — local cluster, reversible.
# The three flexprice Ingresses (HTTP) are left untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

# --- permit configuration-snippet annotations (load-bearing for header strip) -
cur=$(kubectl -n ingress-nginx get cm ingress-nginx-controller -o jsonpath='{.data.allow-snippet-annotations}' 2>/dev/null || true)
if [ "$cur" != "true" ]; then
  kubectl -n ingress-nginx patch cm ingress-nginx-controller --type merge \
    -p '{"data":{"allow-snippet-annotations":"true"}}'
  kubectl -n ingress-nginx rollout restart deploy/ingress-nginx-controller
  kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=180s
  echo "enabled allow-snippet-annotations + restarted controller"
else
  echo "allow-snippet-annotations already true"
fi

# --- oauth2-proxy deployments (need Secret/google-oauth from 00-prereqs) ------
kubectl -n fleet-system get secret google-oauth >/dev/null 2>&1 \
  || { echo "run scripts/00-prereqs.sh first (Secret/google-oauth missing)" >&2; exit 1; }
kubectl apply -f deploy/oauth2-proxy/fleet.yaml
kubectl apply -f deploy/oauth2-proxy/kagent.yaml
kubectl -n fleet-system rollout status deploy/fleet-oauth2-proxy --timeout=180s
kubectl -n fleet-system rollout status deploy/kagent-oauth2-proxy --timeout=180s

# --- TLS Ingresses (need Secret/fleet-local-tls from 00-prereqs) --------------
kubectl -n fleet-system get secret fleet-local-tls >/dev/null 2>&1 \
  || { echo "run scripts/00-prereqs.sh first (Secret/fleet-local-tls missing)" >&2; exit 1; }
kubectl apply -f deploy/ingress/app.yaml
kubectl apply -f deploy/ingress/kagent.yaml

echo "=== ingresses (fleet-system) ==="
kubectl -n fleet-system get ingress
echo "INGRESS+OAUTH OK — flexprice Ingresses unchanged; nginx still the only controller"