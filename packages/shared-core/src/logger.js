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

function write(level, message) {
  const ts = new Date().toISOString();
  const text = `[${ts}] ${level.toUpperCase().padEnd(5)} ${message}`;
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
  info: (message) => write('info', message),
  warn: (message) => write('warn', message),
  error: (message) => write('error', message),
  LOG_FILE: CONFIG.LOG_FILE,
};
