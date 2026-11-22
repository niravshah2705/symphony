# Flexprice dashboard UI (github.com/flexprice/flexprice-front), self-hosted.
#
# Build context = the pinned flexprice-front checkout (FLEXPRICE_FRONT_CHECKOUT),
# NOT this directory:
#   docker build -f fleet-local/deploy/uis/flexprice-ui/Dockerfile \
#     -t fleet-flexprice-ui:local "$FLEXPRICE_FRONT_CHECKOUT"
#
# Vite inlines import.meta.env.* at BUILD time — VITE_API_URL cannot be set as a
# container env later, so it is a build ARG (src/config/config.ts:312 defaults to
# http://localhost:8080/v1 when unset).
#
# VITE_APP_ENV must be `self-hosted` or the login form never reaches the backend:
# `LoginForm.handleLogin` branches on `config.app.env !== APP_ENV.SelfHosted` and
# otherwise calls supabase.auth.signInWithPassword, which in a self-hosted build
# is the mock client in src/core/services/supbase/config.ts -> toast
# "Authentication is not configured for this deployment." Unset defaults to
# APP_ENV.Local (config.ts:296), i.e. that branch. AuthService/user loading are
# gated on the same value.
FROM node:22-alpine AS build
ARG VITE_API_URL=http://api.flexprice.local/v1
ARG VITE_APP_ENV=self-hosted
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_APP_ENV=${VITE_APP_ENV}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
# Build stamp, so a stale image (old inlined env) is detectable over HTTP
# instead of only by a failing login: t30 step 2 asserts it.
RUN printf '{"apiUrl":"%s","appEnv":"%s"}\n' "$VITE_API_URL" "$VITE_APP_ENV" > /app/dist/build-info.json

# Upstream's own Dockerfile ends with `npm run start` (vite DEV server) — not what
# we want; serve the built static dist with plain nginx. The server block is in
# here (not COPYed) because the build context is the frontend checkout, where
# this repo's nginx.conf does not exist. SPA fallback to index.html mirrors the
# upstream nginx/nginx.conf, on port 80.
FROM nginx:1.27-alpine
RUN printf 'server {\n    listen 80;\n    root /usr/share/nginx/html;\n    index index.html;\n    location / {\n        try_files $uri $uri/ /index.html;\n    }\n    add_header X-Content-Type-Options "nosniff" always;\n    add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n}\n' > /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
