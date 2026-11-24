#!/usr/bin/env bash
# fleet-local — one-shot environment setup orchestrator.
#
# Brings the whole self-contained stack up on a FRESH machine (or reconciles a
# partial one — every step is idempotent): kind cluster -> Flexprice -> LiteLLM
# -> metrics-server -> observability (+Langfuse) -> Substrate -> kagent ->
# certificates -> fleet services -> (docs) -> e2e gate.
#
# Helm-first: every component that has a chart installs via helm upgrade
# --install with a committed values file; the exceptions are deliberate and
# documented in the step script (kind itself, substrate's ate-setup bootstrap
# which creates the signers the chart's workloads depend on, flexprice which
# uses the repo-root billing:flexprice:helm entry point).
#
# Secrets rule: nothing plaintext is ever written to a repo file or printed.
# Values are fetched inline from in-cluster Secrets / deploy/flexprice/.env;
# user-supplied credentials arrive via exported env vars (see each step header).
#
# Usage:
#   scripts/setup-env.sh                 # run all steps 1..11 (10 is docs, skipped)
#   scripts/setup-env.sh --from 6        # resume at step 6 (substrate)
#   scripts/setup-env.sh --step 3        # only step 3 (litellm)
#   scripts/setup-env.sh --list
#   DRY_RUN=1 scripts/setup-env.sh       # print the plan, run nothing
#
# Environment expected before starting:
#   docker + kind + kubectl + helm + node  |  OPENROUTER_API_KEY (step 3, optional)
#   deploy/flexprice/.env                  (step 2: npm run billing:flexprice:bootstrap)
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (step 8)  |  mkcert installed (step 8)
#   go >= 1.24 + ~/git/ate/substrate       (step 6)
set -euo pipefail
cd "$(dirname "$0")/.."

STEPS=(
  "1:setup/s01-kind.sh:kind cluster + ingress-nginx (helm)"
  "2:setup/s02-flexprice.sh:Flexprice on kind (repo-root helm entry point) + provision"
  "3:setup/s03-litellm.sh:LiteLLM (helm) + secrets + llm-mock + callback ConfigMap"
  "4:setup/s04-metrics.sh:metrics-server (helm, kind kubelet args)"
  "5:setup/s05-observability.sh:otel collector + Jaeger + Prometheus (+ Langfuse & litellm bridge once substrate is up)"
  "6:setup/s06-substrate.sh:Substrate control plane (crds + ate-setup bootstrap + chart + fleet overlay)"
  "7:setup/s07-kagent.sh:kagent (helm, trusted-proxy) + load-bearing :8083 NetworkPolicy"
  "8:setup/s08-certificates.sh:mkcert TLS + Google OAuth secret + dbs/bucket (00-prereqs.sh)"
  "9:setup/s09-services.sh:oauth2-proxy + Ingresses + BFF/SPA + Flexprice seed (existing scripts)"
  "10::auth configuration is DOCUMENTATION: see docs/AUTH-CONFIGURATION.md"
  "11:setup/s11-verify.sh:e2e gate (verify-e2e.sh 12 points + headless wake recipe)"
)

FROM=1; ONLY=""
case "${DRY_RUN:-0}" in 1|true|yes) DRY=1 ;; *) DRY=0 ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --step) ONLY="$2"; shift 2 ;;
    --list) for s in "${STEPS[@]}"; do IFS=: read -r n f d <<<"$s"; printf '%3s  %-42s %s\n' "$n" "${f:-docs}" "$d"; done; exit 0 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown flag: $1 (try --list / --from N / --step N / --dry-run)" >&2; exit 2 ;;
  esac
done

run_step() {
  local n="$1" script="$2" desc="$3"
  if [ -z "$script" ]; then
    echo "[step $n] $desc"; return 0
  fi
  if [ "$DRY" = "1" ]; then echo "[step $n] DRY-RUN bash scripts/$script  # $desc"; return 0; fi
  echo; echo "════ step $n — $desc ════"
  bash "scripts/$script"
}

for s in "${STEPS[@]}"; do
  IFS=: read -r n script desc <<<"$s"
  [ -n "$ONLY" ] && { [ "$n" = "$ONLY" ] && run_step "$n" "$script" "$desc"; continue; }
  [ "$n" -ge "$FROM" ] && run_step "$n" "$script" "$desc"
  # 5b: on a fresh cluster step 5 skips Langfuse — its stores need substrate's
  # RustFS (step 6) AND the langfuse DB/bucket that step 8 (00-prereqs)
  # creates, so the re-run rides after step 8. Cheap where it already ran;
  # completes the litellm langfuse half.
  if [ "$n" = "8" ] && [ "$FROM" -le 5 ]; then
    run_step "5b" "setup/s05-observability.sh" "Langfuse + LiteLLM langfuse bridge (RustFS + langfuse stores now exist)"
  fi
done
[ "$DRY" = "1" ] || echo; echo "setup-env: requested steps finished (--list shows the map; docs/SETUP-ENVIRONMENT.md explains ordering, incl. why the Langfuse part of step 5 is deferred to 5b after step 8 on a fresh cluster)"
