// API base for the SPA. Empty string = same-origin (local dev, where the gateway
// also serves this file). At GCS deploy time Cloud Build OVERWRITES this file with
// the gateway's public Cloud Run URL, e.g.:
//   window.__API_BASE__ = 'https://gateway-xxxx-uc.a.run.app';
window.__API_BASE__ = '';
