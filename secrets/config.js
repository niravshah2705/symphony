// Non-secret bootstrap for the secrets site. The CD pipeline
// (.github/workflows/deploy-secrets.yml) overwrites this file at deploy time
// with the gateway origin (same pattern as public/adlc/config.js) — the
// Firebase web config itself is fetched at runtime from
// `${apiBase}/api/auth/config`, so a stack move needs no edit here.
// The empty placeholder keeps a source checkout inert: app.mjs refuses to
// boot until a real apiBase is present.
window.__SECRETS_CONFIG__ = {
  apiBase: ''
};

