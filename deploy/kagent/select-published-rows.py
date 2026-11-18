#!/usr/bin/env python3
"""Print the manifest rows whose bundle bytes actually changed.

Used by build-plugin-images.yml and build-skill-images.yml so that a merge
which moves one pack's row does not republish every other artifact. The point
is that a bundle build is not byte-reproducible: multi-arch, provenance and
SBOM attach new timestamps, so rebuilding an unchanged row publishes new bytes
under the same tag and the stamp job then rewrites that pack's committed
manifest with a digest no source change produced.

Selection, in order:

  1. mode=all -> every row. A PR run and a run with no usable baseline take
     this branch: on a PR the resolution is validation only, and where there
     is no baseline to diff, being conservative is the safe direction.
  2. mode=changed -> a row is chosen when its whole normalized dict differs
     from the baseline dict keyed by (id, version). That catches a new pin, a
     version bump, a flipped `current` and an added row alike; a deleted row
     simply has nothing left to publish.
  3. A changed path inside a row's own pack directory - the dirname of its
     Dockerfile, which is the same rule pack-inputs.sh uses - selects that
     row: bundle.env, skills.txt, overlay/ and mcp.json all reach the bytes.
  4. A changed path that composes every bundle - a composer, an input
     resolver, the local builder, this selector itself, this pipeline's own
     workflow - selects all rows, because it changes the recipe for all of them
     at once. The selector is a recipe change because it decides what "the bytes
     of this pack" means; the first merge after one of its own edits rebuilding
     every pack is the point, not a cost.
  5. A changed path that belongs to the other track, or that provably reaches
     no bundle byte (docs, icons, catalogs, generators, validation, tests, the
     generated support matrix) is inert: the two tracks publish different images
     from different inputs.
  6. Anything else is treated as a recipe change. Under-building publishes
     bytes that no source change produced under a tag the manifests already
     name, which is worse than one wasted publish.

Usage:
  select-published-rows.py --track plugin --mode changed
      --manifest deploy/kagent/plugins.csv
      --base-csv /tmp/base.csv --paths /tmp/changed.txt
      --selected /tmp/selected.txt [--only ecc]

Writes "<id> <version>" lines to --selected and prints matrix=/count=/reason=
lines for $GITHUB_OUTPUT.
"""

import argparse
import csv
import json
import os
import sys

ID_COLUMN = {"plugin": "plugin", "skill": "skill"}
OTHER_TRACK = {"plugin": "skill", "skill": "plugin"}

# The other track's manifest, whose rows and pack directories are inert here.
OTHER_MANIFEST = {"plugin": "deploy/kagent/skills.csv", "skill": "deploy/kagent/plugins.csv"}

# Changing any of these changes the bytes of every bundle this track composes.
SHARED_RECIPE = {
    "plugin": [
        "deploy/kagent/ecc-plugin/compose-bundle.sh",
        "deploy/kagent/pack-inputs.sh",
        "deploy/kagent/build-plugin-image.sh",
        "deploy/kagent/select-published-rows.py",
        ".github/workflows/build-plugin-images.yml",
    ],
    "skill": [
        "deploy/kagent/compose-skill-bundle.sh",
        "deploy/kagent/skill-inputs.sh",
        "deploy/kagent/build-skill-image.sh",
        "deploy/kagent/select-published-rows.py",
        ".github/workflows/build-skill-images.yml",
    ],
}

# The other track's shared inputs. A skill edit must not rebuild seven plugins,
# and a plugin edit must not republish a skill.
OTHER_SHARED = {
    "plugin": [
        "deploy/kagent/compose-skill-bundle.sh",
        "deploy/kagent/skill-inputs.sh",
        "deploy/kagent/build-skill-image.sh",
        "deploy/kagent/skills/",
        ".github/workflows/build-skill-images.yml",
    ],
    "skill": [
        "deploy/kagent/ecc-plugin/",
        "deploy/kagent/pack-inputs.sh",
        "deploy/kagent/build-plugin-image.sh",
        "deploy/kagent/plugin-support.csv",
        ".github/workflows/build-plugin-images.yml",
    ],
}

# These carry no byte that enters a bundle. The catalogs are inert because the
# composers read only the PLUGIN_*/SKILL_* environment that pack-inputs.sh and
# skill-inputs.sh build from the CSV row plus the pack's own bundle.env;
# plugin-catalog.test.js asserts that stays true, because a catalog field that
# reached a bundle would have to join this selection instead of being inert.
INERT_PREFIX = ["docs/", "public/", "packages/", "scripts/", ".githooks/"]
INERT_SUFFIX = [".md", ".test.js", ".test.mjs"]

# Generated, and generated from the catalogs plus the two manifests: the support
# matrix records which harness ships which version, it is never copied into a
# bundle. It moves in the same commit as the catalog edit that produced it, and
# treating it as a recipe change would republish every pack for a documentation
# refresh.
INERT_EXACT = ["deploy/kagent/plugin-support.csv"]


def load_rows(path):
    with open(path, newline="") as handle:
        return [
            {k: (v or "").strip() for k, v in row.items()}
            for row in csv.DictReader(handle)
        ]


def directory_ids(rows, key):
    """{pack directory: the (id, version) rows that directory composes}."""
    dirs = {}
    for row in rows:
        if not row.get("dockerfile"):
            continue
        dirs.setdefault(os.path.dirname(row["dockerfile"]), set()).add((row[key], row["version"]))
    return dirs


def classify(path, track, manifest, this_dirs, other_dirs):
    """What one changed path means for this track.

    Returns "skip", "inert", "recipe", or the set of rows it selects.
    """
    if path == manifest:
        return "skip"  # the baseline compare already covers this track's CSV
    if any(path.startswith(prefix) for prefix in SHARED_RECIPE[track]):
        return "recipe"
    if path == OTHER_MANIFEST[track]:
        return "inert"
    if path in INERT_EXACT:
        return "inert"
    if any(path.startswith(prefix) for prefix in OTHER_SHARED[track]):
        return "inert"
    if any(path.startswith(directory + "/") for directory in other_dirs):
        return "inert"
    hit = set()
    for directory, ids in this_dirs.items():
        if path.startswith(directory + "/"):
            hit |= ids
    if hit:
        return hit
    if any(path.startswith(prefix) for prefix in INERT_PREFIX):
        return "inert"
    if any(path.endswith(suffix) for suffix in INERT_SUFFIX):
        return "inert"
    return "recipe"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--track", required=True, choices=sorted(ID_COLUMN))
    parser.add_argument("--mode", default="all", choices=["all", "changed"])
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--base-csv", default="")
    parser.add_argument("--paths", default="")
    parser.add_argument("--only", default="")
    parser.add_argument("--selected", required=True)
    args = parser.parse_args()

    key = ID_COLUMN[args.track]
    rows = load_rows(args.manifest)
    if not rows:
        sys.exit(f"{args.manifest} has no rows")
    for row in rows:
        if not row["dockerfile"]:
            sys.exit(f"row {row[key]} {row['version']}: empty dockerfile")

    this_dirs = directory_ids(rows, key)
    other_dirs = set()
    if os.path.exists(OTHER_MANIFEST[args.track]):
        other_key = ID_COLUMN[OTHER_TRACK[args.track]]
        other_dirs = set(directory_ids(load_rows(OTHER_MANIFEST[args.track]), other_key))

    chosen = rows
    reason = "full manifest"
    if args.mode == "changed":
        if not args.base_csv or not os.path.exists(args.base_csv):
            reason = "changed requested but no baseline manifest"
        else:
            before = {(r[key], r["version"]): r for r in load_rows(args.base_csv)}
            head = {(r[key], r["version"]): r for r in rows}
            chosen_ids = {rid for rid, row in head.items() if before.get(rid) != row}
            reasons = ["moved rows"] if chosen_ids else []
            force_all = False
            paths = []
            if args.paths and os.path.exists(args.paths):
                with open(args.paths) as handle:
                    paths = [line.strip() for line in handle if line.strip()]
            for path in paths:
                kind = classify(path, args.track, args.manifest, this_dirs, other_dirs)
                if kind == "skip" or kind == "inert":
                    continue
                if kind == "recipe":
                    force_all = True
                    break
                chosen_ids |= kind
                if "pack inputs" not in reasons:
                    reasons.append("pack inputs")
            if force_all:
                reason = "shared recipe changed"
            elif not chosen_ids:
                chosen = []
                reason = "nothing moved"
            else:
                chosen = [r for r in rows if (r[key], r["version"]) in chosen_ids]
                reason = " and ".join(reasons)

    if args.only:
        # Checked against the whole manifest: a pack whose rows simply did not
        # move is a no-op, only an unknown name is a typo.
        if args.only not in {row[key] for row in rows}:
            sys.exit(f"no manifest rows for {args.track} {args.only!r}")
        chosen = [row for row in chosen if row[key] == args.only]

    matrix = []
    for row in chosen:
        tags = [f"{row['image']}:{row['version']}"]
        if row.get("current") == "true":
            tags.append(f"{row['image']}:latest")
        entry = {key: row[key]}
        for field in ("repo", "commit", "version", "image", "dockerfile"):
            entry[field] = row[field]
        if key == "skill":
            entry["skill_path"] = row["skill_path"]
            # No :latest on this track: a skill's version IS its pin, so a
            # moving alias would be a second name for bytes no manifest names.
            entry["tags"] = f"{row['image']}:{row['version']}"
        else:
            entry["tags"] = ",".join(tags)
        matrix.append(entry)

    with open(args.selected, "w") as handle:
        for entry in matrix:
            handle.write(f"{entry[key]} {entry['version']}\n")

    print("matrix=" + json.dumps(matrix))
    print("count=" + str(len(matrix)))
    print("reason=" + reason)
    print(f"selected {len(matrix)} row(s): {reason}", file=sys.stderr)


if __name__ == "__main__":
    main()
