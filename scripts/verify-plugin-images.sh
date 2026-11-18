#!/usr/bin/env sh
# Preflight for deploy/kagent/plugins.csv.
#
# For every row (or only the "plugin version" lines listed in --selected FILE):
#   - the commit is a full 40-char lowercase hex pin, as kagent requires;
#   - the row's Dockerfile exists in the checkout;
#   - the file named by version_source, read at that commit, states the row's
#     version, so an image is never labelled with bytes it does not contain.
#     Only ECC ships a VERSION file: the rest keep their version in
#     package.json, pyproject.toml, plugin.json or .claude-plugin/plugin.json,
#     and a row that names none of those is a preflight failure rather than a
#     silent read of the wrong file.
# After the rows: every plugin has exactly one current=true row (it owns the
# :latest tag) and the manifest is not empty.
#
# Fails non-zero on any violation so a stale or malformed CSV breaks the CI run
# early instead of publishing a mislabelled plugin image.
#
#   scripts/verify-plugin-images.sh
#   scripts/verify-plugin-images.sh --selected FILE
#
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
csv="${root}/deploy/kagent/plugins.csv"
selected=""
while [ $# -gt 0 ]; do
  case "$1" in
    --selected) selected="${2:?--selected needs a file}"; shift ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$selected" ] || [ -f "$selected" ] || { printf 'no such selection file: %s\n' "$selected" >&2; exit 2; }
[ -f "$csv" ] || { printf 'no manifest at %s\n' "$csv" >&2; exit 1; }

# The row loop runs behind a pipe, so failures travel through marker files
# instead of a counter a subshell would discard.
fail_marker="$(mktemp)"
rows_marker="$(mktemp)"
current_marker="$(mktemp)"
trap 'rm -f "$fail_marker" "$rows_marker" "$current_marker"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >> "$fail_marker"; }

in_selection() {
  # Rows outside the selection are reported but do not fail the run, so a stale
  # row for one plugin cannot block a bump of another (verify-runtime-images.sh
  # honors the same contract).
  [ -z "$selected" ] && return 0
  grep -qxF "$1 $2" "$selected"
}

# Read the version a pack states about itself, out of the file it states it in.
# VERSION is bare text; a JSON manifest is the first "version" key; a
# pyproject.toml is the unindented project version, so a [tool.*] version that
# happens to be spelled the same way cannot answer for the package.
read_upstream_version() {
  base_url="$1"
  source="$2"
  body="$(curl -fsS --max-time 30 "${base_url}/${source}" 2>/dev/null || true)"
  [ -n "$body" ] || return 1
  case "$source" in
    *.json) printf '%s' "$body" \
      | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 ;;
    *.toml) printf '%s' "$body" \
      | sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 ;;
    *) printf '%s' "$body" | tr -d '[:space:]' ;;
  esac
}

awk -F',' 'NR==1{for(i=1;i<=NF;i++)h[$i]=i;next} NF{
  print $h["plugin"], $h["repo"], $h["commit"], $h["version"], $h["version_source"], $h["dockerfile"], $h["current"]
}' "$csv" |
while IFS=' ' read -r plugin repo commit version version_source dockerfile current; do
  printf '%s\n' "$plugin" >> "$rows_marker"
  if ! in_selection "$plugin" "$version"; then
    printf 'skip (not selected): %s %s\n' "$plugin" "$version"
    continue
  fi
  case "$commit" in
    "" | *[!0-9a-f]*) fail "$plugin $version: commit '${commit}' is not 40-char lowercase hex" ;;
    *) [ "${#commit}" -eq 40 ] || fail "$plugin $version: commit '${commit}' is not 40 chars" ;;
  esac
  case "$current" in
    true)  printf '%s\n' "$plugin" >> "$current_marker" ;;
    false) ;;
    *) fail "$plugin $version: current must be true or false, got '${current}'" ;;
  esac
  [ -f "${root}/${dockerfile}" ] || fail "$plugin $version: ${dockerfile} is not a file"
  # github.com/owner/repo(.git) -> raw.githubusercontent.com/owner/repo
  raw="$(printf '%s' "$repo" | sed -E 's#^https://github\.com/##; s#\.git$##')"
  if [ "$raw" = "$repo" ]; then
    fail "$plugin: unsupported repo URL '${repo}' (expected https://github.com/owner/repo)"
    continue
  fi
  case "$version_source" in
    VERSION|package.json|pyproject.toml|plugin.json|*.json|*.toml) ;;
    *) fail "$plugin $version: version_source '${version_source}' is not VERSION, a *.json manifest or a *.toml"; continue ;;
  esac
  upstream_version="$(read_upstream_version "https://raw.githubusercontent.com/${raw}/${commit}" "$version_source" || true)"
  if [ -z "$upstream_version" ]; then
    fail "$plugin $version: no version readable from ${version_source} at ${raw}@${commit} (bad pin?)"
  elif [ "$upstream_version" != "$version" ]; then
    fail "$plugin $version: upstream ${version_source} at the pinned commit is '${upstream_version}'"
  else
    printf 'ok: %s %s pinned at %s\n' "$plugin" "$version" "$commit"
  fi
done

[ -s "$rows_marker" ] || fail "${csv} has no rows"
# A plugin with zero selected rows still needs exactly one current=true row overall.
sort -u "$rows_marker" 2>/dev/null | while IFS= read -r p; do
  n="$(grep -cxF "$p" "$current_marker" 2>/dev/null || true)"
  [ "${n:-0}" -eq 1 ] || fail "plugin ${p} needs exactly one current=true row, found ${n:-0}"
done

if [ -s "$fail_marker" ]; then
  cat "$fail_marker" >&2
  exit 1
fi
printf 'plugin manifest OK\n'
