#!/usr/bin/env sh
# Preflight for deploy/kagent/skills.csv — the standalone-skill track.
#
# The sibling of verify-plugin-images.sh, kept separate on purpose. A plugin row
# is checkable against an upstream version string; a standalone skill usually
# has none (cloudflare/security-audit-skill ships no VERSION, no package.json,
# no releases and no tags), so the checks that replace the version comparison
# are structural:
#   - the commit is a full 40-char lowercase hex pin, as kagent requires;
#   - the row's Dockerfile exists in the checkout;
#   - the row names exactly one current=true artifact per skill;
#   - version_source "none" forces the version column to be the pin's first 12
#     characters, because that is the only string that identifies these bytes;
#     any other version_source must state the row's version at that commit, the
#     same way the plugin rows are checked;
#   - <skill_path>/SKILL.md exists at the pinned commit, and its front-matter
#     name matches the skill column — the mounted directory name is the skill
#     name kagent advertises, so an upstream rename must fail here rather than
#     start an agent with a tool it cannot call.
#
# Fails non-zero on any violation so a stale or malformed CSV breaks the CI run
# early instead of publishing an artifact nothing can mount.
#
#   scripts/verify-skill-artifacts.sh
#   scripts/verify-skill-artifacts.sh --selected FILE
#
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
csv="${root}/deploy/kagent/skills.csv"
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

fail_marker="$(mktemp)"
rows_marker="$(mktemp)"
current_marker="$(mktemp)"
trap 'rm -f "$fail_marker" "$rows_marker" "$current_marker"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >> "$fail_marker"; }

in_selection() {
  # Same contract as verify-plugin-images.sh: an unselected row is reported and
  # does not fail the run, so a stale skill cannot block a bump of another.
  [ -z "$selected" ] && return 0
  grep -qxF "$1 $2" "$selected"
}

awk -F',' 'NR==1{for(i=1;i<=NF;i++)h[$i]=i;next} NF{
  print $h["skill"], $h["repo"], $h["commit"], $h["version"], $h["version_source"], $h["skill_path"], $h["image"], $h["dockerfile"], $h["current"]
}' "$csv" |
while IFS=' ' read -r skill repo commit version version_source skill_path image dockerfile current; do
  printf '%s\n' "$skill" >> "$rows_marker"
  if ! in_selection "$skill" "$version"; then
    printf 'skip (not selected): %s %s\n' "$skill" "$version"
    continue
  fi
  case "$skill" in
    "" | *[!a-z0-9.-]* | -* | *- | .* | *. | *--* | *..*)
      fail "$skill: name is not a valid skill directory name" ;;
  esac
  case "$commit" in
    "" | *[!0-9a-f]*) fail "$skill: commit '${commit}' is not 40-char lowercase hex" ;;
    *) [ "${#commit}" -eq 40 ] || fail "$skill: commit '${commit}' is not 40 chars" ;;
  esac
  case "$current" in
    true)  printf '%s\n' "$skill" >> "$current_marker" ;;
    false) ;;
    *) fail "$skill: current must be true or false, got '${current}'" ;;
  esac
  [ -f "${root}/${dockerfile}" ] || fail "$skill: ${dockerfile} is not a file"
  # The "-skill" suffix is what keeps a skill artifact from being pulled by a
  # plugin row that happens to share the name — the two have different roots.
  case "$image" in
    */"$skill"-skill) ;;
    *) fail "$skill: image '${image}' must end in /$skill-skill" ;;
  esac
  case "$skill_path" in
    /* | *..*) fail "$skill: skill_path '${skill_path}' must be repo-relative with no .." ;;
    */"$skill") ;;
    *) fail "$skill: skill_path '${skill_path}' must end in /$skill; the mounted directory name IS the skill name" ;;
  esac
  case "$version_source" in
    none)
      [ "$version" = "$(printf '%s' "$commit" | cut -c1-12)" ] \
        || fail "$skill: version_source is none, so version must be the pin prefix $(printf '%s' "$commit" | cut -c1-12), got '${version}'" ;;
    VERSION | *.json | *.toml) ;;
    *) fail "$skill: version_source '${version_source}' must be none, VERSION, a *.json manifest or a *.toml" ;;
  esac
  # github.com/owner/repo(.git) -> raw.githubusercontent.com/owner/repo
  raw="$(printf '%s' "$repo" | sed -E 's#^https://github\.com/##; s#\.git$##')"
  if [ "$raw" = "$repo" ]; then
    fail "$skill: unsupported repo URL '${repo}' (expected https://github.com/owner/repo)"
    continue
  fi
  # When the upstream does state a version, the row must state the same one it
  # states at this commit — the read is the plugin verifier's read, so the two
  # never disagree about what a pack calls its own version.
  if [ "$version_source" != none ]; then
    body="$(curl -fsS --max-time 30 "https://raw.githubusercontent.com/${raw}/${commit}/${version_source}" 2>/dev/null || true)"
    case "$version_source" in
      *.json) upstream_version="$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)" ;;
      *.toml) upstream_version="$(printf '%s' "$body" | sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)" ;;
      *) upstream_version="$(printf '%s' "$body" | tr -d '[:space:]')" ;;
    esac
    if [ -z "$upstream_version" ]; then
      fail "$skill: no version readable from ${version_source} at ${raw}@${commit:0:12} (bad pin?)"
      continue
    elif [ "$upstream_version" != "$version" ]; then
      fail "$skill: upstream ${version_source} at the pinned commit is '${upstream_version}', the CSV row says '${version}'"
      continue
    fi
  fi
  entry="$(curl -fsS --max-time 30 "https://raw.githubusercontent.com/${raw}/${commit}/${skill_path}/SKILL.md" 2>/dev/null || true)"
  if [ -z "$entry" ]; then
    fail "$skill: no ${skill_path}/SKILL.md at ${commit:0:12} (bad pin, or upstream moved the skill)"
    continue
  fi
  fm_name="$(printf '%s\n' "$entry" | sed -n '1,20p' | sed -n 's/^name:[[:space:]]*\([A-Za-z0-9._-]*\).*/\1/p' | head -n 1)"
  if [ -z "$fm_name" ]; then
    fail "$skill: ${skill_path}/SKILL.md has no name: front matter at ${commit:0:12}"
  elif [ "$fm_name" != "$skill" ]; then
    fail "$skill: ${skill_path}/SKILL.md names itself '${fm_name}' at ${commit:0:12}"
  else
    printf 'ok: %s %s pinned at %s (%s lines of skill)\n' "$skill" "$version" "$commit" "$(printf '%s\n' "$entry" | wc -l | tr -d ' ')"
  fi
done

[ -s "$rows_marker" ] || fail "${csv} has no rows"
sort -u "$rows_marker" 2>/dev/null | while IFS= read -r s; do
  n="$(grep -cxF "$s" "$current_marker" 2>/dev/null || true)"
  [ "${n:-0}" -eq 1 ] || fail "skill ${s} needs exactly one current=true row, found ${n:-0}"
done

if [ -s "$fail_marker" ]; then
  cat "$fail_marker" >&2
  exit 1
fi
printf 'skill manifest OK\n'
