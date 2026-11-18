#!/usr/bin/env sh
# Preflight for go/harness/runtime-images.csv.
#
# Confirms each row's version still resolves on its upstream feed, and — for the
# checksum-pinned CLI drivers (claude, codex) — reports whether the per-arch
# SHA256 is present or still needs pinning. Fails non-zero on any unresolvable
# version so a stale CSV breaks early instead of building broken images.
#
#   scripts/verify-runtime-images.sh            # resolve check + sha report
#   scripts/verify-runtime-images.sh --hash     # additionally download + print the
#                                               # amd64/arm64 sha256 for CLI rows with
#                                               # an empty checksum column (slow)
#   scripts/verify-runtime-images.sh --selected FILE
#                                               # FILE lists "runtime version" lines,
#                                               # one per row the build will publish.
#                                               # Rows outside it are reported but do
#                                               # not fail the run, so a stale row in an
#                                               # unrelated runtime cannot block a bump.
#
set -eu

csv="$(dirname "$0")/../go/harness/runtime-images.csv"
hash_mode=0
selected=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hash) hash_mode=1 ;;
    --selected) selected="${2:?--selected needs a file}"; shift ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$selected" ] || [ -f "$selected" ] || { printf 'no such selection file: %s\n' "$selected" >&2; exit 2; }

fail_marker="$(mktemp)"
skipped_marker="$(mktemp)"
trap 'rm -f "$fail_marker" "$skipped_marker"' EXIT

# resolve_url <runtime> <version> -> URL to probe for existence
resolve_url() {
  case "$1" in
    claude)    printf 'https://downloads.claude.ai/claude-code-releases/%s/linux-x64-musl/claude' "$2" ;;
    codex)     printf 'https://github.com/openai/codex/releases/download/rust-v%s/codex-package-x86_64-unknown-linux-musl.tar.gz' "$2" ;;
    deepagent) printf 'https://pypi.org/pypi/deepagents-code/%s/json' "$2" ;;
    deepseek)  printf 'https://registry.npmjs.org/@deepseek-ai/dsh/%s' "$2" ;;
    *)         return 1 ;;
  esac
}

# arch_url <runtime> <arch> <version>
arch_url() {
  case "$1" in
    claude)
      case "$2" in
        amd64) printf 'https://downloads.claude.ai/claude-code-releases/%s/linux-x64-musl/claude' "$3" ;;
        arm64) printf 'https://downloads.claude.ai/claude-code-releases/%s/linux-arm64-musl/claude' "$3" ;;
      esac ;;
    codex)
      case "$2" in
        amd64) printf 'https://github.com/openai/codex/releases/download/rust-v%s/codex-package-x86_64-unknown-linux-musl.tar.gz' "$3" ;;
        arm64) printf 'https://github.com/openai/codex/releases/download/rust-v%s/codex-package-aarch64-unknown-linux-musl.tar.gz' "$3" ;;
      esac ;;
  esac
}

sha256_of_url() {
  curl -fsSL --max-time 300 "$1" | sha256sum | cut -d' ' -f1
}

# The markers must carry content: the pipeline below runs in a subshell, so a
# variable would not survive, and `[ -s ]` on a file mktemp already created is
# only true once something has been written into it.
fail() { printf '%s\n' "$@" >&2; printf 'fail\n' >> "$fail_marker"; }
skip() { printf '%s\n' "$@"; printf 'skip\n' >> "$skipped_marker"; }

tail -n +2 "$csv" | while IFS=, read -r runtime dockerfile image version amd64_sha arm64_sha current; do
  [ -z "${runtime:-}" ] && continue
  if [ -n "$selected" ] && ! grep -qxF "$runtime $version" "$selected"; then
    in_selection=0
  else
    in_selection=1
  fi

  if url=$(resolve_url "$runtime" "$version"); then
    if curl -fsIL --max-time 60 "$url" >/dev/null 2>&1; then
      resolved="resolvable"
    elif [ "$in_selection" = 1 ]; then
      fail "FAIL  $runtime $version NOT FOUND on feed: $url"
      continue
    else
      skip "WARN  $runtime $version NOT FOUND on feed, outside this selection"
      continue
    fi
  elif [ "$in_selection" = 1 ]; then
    fail "FAIL  $runtime unknown runtime"
    continue
  else
    skip "WARN  $runtime unknown runtime, outside this selection"
    continue
  fi

  case "$runtime" in
    claude|codex)
      if [ -z "$amd64_sha" ] || [ -z "$arm64_sha" ]; then
        printf 'WARN  %-9s %-12s resolvable; sha256 NOT pinned (build skips integrity check)\n' "$runtime" "$version"
        if [ "$hash_mode" = 1 ]; then
          printf '      amd64 %s\n' "$(sha256_of_url "$(arch_url "$runtime" amd64 "$version")")"
          printf '      arm64 %s\n' "$(sha256_of_url "$(arch_url "$runtime" arm64 "$version")")"
        fi
      else
        printf 'OK    %-9s %-12s resolvable + sha256 pinned\n' "$runtime" "$version"
      fi ;;
    *)
      printf 'OK    %-9s %-12s %s (no per-arch checksum for %s driver)\n' "$runtime" "$version" "$resolved" "$runtime" ;;
  esac
done

if [ -s "$fail_marker" ]; then
  echo "verify-runtime-images: one or more selected rows failed" >&2
  exit 1
fi
if [ -s "$skipped_marker" ]; then
  echo "verify-runtime-images: selected rows resolvable (unrelated rows reported as WARN)"
else
  echo "verify-runtime-images: all rows resolvable"
fi
