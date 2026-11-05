'use strict';

const fs = require('fs');
const { CONFIG } = require('./config');

/**
 * Dead-simple logger: writes timestamped lines to stdout AND appends them to
 * data/app.log so `tail -f data/app.log` shows every step. No external deps.
 */

function ensureDir() {
  if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
}

/**
 * Serialize an optional structured payload onto the log line. Callers pass the
 * provider response or error context as the second argument (e.g. a Cashfree
 * `status` + `data`); dropping it silently makes an upstream rejection
 * unattributable in Cloud Run logs.
 */
function formatMeta(meta) {
  if (meta === undefined || meta === null) return '';
  if (typeof meta === 'string') return ` ${meta}`;
  let redacted;
  try {
    redacted = JSON.stringify(meta, secretsAsMask, 0);
  } catch (_) {
    redacted = String(meta);
  }
  return redacted ? ` ${redacted}` : '';
}

// Never let a credential-shaped field reach a log sink, whatever the caller put
// in the meta object.
const SECRET_KEY_RE = /(secret|apikey|api_key|token|password|passwd|authorization|credential)/i;
function secretsAsMask(key, value) {
  if (typeof value === 'string' && SECRET_KEY_RE.test(key)) return value ? '••••' : value;
  if (Buffer.isBuffer(value)) return '••••';
  return value;
}

function write(level, message, meta) {
  const ts = new Date().toISOString();
  const text = `[${ts}] ${level.toUpperCase().padEnd(5)} ${message}${formatMeta(meta)}`;
  // eslint-disable-next-line no-console
  console.log(text);
  try {
    ensureDir();
    fs.appendFileSync(CONFIG.LOG_FILE, `${text}\n`);
  } catch (_) {
    /* logging must never throw */
  }
  return text;
}

module.exports = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
  LOG_FILE: CONFIG.LOG_FILE,
};
