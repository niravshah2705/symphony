// Public runtime configuration for the SPA. Empty API base = same-origin (local
// dev, where the gateway also serves this file). An empty GA4 measurement ID
// disables Google Analytics, which keeps local development and tests offline.
// Deployment pipelines OVERWRITE this file with their public values, e.g.:
//   window.__API_BASE__ = 'https://gateway-xxxx-uc.a.run.app';
//   window.__GA_MEASUREMENT_ID__ = 'G-XXXXXXXXXX';
// This is the SHARED gateway (the bootstrap origin). After sign-in the SPA may
// re-point the base at a per-org PROVISIONED gateway resolved at runtime via
// GET /api/config (auth.js → setApiBase). The per-org URL is NOT baked here — it
// is derived per session, so this file stays the shared bootstrap value.
window.__API_BASE__ = '';
window.__GA_MEASUREMENT_ID__ = '';
