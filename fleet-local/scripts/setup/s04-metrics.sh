#!/usr/bin/env bash
# Setup step 4 — metrics-server (helm). kind's kubelet serves a self-signed
# cert and the node's name is not resolvable in-cluster, so the chart's defaults
# never produce metrics; deploy/setup/metrics-server-values.yaml carries the two
# load-bearing args (--kubelet-insecure-tls, InternalIP preference). BFF capacity
# checks and kubectl top depend on this.
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../.."
source "$SD/_common.sh"
ensure_helm_repos

helm upgrade --install metrics-server metrics-server/metrics-server \
  --version 3.14.0 --namespace kube-system \
  -f deploy/setup/metrics-server-values.yaml --timeout 5m --wait

kc -n kube-system rollout status deploy/metrics-server --timeout=120s
kc top nodes >/dev/null && say "STEP4 OK — kubectl top nodes works" \
  || warn "metrics API not answering yet (first scrape takes ~60s)"
