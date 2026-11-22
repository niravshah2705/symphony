#!/usr/bin/env bash
# T-02: oauth2-proxy cookie-secret must be exactly 16/24/32 raw bytes.
# Regenerate and patch Secret/google-oauth in fleet-system, then restart proxies.
set -euo pipefail
CTX=${KCTX:-kind-flexprice-local}
kubectl --context "$CTX" -n fleet-system get secret google-oauth >/dev/null || { echo "secret google-oauth missing; run scripts/00-prereqs.sh"; exit 1; }
COOKIE=$(openssl rand 32 | base64)
B64=$(printf '%s' "$COOKIE" | base64)
kubectl --context "$CTX" -n fleet-system patch secret google-oauth --type merge -p "{\"data\":{\"cookie-secret\":\"$B64\"}}"
kubectl --context "$CTX" -n fleet-system rollout restart deploy/fleet-oauth2-proxy deploy/kagent-oauth2-proxy
kubectl --context "$CTX" -n fleet-system rollout status deploy/fleet-oauth2-proxy --timeout=120s
echo "cookie-secret fixed (32 raw bytes)"
