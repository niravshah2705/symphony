#!/usr/bin/env bash
# T-04/T-06: rebuild the BFF image with current sources, load into kind, restart.
set -euo pipefail
cd "$(dirname "$0")/../.."   # fleet-local root
CTX=${KCTX:-kind-flexprice-local}
docker build -f deploy/bff/Dockerfile -t fleet-bff:local .
kind load docker-image fleet-bff:local --name "${CTX#kind-}"
kubectl --context "$CTX" -n fleet-system rollout restart deploy/fleet-bff
kubectl --context "$CTX" -n fleet-system rollout status deploy/fleet-bff --timeout=180s
