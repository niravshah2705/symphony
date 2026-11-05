'use strict';

/**
 * Four-map alignment gate. A route in EGRESS_ROUTES asks the sidecar for a vault
 * secretKey; if that name is absent from the settings vault allowlist the resolver
 * silently never returns it and the route fails closed at request time. There is no
 * runtime check tying these maps together, so drift only shows up as a live 502.
 * This test parses the Python allowlists straight from source and asserts parity.
 *
 * Deliberately NOT asserted: store.js SECRET_ENV keys ⊆ vault SECRET_KEYS. The local
 * overlay names the Gemini credential `antigravityApiKey` while the vault/managed
 * path names it `geminiApiKey` (both map to GEMINI_API_KEY). That pre-existing split
 * is a naming inconsistency, not a fail-closed bug, and policing it here would block
 * unrelated work.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EGRESS_ROUTES, EGRESS_SECRET_KEYS } = require('./egress');

const REPO = path.resolve(__dirname, '..', '..', '..');

/** Quoted names inside a `NAME: tuple[...] = ( ... )` literal. */
function pyTuple(file, name) {
  const source = fs.readFileSync(path.join(REPO, file), 'utf8');
  const start = source.indexOf(`${name}: `);
  assert.notEqual(start, -1, `${name} not found in ${file}`);
  const from = source.indexOf('(', start);
  const to = source.indexOf('\n)', from);
  const body = source.slice(from, to === -1 ? source.length : to);
  return new Set([...body.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
}

function pyDictKeys(file, name) {
  const source = fs.readFileSync(path.join(REPO, file), 'utf8');
  const start = source.indexOf(`${name} = {`);
  assert.notEqual(start, -1, `${name} not found in ${file}`);
  const to = source.indexOf('\n}', start);
  const body = source.slice(start, to === -1 ? source.length : to);
  return new Set([...body.matchAll(/^\s{4}"([A-Za-z0-9_]+)":/gm)].map((m) => m[1]));
}

function jsMapKeys(file, name) {
  const source = fs.readFileSync(path.join(REPO, file), 'utf8');
  const start = source.indexOf(`const ${name} = Object.freeze({`);
  assert.notEqual(start, -1, `${name} not found in ${file}`);
  const to = source.indexOf('\n});', start);
  const body = source.slice(start, to === -1 ? source.length : to);
  return new Set([...body.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
}

/** Names inside the `not in ( ... )` exclusion literal of a computed tuple. */
function pyNotInList(file, name) {
  const source = fs.readFileSync(path.join(REPO, file), 'utf8');
  const start = source.indexOf(`${name}: `);
  assert.notEqual(start, -1, `${name} not found in ${file}`);
  const from = source.indexOf('not in (', start);
  assert.notEqual(from, -1, `${name} is not a computed exclusion tuple`);
  const to = source.indexOf('\n)', from);
  const body = source.slice(from, to === -1 ? source.length : to);
  return new Set([...body.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
}

const SECRETS_PY = 'services/settings/app/models/secrets.py';
const SERVICE_PY = 'services/settings/app/services/secrets_service.py';
const STORE_JS = 'packages/shared-core/src/store.js';

test('every egress secretKey is allow-listed in the settings vault', () => {
  const vaultKeys = pyTuple(SECRETS_PY, 'SECRET_KEYS');
  for (const key of EGRESS_SECRET_KEYS) {
    assert.ok(vaultKeys.has(key), `egress route asks for "${key}" but ${SECRETS_PY} SECRET_KEYS does not allow-list it`);
  }
});

test('every managed-capable egress key has a settings MANAGED_ENV entry', () => {
  const managed = pyDictKeys(SERVICE_PY, 'MANAGED_ENV');
  const customerOnly = pyTuple(SECRETS_PY, 'CUSTOMER_ONLY_SECRET_KEYS');
  const declared = new Set(
    Object.values(EGRESS_ROUTES)
      .flatMap((r) => [r.secretKey, r.usernameKey])
      .filter(Boolean),
  );
  for (const key of declared) {
    if (customerOnly.has(key)) continue;
    assert.ok(managed.has(key), `"${key}" is not customer-only but has no MANAGED_ENV source`);
  }
});

test('the Langfuse pair is present in all four maps', () => {
  const pairs = ['langfusePublicKey', 'langfuseSecretKey'];
  for (const key of pairs) {
    assert.ok(EGRESS_SECRET_KEYS.includes(key), `${key} missing from EGRESS_SECRET_KEYS`);
    assert.ok(pyTuple(SECRETS_PY, 'SECRET_KEYS').has(key), `${key} missing from vault SECRET_KEYS`);
    assert.ok(pyDictKeys(SERVICE_PY, 'MANAGED_ENV').has(key), `${key} missing from MANAGED_ENV`);
    assert.ok(jsMapKeys(STORE_JS, 'SECRET_ENV').has(key), `${key} missing from store SECRET_ENV`);
  }
  // Platform-managed sink: a browser must not be able to repoint a tenant's traces.
  // BROWSER_WRITABLE_SECRET_KEYS is a COMPUTED tuple, so assert on its exclusion
  // literal (`not in (...)`) — parsing the tuple body would yield that list back.
  const excluded = pyNotInList(SECRETS_PY, 'BROWSER_WRITABLE_SECRET_KEYS');
  for (const key of pairs) {
    assert.ok(excluded.has(key), `${key} must stay out of the browser-writable set`);
  }
});
