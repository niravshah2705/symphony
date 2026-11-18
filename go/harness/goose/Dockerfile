# Goose (goose) native harness runtime image.
# EXPERIMENTAL SCAFFOLD — buildable manually only; NOT in go/harness/runtime-images.csv.
# Build context is the module root:  docker build -f go/harness/goose/Dockerfile go
#   --build-arg RUNTIME_VERSION=1.0.0
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
ARG RUNTIME_VERSION=1.0.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/block/goose/releases/download/stable/bootstrap | bash -s ${RUNTIME_VERSION} \
    && groupadd --system -g 65532 runtime \
    && useradd --system --uid 65532 --gid runtime --home-dir /data --shell /usr/sbin/nologin runtime \
    && mkdir -p /data/adapter /data/goose /data/workspace \
    && chown -R 65532:65532 /data

COPY --from=builder /goose-runtime /usr/local/bin/goose-runtime

USER 65532:65532
WORKDIR /data
EXPOSE 80 8081

LABEL org.opencontainers.image.source="https://github.com/niravshah2705/symphony"
LABEL org.opencontainers.image.description="AI Fleet Goose (goose) experimental native harness runtime"
LABEL org.opencontainers.image.version="${RUNTIME_VERSION}"

ENTRYPOINT ["/usr/local/bin/goose-runtime"]
