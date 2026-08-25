#!/usr/bin/env bash
set -euo pipefail

# gcsfuse is a poor fit for vLLM's mmap/random-read pattern over safetensors
# (and the repo's own skills gcsfuse mount is already documented as failing a
# startup probe on a far smaller payload), so copy the pinned version's model
# directory to local disk once at container start, then serve from there.

MODEL_VERSION="${MODEL_VERSION:?MODEL_VERSION env var is required}"
MODEL_NAME="${MODEL_NAME:?MODEL_NAME env var is required}"
SRC="/models/vllm/${MODEL_VERSION}/${MODEL_NAME}"
DEST="/local-models/${MODEL_NAME}"

mkdir -p "$DEST"
if [ -d "$SRC" ]; then
  echo "Copying pinned model ${MODEL_NAME}@${MODEL_VERSION} from ${SRC} to ${DEST}..."
  cp -r "${SRC}/." "$DEST/"
else
  echo "ERROR: ${SRC} not found on the gcsfuse mount (models_mount_enabled off, bucket empty, or this version not yet published by publish-models.yml)." >&2
  exit 1
fi

exec vllm serve "$DEST" --host 0.0.0.0 --port 8080 --served-model-name "$MODEL_NAME"
