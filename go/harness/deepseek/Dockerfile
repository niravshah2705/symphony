# DeepSeek (dsh) native harness runtime image.
# Build context is the module root:  docker build -f go/harness/deepseek/Dockerfile go
# Pin the CLI release via the build arg (driven by go/harness/runtime-images.csv):
#   --build-arg RUNTIME_VERSION=0.2.2-rc.4
# Uses a glibc Node base because @deepseek-ai/dsh pulls native modules
# (koffi, node-pty) that need a compiled toolchain and glibc prebuilts.
ARG BASE_IMAGE_REGISTRY=cgr.dev
ARG NODE_IMAGE=node:22-slim
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
    go build -trimpath -o /deepseek-runtime ./harness/deepseek/cmd

FROM ${NODE_IMAGE}
ARG RUNTIME_VERSION=0.2.2-rc.4

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_DISABLE_UPDATES=1 \
    DSH_VERSION=${RUNTIME_VERSION}
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git curl python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    # --allow-scripts is the npm/lavamoat gate for the dsh native deps; kept verbatim
    # so the pinned postinstall steps run. npm otherwise ignores the unknown config key.
    && npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs @deepseek-ai/dsh@${RUNTIME_VERSION} \
    && groupadd -g 65532 runtime \
    && useradd -u 65532 -g runtime -d /data -s /usr/sbin/nologin -M runtime \
    && mkdir -p /data/adapter /data/deepseek /data/workspace \
    && chown -R 65532:65532 /data

COPY --from=builder /deepseek-runtime /usr/local/bin/deepseek-runtime

USER 65532:65532
WORKDIR /data
EXPOSE 80 8081

LABEL org.opencontainers.image.source="https://github.com/niravshah2705/symphony"
LABEL org.opencontainers.image.description="Software Factory DeepSeek (dsh) native harness runtime"
LABEL org.opencontainers.image.version="${RUNTIME_VERSION}"

ENTRYPOINT ["/usr/local/bin/deepseek-runtime"]
