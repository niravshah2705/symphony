# Multi-stage build for the control-plane BFF image (arm64/amd64 via TARGETARCH).
# Build context is the fleet-local workspace root:
#   docker build -f deploy/bff/Dockerfile -t fleet-bff:local .
# The runtime bundles helm + kubectl (the onboarding machine shells out to them),
# the compiled BFF, the shared package (loaded via Node type stripping), the built
# SPA (served at SPA_ROOT) and the vendored kagent-tenant chart.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/spa/package.json apps/spa/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/control-plane apps/control-plane
COPY apps/spa apps/spa
RUN npm run build -w @fleet-local/control-plane \
 && npm run build -w @fleet-local/spa \
 && npm prune --omit=dev

FROM node:26-slim AS runtime
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://get.helm.sh/helm-v4.3.0-linux-${TARGETARCH}.tar.gz" \
    | tar xz -C /usr/local/bin --strip-components=1 "linux-${TARGETARCH}/helm" \
 && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.37.0/bin/linux/${TARGETARCH}/kubectl" \
 && chmod +x /usr/local/bin/kubectl
WORKDIR /app
COPY --from=build /app /app
# Vendored tenant chart the onboarding machine installs with helm (TENANT_CHART_PATH).
COPY deploy/charts/kagent-tenant /app/deploy/charts/kagent-tenant
ENV NODE_ENV=production \
    SPA_ROOT=/app/apps/spa/dist \
    TENANT_CHART_PATH=/app/deploy/charts/kagent-tenant
EXPOSE 8080
CMD ["node", "apps/control-plane/dist/server.js"]