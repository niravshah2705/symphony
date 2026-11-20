# Goose (goose) native harness runtime image.
# EXPERIMENTAL — published via go/harness/runtime-images.csv; no in-cluster kagent translator yet.
# Build context is the module root:  docker build -f go/harness/goose/Dockerfile go
#   --build-arg RUNTIME_VERSION=1.60.1
# GOOSE_PROVIDER / GOOSE_MODEL override ~/.config/goose/config.yaml; MCP-native extensions.
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
    go build -trimpath -o /goose-runtime ./harness/goose/cmd

FROM ubuntu:24.04
ARG RUNTIME_VERSION=1.60.1
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends bash ca-certificates git curl tar; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH:-amd64}" in \
      amd64) GOOSE_ARCH=x86_64 ;; \
      arm64) GOOSE_ARCH=aarch64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/aaif-goose/goose/releases/download/v${RUNTIME_VERSION}/goose-${GOOSE_ARCH}-unknown-linux-gnu.tar.gz" -o /tmp/goose.tar.gz; \
    mkdir -p /tmp/goose-extract; \
    tar -xzf /tmp/goose.tar.gz -C /tmp/goose-extract; \
    install -m 0755 "$(find /tmp/goose-extract -type f -name goose -print -quit)" /usr/local/bin/goose; \
    rm -rf /tmp/goose.tar.gz /tmp/goose-extract; \
    groupadd --system -g 65532 runtime; \
    useradd --system --uid 65532 --gid runtime --home-dir /data --shell /usr/sbin/nologin runtime; \
    mkdir -p /data/adapter /data/goose /data/workspace; \
    chown -R 65532:65532 /data

COPY --from=builder /goose-runtime /usr/local/bin/goose-runtime

USER 65532:65532
WORKDIR /data
EXPOSE 80 8081

LABEL org.opencontainers.image.source="https://github.com/niravshah2705/symphony"
LABEL org.opencontainers.image.description="Software Factory Goose (goose) experimental native harness runtime"
LABEL org.opencontainers.image.version="${RUNTIME_VERSION}"

ENTRYPOINT ["/usr/local/bin/goose-runtime"]
