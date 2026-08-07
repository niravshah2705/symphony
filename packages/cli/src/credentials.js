'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * On-disk credential store for the adlc CLI: ~/.adlc/credentials.json.
 *
 * Holds the bearer token used for gateway API calls (a Firebase ID token when
 * the gateway runs in firebase auth mode). The directory is created 0700 and the
 * file 0600 so the token is not group/world-readable; the token is never logged
 * (callers display it via mask()).
 *
 * Firebase ID tokens are SHORT-LIVED (~1h) — this is a convenience cache for a
 * session of CLI use, not a durable credential. Re-run `adlc auth login` when
 * commands start returning 401.
 *
 * $ADLC_HOME overrides the directory (used by tests and for isolation).
 */

function homeDir() {
  return process.env.ADLC_HOME || path.join(os.homedir(), '.adlc');
}

function credentialsPath() {
  return path.join(homeDir(), 'credentials.json');
}

/** Load stored credentials, or null if absent/unreadable/corrupt (never throws). */
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Persist credentials with owner-only permissions (0700 dir, 0600 file). */
function save(creds) {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (_) {
    /* best effort — mkdir mode already applied */
  }
  const file = credentialsPath();
  fs.writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // Enforce 0600 even if the file pre-existed with looser permissions (the write
  // mode only applies on creation).
  fs.chmodSync(file, 0o600);
  return file;
}

/** Remove the credential file. Returns true if a file was deleted. */
function clear() {
  try {
    fs.unlinkSync(credentialsPath());
    return true;
  } catch (_) {
    return false;
  }
}

/** The stored bearer token, or null. */
function storedToken() {
  const creds = load();
  return creds && typeof creds.token === 'string' && creds.token ? creds.token : null;
}

/** Mask a token for display: first 4 + last 4 only, never the middle. */
function mask(token) {
  const t = String(token || '');
  if (!t) return '';
  if (t.length <= 12) return '*'.repeat(t.length);
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

module.exports = { homeDir, credentialsPath, load, save, clear, storedToken, mask };
