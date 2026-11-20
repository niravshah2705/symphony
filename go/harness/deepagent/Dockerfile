# DeepAgent (deepagents-code) native harness runtime image.
# Build context is the module root:  docker build -f go/harness/deepagent/Dockerfile go
# Pin the CLI release via the build arg (driven by go/harness/runtime-images.csv):
#   --build-arg RUNTIME_VERSION=0.2.9
ARG BASE_IMAGE_REGISTRY=cgr.dev
ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM ${BASE_IMAGE_REGISTRY}/chainguard/go:latest AS builder
ARG TARGETARCH
ARG TARGETOS

WORKDIR /workspace
COPY go.mod go.sum ./
COPY api/ api/
COPY adk/ adk/
COPY core/ core/
COPY harness/ harness/
COPY pkg/ pkg/
RUN --mount=type=cache,target=/root/go/pkg/mod,rw \
    --mount=type=cache,target=/root/.cache/go-build,rw \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -trimpath -o /deepagent-runtime ./harness/deepagent/cmd

# glibc base, not alpine: deepagents-code needs langgraph-checkpoint-sqlite, which
# depends on sqlite-vec — published as manylinux/mac/win wheels only, so no musl
# environment can resolve it. Python is pinned to the CLI's own >=3.14,<3.15 floor.
FROM python:3.14-slim
ARG RUNTIME_VERSION=0.2.9

# uv places the deepagents-code shim in UV_TOOL_BIN_DIR (on PATH) and its tool
# env under UV_TOOL_DIR, both world-readable so the non-root runtime user can run it.
ENV UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_TOOL_DIR=/usr/local/share/uv/tools \
    DEEPAGENTS_DISABLE_UPDATES=1 \
    DEEPAGENTS_CODE_VERSION=${RUNTIME_VERSION}
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git libgcc-s1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv \
    && uv tool install deepagents-code==${RUNTIME_VERSION} \
    && groupadd --system -g 65532 runtime \
    && useradd --system --uid 65532 --gid runtime --home-dir /data --shell /usr/sbin/nologin runtime \
    && mkdir -p /data/adapter /data/deepagent /data/workspace \
    && chown -R 65532:65532 /data

COPY --from=builder /deepagent-runtime /usr/local/bin/deepagent-runtime

USER 65532:65532
# The adapter creates its workspace after the durable /data volume is mounted.
WORKDIR /data
EXPOSE 80 8081

LABEL org.opencontainers.image.source="https://github.com/niravshah2705/symphony"
LABEL org.opencontainers.image.description="Software Factory DeepAgent (deepagents-code) native harness runtime"
LABEL org.opencontainers.image.version="${RUNTIME_VERSION}"

ENTRYPOINT ["/usr/local/bin/deepagent-runtime"]
