#!/usr/bin/env bash
# Setup step 5 — observability stack: OTel collector + Jaeger + Prometheus, then
# Langfuse, then completion of the LiteLLM callback chain.
#
#  a) otel-system: the two ConfigMaps from ../../deploy/flexprice/kind (their
#     count-connector + scrape filters are the billing telemetry contract — see
#     that README; the guard script verifies them) + the three workloads from
#     deploy/observability/otel-system.json (digest-pinned). ClusterIP only:
#     NO Ingress by design — reach them with scripts/port-forwards.sh.
#  b) Langfuse v3 (chart 2.2.0, image pinned) on the shared flexprice stores —
#     via the existing scripts/20-langfuse.sh (unchanged). Needs substrate's
#     RustFS (step 6) and the langfuse database/bucket created by step 8
#     (00-prereqs); on a FRESH cluster setup-env.sh therefore re-runs this
#     step as 5b AFTER step 8.
#  c) scripts/30-litellm.sh (unchanged): mints litellm-langfuse-keys from the
#     langfuse-stores Secret and upgrades the release with values-patch.yaml so
#     the callback chain becomes flexprice + fleet_metadata + langfuse.
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../.."
source "$SD/_common.sh"
ROOT=..

kc create namespace otel-system --dry-run=client -o yaml | kc apply -f -
kc -n otel-system apply -f "$ROOT/deploy/flexprice/kind/prometheus-configmap.yaml" \
                        -f "$ROOT/deploy/flexprice/kind/otel-collector-configmap.yaml"
kc apply -f deploy/observability/otel-system.json
kc -n otel-system rollout status deploy/opentelemetry-collector --timeout=600s
kc -n otel-system rollout status deploy/jaeger                 --timeout=600s
kc -n otel-system rollout status deploy/prometheus             --timeout=600s

# verify the telemetry contract the fleet billing reads (fails if the cluster
# and the in-tree copies disagree; changes nothing)
( cd "$ROOT" && bash scripts/kind-metrics-install.sh ) \
  || warn "kind-metrics-install guard unhappy — read its output before trusting cost graphs"

# The fleet RustFS identity (Langfuse S3 backend + tenant snapshot jobs) was
# created ad-hoc on the original cluster; both scripts/20-langfuse.sh and
# scripts/00-prereqs.sh only READ it. Derive it from the substrate rustfs
# deployment's own credentials (fetched inline, never printed). Never
# overwrite — a rotated secret must survive re-runs.
if kc -n ate-system get deploy rustfs >/dev/null 2>&1 \
   && ! kc -n ate-system get secret kagent-rustfs-credentials >/dev/null 2>&1; then
  RAK=$(kc -n ate-system get deploy rustfs -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUSTFS_ACCESS_KEY")].value}')
  RSK=$(kc -n ate-system get deploy rustfs -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUSTFS_SECRET_KEY")].value}')
  kc -n ate-system create secret generic kagent-rustfs-credentials \
    --from-literal=AWS_ACCESS_KEY_ID="$RAK" --from-literal=AWS_SECRET_ACCESS_KEY="$RSK" \
    --dry-run=client -o yaml | kc apply -f -
  say "secret ate-system/kagent-rustfs-credentials derived from the substrate rustfs deployment"
fi

if kc -n ate-system get secret kagent-rustfs-credentials >/dev/null 2>&1; then
  bash scripts/20-langfuse.sh
  bash scripts/30-litellm.sh
else
  warn "substrate/RustFS + the langfuse stores (step 8's 00-prereqs) not in place yet — skipping Langfuse + the litellm langfuse half."
  warn "setup-env.sh re-runs this step as 5b after step 8; manually: bash fleet-local/scripts/setup/s05-observability.sh"
fi
say "STEP5 OK — collector/jaeger/prometheus up; langfuse + full litellm callback chain where substrate allowed it"
