# Claude Code native harness runtime image (ported from kagent go/harness/claude).
# Build context is the module root:  docker build -f go/harness/claude/Dockerfile go
# Override the pinned release via build args (driven by go/harness/runtime-images.csv):
#   --build-arg RUNTIME_VERSION=2.1.285 \
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
    go build -trimpath -o /claude-runtime ./harness/claude/cmd

FROM alpine:${ALPINE_VERSION}
ARG RUNTIME_VERSION=2.1.285
ARG AMD64_SHA256=7b4414af1bc06eb6d91730759bd01c4c02a4976d0b8526237e9a6d8c33eaf102
ARG ARM64_SHA256=31efc4136bc678575f4c6730e248d34f89dbfea0468be1c5d012af199cd62ee8
ARG TARGETARCH

ENV USE_BUILTIN_RIPGREP=0
ENV CLAUDE_CODE_VERSION=${RUNTIME_VERSION}
RUN apk upgrade --no-cache && apk add --no-cache bash ca-certificates git libgcc libstdc++ ripgrep \
    && case "${TARGETARCH}" in \
        amd64) platform="linux-x64-musl"; checksum="${AMD64_SHA256}" ;; \
        arm64) platform="linux-arm64-musl"; checksum="${ARM64_SHA256}" ;; \
        *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -T 60 -t 3 -O /usr/local/bin/claude \
        "https://downloads.claude.ai/claude-code-releases/${RUNTIME_VERSION}/${platform}/claude" \
    && if [ -n "${checksum}" ]; then \
         echo "${checksum}  /usr/local/bin/claude" | sha256sum -c -; \
       else \
         echo "WARNING: no AMD64/ARM64_SHA256 pinned for ${RUNTIME_VERSION}; skipping integrity check" >&2; \
       fi \
    && chmod 0755 /usr/local/bin/claude \
    && addgroup -S -g 65532 runtime \
    && adduser -S -D -H -u 65532 -G runtime -h /data -s /sbin/nologin runtime \
    && mkdir -p /data/adapter /data/claude /data/generated /data/workspace \
    && chown -R 65532:65532 /data

COPY --from=builder /claude-runtime /usr/local/bin/claude-runtime

USER 65532:65532
# The adapter creates its workspace after the durable /data volume is mounted.
WORKDIR /data
EXPOSE 80 8081

LABEL org.opencontainers.image.source="https://github.com/niravshah2705/symphony"
LABEL org.opencontainers.image.description="Software Factory Claude Code native harness runtime"
LABEL org.opencontainers.image.version="${RUNTIME_VERSION}"

ENTRYPOINT ["/usr/local/bin/claude-runtime"]
