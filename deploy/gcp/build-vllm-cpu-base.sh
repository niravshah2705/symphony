#!/usr/bin/env bash
set -euo pipefail

# Builds the CPU-only vLLM base image that deploy/gcp/Dockerfile.inference-vllm
# extends. BEST-EFFORT / not part of any CI pipeline — run this by hand.
#
# vLLM's published `vllm/vllm-openai` Docker Hub image is CUDA-only; there is
# no public CPU tag to pull. The only supported path is building from vLLM's
# own docker/Dockerfile.cpu in their source repo (a Dockerfile can't nest a
# `docker build` inside a RUN step, hence this separate script + a thin
# Dockerfile.inference-vllm that FROMs the tag produced here).
#
# Expect this to take 30-60+ minutes and produce a multi-GB image. The build
# is CPU-microarchitecture-sensitive (AVX2/AVX512 flags) — a mismatch can
# produce a binary that only fails at Cloud Run runtime, so treat a
# successful build here as step one, not proof it will run.
#
# Usage: VLLM_TAG=v0.27.1 ./deploy/gcp/build-vllm-cpu-base.sh

VLLM_TAG="${VLLM_TAG:-v0.27.1}" # check https://github.com/vllm-project/vllm/releases for a newer stable tag
BASE_IMAGE_TAG="${BASE_IMAGE_TAG:-vllm-cpu-base:${VLLM_TAG}}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Cloning vllm-project/vllm @ ${VLLM_TAG} into ${WORKDIR}..."
git clone --branch "$VLLM_TAG" --depth 1 https://github.com/vllm-project/vllm.git "$WORKDIR/vllm"

echo "Building ${BASE_IMAGE_TAG} from docker/Dockerfile.cpu (target=vllm-openai)..."
docker build \
  -f "$WORKDIR/vllm/docker/Dockerfile.cpu" \
  --build-arg VLLM_CPU_X86=true \
  --target vllm-openai \
  -t "$BASE_IMAGE_TAG" \
  "$WORKDIR/vllm"

echo "Built $BASE_IMAGE_TAG"
echo "Next: docker build -f deploy/gcp/Dockerfile.inference-vllm --build-arg VLLM_BASE_IMAGE=$BASE_IMAGE_TAG -t <your-tag> deploy/gcp"
