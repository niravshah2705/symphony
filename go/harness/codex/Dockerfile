# Codex App Server native harness runtime image (ported from kagent go/harness/codex).
# Build context is the module root:  docker build -f go/harness/codex/Dockerfile go
# Override the pinned release via build args (driven by go/harness/runtime-images.csv):
#   --build-arg RUNTIME_VERSION=0.161.0 \
#   --build-arg AMD64_SHA256=<sha> --build-arg ARM64_SHA256=<sha>
ARG BASE_IMAGE_REGISTRY=cgr.dev
ARG ALPINE_VERSION=3.24
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
    go build -trimpath -o /codex-runtime ./harness/codex/cmd

FROM alpine:${ALPINE_VERSION}
ARG RUNTIME_VERSION=0.161.0
ARG AMD64_SHA256=04d8ab9dbcb9df0edf3c67dca5072a374babfdf762a9bc4ae649ae140b8e2cf0
ARG ARM64_SHA256=3c02e2ae34be0d06e62557e98fc5c0a783bec5a2fed406fe00e565803bf84ee8
ARG TARGETARCH

ENV CODEX_CLI_VERSION=${RUNTIME_VERSION}
RUN apk upgrade --no-cache && apk add --no-cache bash ca-certificates git libgcc libstdc++ \
    && case "${TARGETARCH}" in \
        amd64) platform="x86_64-unknown-linux-musl"; checksum="${AMD64_SHA256}" ;; \
        arm64) platform="aarch64-unknown-linux-musl"; checksum="${ARM64_SHA256}" ;; \
        *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -T 60 -t 3 -O /tmp/codex.tar.gz \
        "https://github.com/openai/codex/releases/download/rust-v${RUNTIME_VERSION}/codex-package-${platform}.tar.gz" \
    && if [ -n "${checksum}" ]; then \
         echo "${checksum}  /tmp/codex.tar.gz" | sha256sum -c -; \
       else \
         echo "WARNING: no AMD64/ARM64_SHA256 pinned for ${RUNTIME_VERSION}; skipping integrity check" >&2; \
       fi \
    && tar -xzf /tmp/codex.tar.gz -C /usr/local \
    && rm /tmp/codex.tar.gz \
    && addgroup -S -g 65532 runtime \
    && adduser -S -D -H -u 65532 -G runtime -h /data -s /sbin/nologin runtime \
    && mkdir -p /data/adapter /data/codex /data/workspace \
    && chown -R 65532:65532 /data

COPY --from=builder /codex-runtime /usr/local/bin/codex-runtime

USER 65532:65532
# The adapter creates its workspace after the durable /data volume is mounted.
WORKDIR /data
EXPOSE 80 8081

LABEL org.opencontainers.image.source="https://github.com/niravshah2705/symphony"
LABEL org.opencontainers.image.description="AI Fleet Codex App Server native harness runtime"
LABEL org.opencontainers.image.version="${RUNTIME_VERSION}"

ENTRYPOINT ["/usr/local/bin/codex-runtime"]
