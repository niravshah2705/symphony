'use strict';

const fs = require('fs');

/**
 * Local JSON-file store backend (the historical implementation). The whole
 * store lives in a single file; every read re-parses it and every write
 * rewrites it. This is the default for local development (`STORE_BACKEND=file`)
 * and requires no cloud dependencies.
 *
 * Schema knowledge (defaults, migrations) stays in store.js and is injected via
 * `normalize(parsed)` and `seed()` so this module is a thin, generic backend.
 *
 * @param {object} opts
 * @param {string} opts.file      absolute path to the JSON store file
 * @param {string} opts.dataDir   directory that must exist before writing
 * @param {(parsed: object) => object} opts.normalize  merge/migrate a parsed store
 * @param {() => object} opts.seed  a fresh default store
 * @returns {{ read: () => object, write: (store: object) => object, init: () => Promise<void> }}
 */
function create({ file, dataDir, normalize, seed }) {
  function ensureDataDir() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  }

  function write(store) {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
    return store;
  }

  function read() {
    ensureDataDir();
    if (!fs.existsSync(file)) {
      const fresh = seed();
      write(fresh);
      return fresh;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return normalize(parsed);
    } catch (_) {
      return seed();
    }
  }

  // Nothing to hydrate for the file backend.
  async function init() {}

  return { read, write, init };
}

module.exports = { create };
