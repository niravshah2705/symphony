#!/usr/bin/env bash
# T-08: diagnose a stuck NotReady Agent (golden build / actor crash).
# Usage: t08-agent-diagnose.sh <namespace> <agent-name>
set -uo pipefail
CTX=${KCTX:-kind-flexprice-local}
NS=${1:?usage: $0 <ns> <agent>}
AGENT=${2:?agent name required}
K="kubectl --context $CTX"

echo "== Agent conditions =="
$K -n "$NS" get agent "$AGENT" -o jsonpath='{range .status.conditions[*]}{.type}={.reason}: {.message}{"\n"}{end}' 2>&1

echo; echo "== Harness snapshot location + workerPool =="
HARNESS=$($K -n "$NS" get agent "$AGENT" -o jsonpath='{.spec.harnessRef.name}')
$K -n "$NS" get harness "$HARNESS" -o jsonpath='{.spec.substrate}{"\n"}' 2>&1

echo; echo "== WorkerPool pods =="
$K -n "$NS" get pods -l kagent.dev/worker-pool-namespace="$NS" -o wide 2>&1 | head -5

echo; echo "== atelet Run/Terminate errors for this atespace (last 30m) =="
$K -n ate-system logs ds/atelet --since=30m 2>&1 \
  | grep -E "\"atespace\":\"$NS\"" | grep -iE 'err|crash|refused|fail' | tail -5

echo; echo "== GoldenActor CRDs available? =="
$K api-resources --api-group=ate.dev 2>&1 | grep -iE 'actor|golden' || echo "(no actor CRDs — substrate tracks actors via API server, not CRDs)"

echo; echo "== Compare with a known-good agent in another ns =="
GOOD=$($K get agents.api.kagent.dev -A --field-selector=status.conditions.4.status=True -o jsonpath='{.items[0]}' 2>/dev/null | jq -r '"\(.metadata.namespace) \(.metadata.name)"' | head -1)
echo "good reference: ${GOOD:-none found}"
