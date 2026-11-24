#!/usr/bin/env bash
# Loopback-only port-forwards for the UNEXPOSED observability stack (no Ingress,
# no edge login). VPN access is deferred. Ctrl-C stops all three.
#   Langfuse   http://localhost:3000
#   Jaeger     http://localhost:16686
#   Prometheus http://localhost:9090
set -euo pipefail

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

kubectl -n langfuse port-forward --address 127.0.0.1 svc/langfuse-web 3000:3000 &
pids+=($!)
kubectl -n otel-system port-forward --address 127.0.0.1 svc/jaeger 16686:16686 &
pids+=($!)
kubectl -n otel-system port-forward --address 127.0.0.1 svc/prometheus 9090:9090 &
pids+=($!)

echo "Langfuse   -> http://localhost:3000"
echo "Jaeger     -> http://localhost:16686"
echo "Prometheus -> http://localhost:9090"
echo "Ctrl-C to stop all forwards."
wait