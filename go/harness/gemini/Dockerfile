# Gemini (gemini) native harness runtime image.
# EXPERIMENTAL — published via go/harness/runtime-images.csv; no in-cluster kagent translator yet.
# Build context is the module root:  docker build -f go/harness/gemini/Dockerfile go
#   --build-arg RUNTIME_VERSION=0.68.0
# GEMINI_API_KEY / GOOGLE_API_KEY; Vertex via GOOGLE_GENAI_USE_VERTEXAI + GOOGLE_CLOUD_PROJECT.
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
    go build -trimpath -o /gemini-runtime ./harness/gemini/cmd

FROM node:22-slim
ARG RUNTIME_VERSION=0.68.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @google/gemini-cli@${RUNTIME_VERSION} \
    && groupadd --system -g 65532 runtime \
    && useradd --system --uid 65532 --gid runtime --home-dir /data --shell /usr/sbin/nologin runtime \
    && mkdir -p /data/adapter /data/gemini /data/workspace \
    && chown -R 65532:65532 /data

COPY --from=builder /gemini-runtime /usr/local/bin/gemini-runtime

USER 65532:65532
WORKDIR /data
EXPOSE 80 8081

LABEL org.opencontainers.image.source="https://github.com/niravshah2705/symphony"
LABEL org.opencontainers.image.description="AI Fleet Gemini (gemini) experimental native harness runtime"
LABEL org.opencontainers.image.version="${RUNTIME_VERSION}"

ENTRYPOINT ["/usr/local/bin/gemini-runtime"]
