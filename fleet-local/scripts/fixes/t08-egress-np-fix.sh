#!/usr/bin/env bash
# T-08 fix: kagent-controller :8083 NetworkPolicy must admit the atenet-egress
# gateway pods (ns ate-system, app=atenet-egress). Actor bootstrap calls
# (GetBootstrapConfig) are proxied by agentgateway in the atenet-egress pod;
# without this allow-entry the SYN is dropped, the gateway's ~3s connect
# deadline expires on every attempt, and the golden actor crashes before it
# binds :8081 (wakeup probe never answers) -> GoldenActorCrashed.
#
# Idempotent: checks for the existing entry before patching.
set -euo pipefail
CTX="${CTX:-kind-flexprice-local}"

has_entry() {
  kubectl --context "$CTX" -n kagent get networkpolicy kagent-controller-ingress \
    -o json | python3 -c '
import json,sys
np=json.load(sys.stdin)
for ing in np["spec"].get("ingress",[]):
    for f in ing.get("from",[]):
        ns=f.get("namespaceSelector",{}).get("matchLabels",{}).get("kubernetes.io/metadata.name")
        pod=f.get("podSelector",{}).get("matchLabels",{})
        if ns=="ate-system" and pod.get("app")=="atenet-egress":
            sys.exit(0)
sys.exit(1)'
}

if has_entry; then
  echo "kagent-controller-ingress already admits ate-system/app=atenet-egress on :8083"
else
  kubectl --context "$CTX" -n kagent patch networkpolicy kagent-controller-ingress \
    --type=json -p '[{"op":"add","path":"/spec/ingress/0/from/-","value":{
      "namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"ate-system"}},
      "podSelector":{"matchLabels":{"app":"atenet-egress"}}}}]'
  echo "patched kagent-controller-ingress"
fi

# Verification: after this, a golden build must complete; bootstrap duration
# should be <1000ms (was 2600-3200ms pre-fix).
echo "verify with:"
echo "  kubectl -n org-demo delete agent demo-agent-worker --wait=false && kubectl apply -f /tmp/demo-agent.yaml"
echo "  kubectl -n ate-system logs deploy/atenet-egress --since=2m | grep GetBootstrapConfig"
echo "  kubectl get agent -A"
