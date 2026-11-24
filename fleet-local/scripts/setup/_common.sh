#!/usr/bin/env bash
# Small shared helpers for scripts/setup/*.sh — no secrets touched here.
say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

# kubectl context of the fleet cluster (never assume the "current" one).
CTX="${KUBE_CONTEXT:-kind-flexprice-local}"
kc() { kubectl --context "$CTX" "$@"; }

ensure_helm_repos() {
  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null
  helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ >/dev/null
  helm repo update >/dev/null
}

# secret_value <ns> <secret> <key> -> decoded value on stdout. Values are only
# ever piped straight into another --from-literal / env; never echo the result.
secret_value() { kc -n "$1" get secret "$2" -o jsonpath="{.data.$3}" | base64 -d; }

# env_file_value <KEY> <path> -> value from a KEY=VALUE .env file
env_file_value() { sed -n "s/^$1=//p" "${2:-deploy/flexprice/.env}" | head -1; }
