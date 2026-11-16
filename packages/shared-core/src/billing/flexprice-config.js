'use strict';

// The only place in the tree that reads `FLEXPRICE_*` out of the environment.
//
// Every other module takes FlexPrice settings from the frozen snapshot exported
// here, which is what makes the boot assertions below un-bypassable: a module
// that reads `process.env` itself can be handed a value that never passed a
// check, and a money path cannot tolerate a config validated in one place and
// enforced in another. Same reason `money-wire.js` is the only paise↔decimal
// rule.
//
// Importing this module performs no I/O and cannot throw. `npm start` must boot
// with every `FLEXPRICE_*` unset (see scripts/start-all.js), so the checks live
// in `validateForBoot()`, which the billing service calls explicitly at startup.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_BASE_URL = 'http://127.0.0.1:18080';
const DEFAULT_TIMEOUT_MS = 5000;

// FlexPrice's Temporal frontend, published to loopback by deploy/flexprice/
// compose.yaml. Not the API's port: Temporal reachability is a separate question
// from API reachability, and the credit-expiry workflow fails on the second one
// while every REST call keeps returning 200.
const DEFAULT_TEMPORAL_ADDR = '127.0.0.1:17233';

// The compose stack's own env file, where the bootstrap script writes the
// config-map key. Four levels up from packages/shared-core/src/billing.
const COMPOSE_ENV_FILE = path.join(__dirname, '..', '..', '..', '..', 'deploy', 'flexprice', '.env');

// A GSTIN state code is 01-37; the supplier's registered state is the same domain
// and `gst.resolvePlaceOfSupply` compares against it as a 2-char string.
const STATE_CODE_RE = /^([0-9]{2})$/;

const read = (name, fallback = '') => String(process.env[name] === undefined ? fallback : process.env[name]).trim();
const flag = (name) => read(name).toLowerCase() === 'true';
const positiveInt = (name, fallback) => {
  const n = Number(read(name, ''));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Snapshot of the FlexPrice configuration. Read-only, produced at require time.
 *
 * `keys` is deliberately nested and never spread into a log line: the two planes
 * are the write boundary measured in docs/FLEXPRICE_FINDINGS.md §7, and a key
 * that appears in a stack trace appears in whatever collects traces.
 */
const FLEXPRICE = Object.freeze({
  enabled: flag('FLEXPRICE_ENABLED'),
  baseUrl: (read('FLEXPRICE_BASE_URL', DEFAULT_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  environmentId: read('FLEXPRICE_ENVIRONMENT_ID'),
  keys: Object.freeze({
    ingest: read('FLEXPRICE_API_KEY_INGEST'),
    money: read('FLEXPRICE_API_KEY_MONEY'),
  }),
  timeoutMs: positiveInt('FLEXPRICE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  supplierStateCode: read('FLEXPRICE_SUPPLIER_STATE_CODE'),
  temporalAddr: read('FLEXPRICE_TEMPORAL_ADDR', DEFAULT_TEMPORAL_ADDR) || DEFAULT_TEMPORAL_ADDR,
  // The upstream compose ships this as true, which bypasses FlexPrice's own boot
  // checks — including the one that rejects the public development key. Ours is a
  // statement about our config, not theirs: when it is set we are trusting a key
  // nobody minted, so it is only acceptable where the stack is already loopback.
  allowInsecureDefaults: flag('FLEXPRICE_ALLOW_INSECURE_DEFAULTS'),
  deploymentMode: read('FLEXPRICE_DEPLOYMENT_MODE', 'local'),
  isProduction: read('NODE_ENV').toLowerCase() === 'production',
});

/**
 * The raw values present in the stack's config-map key, if any.
 *
 * A config-map key (`FLEXPRICE_AUTH_API_KEY_KEYS`) authenticates as the hardcoded
 * super_admin in the JSON map and cannot be confined to a plane, so using one for
 * either client plane defeats the split. Shape cannot tell the two kinds apart —
 * the `fp_` prefix in `.env.example` is a string we chose, not a FlexPrice format,
 * and a DB-minted key looks the same — so the comparison is by value.
 */
function configMapKeyValues(envFile = COMPOSE_ENV_FILE) {
  const found = new Set();
  if (process.env.FLEXPRICE_API_KEY) found.add(String(process.env.FLEXPRICE_API_KEY).trim());
  let text = '';
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch {
    // No compose checkout (any deployed container, or a fresh clone) is the normal
    // case; the environment-variable comparison above still applies.
    return found;
  }
  for (const line of text.split('\n')) {
    const m = /^FLEXPRICE_API_KEY=(.*)$/.exec(line.trim());
    if (m && m[1].trim()) found.add(m[1].trim());
  }
  return found;
}

/**
 * Refuse a configuration that cannot bill correctly, before it can charge anyone.
 *
 * Returns `{ mode }` — `'off'` when disabled, so a disabled deployment logs the
 * same line it always did and nothing about the money path changes. Throws when
 * enabled-but-incomplete: every field here is one that a wrong value would make
 * a silently mis-stated invoice, not an error.
 */
function validateForBoot(snapshot = FLEXPRICE, forbiddenKeys = configMapKeyValues()) {
  if (!snapshot.enabled) return { mode: 'off' };

  const problems = [];
  if (!snapshot.environmentId) {
    // X-Environment-ID is mandatory on every data route; a valid key without it
    // gets 403, which reads as "the key is wrong" and sends the operator to
    // rotate a working secret.
    problems.push('FLEXPRICE_ENVIRONMENT_ID is required (every data route needs X-Environment-ID)');
  }
  for (const plane of ['ingest', 'money']) {
    const value = snapshot.keys[plane];
    if (!value) {
      problems.push(`FLEXPRICE_API_KEY_${plane.toUpperCase()} is required; run scripts/flexprice-provision.js to mint the two plane keys`);
    } else if (forbiddenKeys.has(value)) {
      problems.push(`FLEXPRICE_API_KEY_${plane.toUpperCase()} is the stack's config-map key, which authenticates as unconfined super_admin; use a DB-minted key per plane`);
    }
  }
  if (snapshot.keys.ingest && snapshot.keys.ingest === snapshot.keys.money) {
    problems.push('the ingest and money planes share one key; the split is a write boundary, so one key for both is no split');
  }
  if (!/^https?:\/\//.test(snapshot.baseUrl)) {
    problems.push(`FLEXPRICE_BASE_URL must be an http(s) origin, got ${JSON.stringify(snapshot.baseUrl)}`);
  }
  const state = STATE_CODE_RE.exec(snapshot.supplierStateCode);
  if (!state || Number(state[1]) < 1 || Number(state[1]) > 37) {
    // With no supplier state every place of supply differs from '' padded to '00',
    // so each invoice silently becomes IGST for an intra-state customer. A wrong
    // tax split is a filing error, so this fails closed.
    problems.push('FLEXPRICE_SUPPLIER_STATE_CODE must be a 2-digit GST state code (01-37); without it place of supply defaults wrong');
  }
  if (snapshot.allowInsecureDefaults && !isLocalDev(snapshot)) {
    problems.push('FLEXPRICE_ALLOW_INSECURE_DEFAULTS=true is refused outside a local deployment');
  }

  if (problems.length) {
    throw new Error(`flexprice-config: refusing to start with an unusable billing config:\n  - ${problems.join('\n  - ')}`);
  }
  return { mode: 'enforced' };
}

function isLocalDev(snapshot = FLEXPRICE) {
  if (snapshot.deploymentMode && snapshot.deploymentMode !== 'local') return false;
  if (snapshot.isProduction) return false;
  return true;
}

/** One line for the boot log: which plane is present, never what it is. */
function describe(snapshot = FLEXPRICE) {
  const has = (v) => (v ? 'present' : 'MISSING');
  return [
    `flexprice enabled=${snapshot.enabled}`,
    `baseUrl=${snapshot.baseUrl}`,
    `envId=${snapshot.environmentId ? `${snapshot.environmentId.slice(0, 8)}…` : 'MISSING'}`,
    `key[ingest]=${has(snapshot.keys.ingest)}`,
    `key[money]=${has(snapshot.keys.money)}`,
    `timeoutMs=${snapshot.timeoutMs}`,
    `supplierState=${snapshot.supplierStateCode || 'MISSING'}`,
    `deploymentMode=${snapshot.deploymentMode}`,
  ].join(' ');
}

/**
 * Assert the workflow engine behind credit expiry is reachable.
 *
 * FlexPrice's `WalletCreditExpiryWorkflow` runs on Temporal, and a stack whose
 * Temporal is down still serves every REST call correctly: the expiry simply
 * never happens, so a promo credit that should have lapsed stays spendable. That
 * is invisible from the API, which is why the check is a socket and not a request.
 */
function assertTemporalReachable({ addr = FLEXPRICE.temporalAddr, timeoutMs = 2000 } = {}) {
  const idx = addr.lastIndexOf(':');
  if (idx < 1) return Promise.reject(new Error(`flexprice-config: bad FLEXPRICE_TEMPORAL_ADDR ${JSON.stringify(addr)}`));
  const host = addr.slice(0, idx);
  const port = Number(addr.slice(idx + 1));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (why) => {
      socket.destroy();
      reject(new Error(`flexprice-config: Temporal at ${addr} is not reachable (${why}); promo credit expiry will not run`));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { socket.destroy(); resolve(addr); });
    socket.once('timeout', () => fail(`no connect within ${timeoutMs}ms`));
    socket.once('error', (e) => fail(e.code || e.message));
  });
}

module.exports = {
  FLEXPRICE,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TEMPORAL_ADDR,
  COMPOSE_ENV_FILE,
  configMapKeyValues,
  validateForBoot,
  isLocalDev,
  describe,
  assertTemporalReachable,
};
