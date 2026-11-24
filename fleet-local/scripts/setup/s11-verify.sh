#!/usr/bin/env bash
# Setup step 11 — end-to-end gate.
#  a) cluster-side checks: scripts/verify-e2e.sh (12-point gate: edge auth,
#     baggage echo via llm-mock, Flexprice ai.usage + fleet.actor_compute
#     read-backs, Langfuse link, 429 budget, spoofed-header strip, helm status).
#  b) headless wake probe (optional, needs an onboarded agent): port-forward
#     kagent-controller :8083 -> MCP initialize/tools-list/invoke_agent with a
#     self-signed trusted-proxy JWT -> actor Restore from golden snapshot ->
#     mock-gpt completion -> Checkpoint. Reproduce with the flow documented in
#     docs/SETUP-ENVIRONMENT.md ("Headless wake") — same one that closed T-08.
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../.."
source "$SD/_common.sh"

rc=0
bash scripts/verify-e2e.sh || rc=$?
if [ "$rc" -ne 0 ]; then
  warn "verify-e2e.sh exited $rc — fix the failing points before calling the environment set up"
  exit "$rc"
fi
say "STEP11 OK — 12-point gate green. Manual tail: browser login at https://app.fleet.dev,"
say "wizard run for a tenant org, then one chat turn; check costs dashboard + Langfuse (scripts/port-forwards.sh)."
