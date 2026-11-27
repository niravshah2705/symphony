#!/usr/bin/env bash
# Mirror a bundle image from Artifact Registry into a registry the CLUSTER NODES can
# pull anonymously — the operator half of the `mirror` step when BUNDLE_REGISTRY=kind.
# The BFF container has no docker binary, so this is deliberately a host-side command,
# and it is the exact text the failing step prints:
#
#   fleet-local/scripts/bundle-mirror.sh <pull-host> <project>/<repo>/<pkg> <tag> <region>
#   e.g. bundle-mirror.sh kind-registry:5000 my-gcp-project/fleet-bundles/claude-bundle 1f3c9a7b2d40 europe-west1
#
# <pull-host> is what the Harness CR will name (BUNDLE_PULL_HOST). The docker daemon on
# this machine usually knows the same registry under a different address, so override it
# with PUSH_HOST=localhost:5001 when `docker push` cannot resolve the cluster name.
#
# A retag recomputes the manifest, so the kind digest is NOT the AR digest. This script
# reads it back from the destination and prints it; the `mirror` step does the same read
# on its own retry, which is why running this and then rebuilding resumes instead of
# restarting the Cloud Build job.
set -euo pipefail

HOST="${1:-}"
PATHREF="${2:-}"
TAG="${3:-}"
REGION="${4:-}"
PUSH_HOST="${PUSH_HOST:-$HOST}"

if [ -z "$HOST" ] || [ -z "$PATHREF" ] || [ -z "$TAG" ] || [ -z "$REGION" ]; then
  echo "usage: bundle-mirror.sh <pull-host> <project>/<repo>/<pkg> <tag> <region>   (PUSH_HOST= overrides the docker-side address)" >&2
  exit 2
fi
command -v docker >/dev/null 2>&1 || { echo "docker is required on this host" >&2; exit 1; }
command -v gcloud >/dev/null 2>&1 || echo "note: gcloud not found — assuming '$REGION-docker.pkg.dev' is already authenticated for docker"

AR_HOST="$REGION-docker.pkg.dev"
SRC="$AR_HOST/$PATHREF:$TAG"
DST="$PUSH_HOST/$PATHREF:$TAG"
CRD="$HOST/$PATHREF:$TAG"

if command -v gcloud >/dev/null 2>&1; then
  gcloud auth configure-docker "$AR_HOST" --quiet >/dev/null
fi

echo "=== pull $SRC"
docker pull --platform linux/amd64 "$SRC"
echo "=== tag  $DST"
docker tag "$SRC" "$DST"
echo "=== push $DST"
docker push "$DST"

# Read the digest back from the destination rather than trusting `docker inspect` on the
# source: the two differ, and only the destination's is pullable by a node.
DIGEST="$(
  docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' "$DST" 2>/dev/null | tr -d '"' \
    || docker image inspect --format '{{index .RepoDigests 0}}' "$DST" 2>/dev/null | sed 's/.*@//' \
    || true
)"
if [ -z "$DIGEST" ]; then
  echo "pushed $DST but could not read its digest — check the registry is reachable at $PUSH_HOST" >&2
  exit 1
fi

echo
echo "mirrored. the Harness image is:"
echo "  $HOST/$PATHREF@$DIGEST"
echo "Retry the bundle run: 'mirror' reads this digest back from $HOST and 'apply' pins it."
