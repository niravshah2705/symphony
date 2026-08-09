// API base for the SPA. Empty string = same-origin (local dev, where the gateway
// also serves this file). At GCS deploy time Cloud Build OVERWRITES this file with
// the gateway's public Cloud Run URL, e.g.:
//   window.__API_BASE__ = 'https://gateway-xxxx-uc.a.run.app';
// This is the SHARED gateway (the bootstrap origin). After sign-in the SPA may
// re-point the base at a per-org PROVISIONED gateway resolved at runtime via
// GET /api/config (auth.js → setApiBase). The per-org URL is NOT baked here — it
// is derived per session, so this file stays the shared bootstrap value.
window.__API_BASE__ = '';
