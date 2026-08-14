#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)

usage() {
  cat <<'EOF'
Usage: scripts/run-checks.sh [--suite <suite>]

Run the same checks used by the manually dispatched GitHub workflow.

Suites:
  all       Node unit tests, Playwright E2E, org, and settings (default)
  node      Node unit tests
  e2e       Playwright E2E tests with Chrome and CI behavior
  org       Org service pytest suite in a temporary Python 3.12 venv
  settings  Settings service pytest suite in a temporary Python 3.12 venv

Options:
  --suite <suite>  Select a suite
  -h, --help       Show this help
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

preflight_node() {
  local node_version node_major

  require_command node
  node_version=$(node --version)
  node_version=${node_version#v}
  node_major=${node_version%%.*}

  case "$node_major" in
    ''|*[!0-9]*) die "could not determine the Node.js version" ;;
  esac

  if [ "$node_major" -lt 22 ]; then
    die "Node.js 22 or newer is required (found v$node_version)"
  fi
}

preflight_python() {
  local python_version

  require_command python3.12
  python_version=$(python3.12 --version 2>&1)
  case "$python_version" in
    'Python 3.12'|'Python 3.12.'*) ;;
    *) die "Python 3.12 is required (found $python_version)" ;;
  esac
}

run_node_suite() {
  printf '\n==> Node unit tests\n'
  # Enumerate trusted source surfaces. Bare `node --test` also discovers
  # ignored/untracked third-party registry bundles and could execute payloads
  # that are not part of the committed repository.
  node --test \
    "packages/shared-core/src/**/*.test.js" \
    "packages/shared/src/**/*.test.js" \
    "packages/cli/src/**/*.test.js" \
    "public/js/*.test.mjs" \
    "scripts/*.test.js" \
    "services/gateway/src/**/*.test.js" \
    "services/planner/src/**/*.test.js" \
    "services/coder/src/**/*.test.js" \
    "services/orchestrator/src/**/*.test.js" \
    "services/tester/src/**/*.test.js" \
    "services/deployer/src/**/*.test.js" \
    "services/email/src/**/*.test.js" \
    "services/provisioner/src/**/*.test.js" \
    "services/proxy/src/**/*.test.js" \
    "deploy/gcp/**/*.test.js"
}

run_e2e_suite() {
  printf '\n==> Playwright E2E tests\n'
  if [ "$(uname -s)" = Linux ]; then
    npx playwright install --with-deps chrome
  else
    npx playwright install chrome
  fi
  CI=true npm run test:e2e
}

run_python_suite() {
  local service_name service_dir temp_root venv_dir venv_python

  service_name=$1
  service_dir=$REPO_ROOT/services/$service_name
  [ -d "$service_dir" ] || die "service directory not found: $service_dir"

  temp_root=$(mktemp -d "${TMPDIR:-/tmp}/ai-fleet-${service_name}-checks.XXXXXX")
  venv_dir=$temp_root/venv
  venv_python=$venv_dir/bin/python

  (
    trap 'rm -rf -- "$temp_root"' EXIT

    printf '\n==> %s service tests\n' "$service_name"
    python3.12 -m venv "$venv_dir"
    (
      cd "$service_dir"
      "$venv_python" -m pip install --disable-pip-version-check '.[test]'
      PYTHONDONTWRITEBYTECODE=1 "$venv_python" -m pytest -q -p no:cacheprovider
    )
  )
}

SUITE=all

while [ "$#" -gt 0 ]; do
  case "$1" in
    --suite)
      [ "$#" -ge 2 ] || die "--suite requires a value"
      SUITE=$2
      shift 2
      ;;
    --suite=*)
      SUITE=${1#--suite=}
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (run with --help for usage)"
      ;;
  esac
done

case "$SUITE" in
  all|node|e2e|org|settings) ;;
  *) die "invalid suite '$SUITE'; expected all, node, e2e, org, or settings" ;;
esac

cd "$REPO_ROOT"

case "$SUITE" in
  all|node|e2e)
    preflight_node
    require_command npm
    ;;
esac

case "$SUITE" in
  all|e2e)
    require_command npx
    require_command uname
    ;;
esac

case "$SUITE" in
  all|org|settings)
    preflight_python
    ;;
esac

case "$SUITE" in
  all|node|e2e)
    printf '==> Installing Node.js dependencies from package-lock.json\n'
    npm ci
    ;;
esac

case "$SUITE" in
  all)
    run_node_suite
    run_e2e_suite
    run_python_suite org
    run_python_suite settings
    ;;
  node) run_node_suite ;;
  e2e) run_e2e_suite ;;
  org) run_python_suite org ;;
  settings) run_python_suite settings ;;
esac

printf '\nAll requested checks passed (suite: %s).\n' "$SUITE"
