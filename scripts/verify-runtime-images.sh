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
#
set -eu

csv="$(dirname "$0")/../go/harness/runtime-images.csv"
hash_mode=0
[ "${1:-}" = "--hash" ] && hash_mode=1

fail_marker="$(mktemp)"
trap 'rm -f "$fail_marker"' EXIT

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

fail() { printf '%s\n' "$@" >&2; : > "$fail_marker"; }

tail -n +2 "$csv" | while IFS=, read -r runtime dockerfile image version amd64_sha arm64_sha current; do
  [ -z "${runtime:-}" ] && continue
  if url=$(resolve_url "$runtime" "$version"); then
    if curl -fsIL --max-time 60 "$url" >/dev/null 2>&1; then
      resolved="resolvable"
    else
      fail "FAIL  $runtime $version NOT FOUND on feed: $url"
      continue
    fi
  else
    fail "FAIL  $runtime unknown runtime"
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
  echo "verify-runtime-images: one or more rows failed" >&2
  exit 1
fi
echo "verify-runtime-images: all rows resolvable"
