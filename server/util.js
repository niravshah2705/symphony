'use strict';

/** Wrap an async express handler so rejected promises reach the error handler. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Consistent JSON error responder. */
function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  res.status(status).json({ error: err && err.message ? err.message : 'Server error.' });
}

/** Mask a secret for display — never returns the raw value. */
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

module.exports = { asyncHandler, sendError, maskKey };
