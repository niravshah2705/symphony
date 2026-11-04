// Configurable expiry for a share: the creator picks one of four presets and
// the Firestore rules refuse any read after that deadline (and refuse creates
// whose deadline is more than the maximum away).

export var EXPIRY_OPTIONS = [
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '48h', label: '48 hours', ms: 2 * 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
];

export var DEFAULT_EXPIRY = '24h';

export function expiryMs(id) {
  for (var i = 0; i < EXPIRY_OPTIONS.length; i += 1) {
    if (EXPIRY_OPTIONS[i].id === id) return EXPIRY_OPTIONS[i].ms;
  }
  throw new Error('unknown expiry option: ' + id);
}

export function expiresAtDate(id, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  return new Date(now + expiryMs(id));
}

export function isExpired(expiresAtMs, nowMs) {
  return (nowMs === undefined ? Date.now() : nowMs) >= expiresAtMs;
}
