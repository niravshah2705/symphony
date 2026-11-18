# Qoder (qodercli) native harness runtime image.
# EXPERIMENTAL — published via go/harness/runtime-images.csv; no in-cluster kagent translator yet.
# Build context is the module root:  docker build -f go/harness/qoder/Dockerfile go
#   --build-arg RUNTIME_VERSION=1.1.92
# QODER_PERSONAL_ACCESS_TOKEN; CANNOT run under egress proxy (fail closed).
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
    go build -trimpath -o /qoder-runtime ./harness/qoder/cmd

FROM node:22-slim
ARG RUNTIME_VERSION=1.1.92
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @qoder-ai/qodercli@${RUNTIME_VERSION} \
    && groupadd --system -g 65532 runtime \
    && useradd --system --uid 65532 --gid runtime --home-dir /data --shell /usr/sbin/nologin runtime \
    && mkdir -p /data/adapter /data/qoder /data/workspace \
    && chown -R 65532:65532 /data

COPY --from=builder /qoder-runtime /usr/local/bin/qoder-runtime

USER 65532:65532
WORKDIR /data
EXPOSE 80 8081

LABEL org.opencontainers.image.source="https://github.com/niravshah2705/symphony"
LABEL org.opencontainers.image.description="AI Fleet Qoder (qodercli) experimental native harness runtime"
LABEL org.opencontainers.image.version="${RUNTIME_VERSION}"

ENTRYPOINT ["/usr/local/bin/qoder-runtime"]
