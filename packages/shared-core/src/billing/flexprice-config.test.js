'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RESERVED = (k) => k.startsWith('FLEXPRICE_');

/**
 * Re-require the module with a given environment.
 *
 * The snapshot is taken at require time on purpose — that is what stops a caller
 * from mutating config mid-request — so a test of config behavior has to go
 * through the same door.
 */
function loadWith(env = {}) {
  const prior = { ...process.env };
  for (const key of Object.keys(prior)) if (RESERVED(key)) delete process.env[key];
  process.env.NODE_ENV = '';
  Object.assign(process.env, env);
  delete require.cache[require.resolve('./flexprice-config')];
  const mod = require('./flexprice-config');
  for (const key of Object.keys(process.env)) if (RESERVED(key)) delete process.env[key];
  Object.assign(process.env, prior);
  return mod;
}

const VALID = {
  FLEXPRICE_ENABLED: 'true',
  FLEXPRICE_ENVIRONMENT_ID: '00000000-0000-0000-0000-000000000001',
  FLEXPRICE_API_KEY_INGEST: 'fp_ingest_key_aaaaaaaaaaaaaaaa',
  FLEXPRICE_API_KEY_MONEY: 'fp_money_key_bbbbbbbbbbbbbbbb',
  FLEXPRICE_SUPPLIER_STATE_CODE: '27',
};

test('disabled config validates to mode=off with nothing set at all', () => {
  const m = loadWith({});
  assert.equal(m.FLEXPRICE.enabled, false);
  assert.equal(m.FLEXPRICE.baseUrl, 'http://127.0.0.1:18080');
  assert.equal(m.FLEXPRICE.timeoutMs, 5000);
  assert.deepEqual(m.validateForBoot(), { mode: 'off' });
});

test('enabled-but-empty config is refused and names every missing field at once', () => {
  const m = loadWith({ FLEXPRICE_ENABLED: 'true' });
  assert.throws(() => m.validateForBoot(), (err) => {
    const text = String(err.message);
    for (const needle of ['FLEXPRICE_ENVIRONMENT_ID', 'FLEXPRICE_API_KEY_INGEST', 'FLEXPRICE_API_KEY_MONEY', 'FLEXPRICE_SUPPLIER_STATE_CODE']) {
      assert.ok(text.includes(needle), `message should name ${needle}: ${text}`);
    }
    return true;
  });
});

test('a complete local config validates to mode=enforced', () => {
  const m = loadWith(VALID);
  assert.deepEqual(m.validateForBoot(m.FLEXPRICE, new Set()), { mode: 'enforced' });
});

test('the stack config-map key is refused on either plane', () => {
  const m = loadWith(VALID);
  const forbidden = new Set([VALID.FLEXPRICE_API_KEY_MONEY]);
  assert.throws(
    () => m.validateForBoot(m.FLEXPRICE, forbidden),
    /config-map key.*unconfined super_admin/s,
  );
});

test('one key shared by both planes is refused: a split with one key is not a split', () => {
  const m = loadWith({ ...VALID, FLEXPRICE_API_KEY_MONEY: VALID.FLEXPRICE_API_KEY_INGEST });
  assert.throws(() => m.validateForBoot(m.FLEXPRICE, new Set()), /write boundary/);
});

test('a supplier state code outside 01-37 is refused rather than defaulting to IGST everywhere', () => {
  for (const bad of ['99', '7', 'abc', '', '27x']) {
    const m = loadWith({ ...VALID, FLEXPRICE_SUPPLIER_STATE_CODE: bad });
    assert.throws(() => m.validateForBoot(m.FLEXPRICE, new Set()), /SUPPLIER_STATE_CODE/, `expected rejection for ${JSON.stringify(bad)}`);
  }
  const ok = loadWith({ ...VALID, FLEXPRICE_SUPPLIER_STATE_CODE: '01' });
  assert.deepEqual(ok.validateForBoot(ok.FLEXPRICE, new Set()), { mode: 'enforced' });
});

test('insecure defaults are refused outside a local deployment', () => {
  const local = loadWith({ ...VALID, FLEXPRICE_ALLOW_INSECURE_DEFAULTS: 'true' });
  assert.deepEqual(local.validateForBoot(local.FLEXPRICE, new Set()), { mode: 'enforced' });

  const staged = loadWith({ ...VALID, FLEXPRICE_ALLOW_INSECURE_DEFAULTS: 'true', FLEXPRICE_DEPLOYMENT_MODE: 'staging' });
  assert.throws(() => staged.validateForBoot(staged.FLEXPRICE, new Set()), /FLEXPRICE_ALLOW_INSECURE_DEFAULTS/);
});

test('NODE_ENV=production is not a local deployment', () => {
  const prior = { ...process.env };
  for (const key of Object.keys(prior)) if (RESERVED(key)) delete process.env[key];
  Object.assign(process.env, VALID, { NODE_ENV: 'production', FLEXPRICE_ALLOW_INSECURE_DEFAULTS: 'true' });
  delete require.cache[require.resolve('./flexprice-config')];
  const m = require('./flexprice-config');
  for (const key of Object.keys(process.env)) if (RESERVED(key)) delete process.env[key];
  Object.assign(process.env, prior);
  assert.equal(m.isLocalDev(m.FLEXPRICE), false);
  assert.throws(() => m.validateForBoot(m.FLEXPRICE, new Set()), /FLEXPRICE_ALLOW_INSECURE_DEFAULTS/);
});

test('describe() reports which planes exist and never echoes a key', () => {
  const m = loadWith(VALID);
  const line = m.describe(m.FLEXPRICE);
  assert.ok(line.includes('key[ingest]=present'));
  assert.ok(line.includes('envId=00000000…'));
  for (const secret of [VALID.FLEXPRICE_API_KEY_INGEST, VALID.FLEXPRICE_API_KEY_MONEY]) {
    assert.ok(!line.includes(secret), `describe() leaked a key: ${line}`);
  }
});

test('a missing trailing slash is stripped so paths never double up', () => {
  const m = loadWith({ ...VALID, FLEXPRICE_BASE_URL: 'http://127.0.0.1:18080//' });
  assert.equal(m.FLEXPRICE.baseUrl, 'http://127.0.0.1:18080');
});

test('configMapKeyValues reads the compose env file without exposing anything else in it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-cfg-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    'FLEXPRICE_PG_PASSWORD=not-a-key',
    'FLEXPRICE_API_KEY=fp_config_map_key',
    '',
  ].join('\n'));
  const m = loadWith(VALID);
  const keys = m.configMapKeyValues(file);
  assert.ok(keys.has('fp_config_map_key'));
  assert.ok(![...keys].some((k) => k.includes('not-a-key')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a compose env file that does not exist is not an error', () => {
  const m = loadWith(VALID);
  const keys = m.configMapKeyValues(path.join(m.COMPOSE_ENV_FILE, 'nonexistent-parent', '.env'));
  assert.ok(keys instanceof Set);
});

test('Temporal reachability fails on a closed port instead of hanging', async () => {
  const m = loadWith(VALID);
  await assert.rejects(
    m.assertTemporalReachable({ addr: '127.0.0.1:1', timeoutMs: 300 }),
    /Temporal at 127\.0\.0\.1:1 is not reachable/,
  );
  await assert.rejects(m.assertTemporalReachable({ addr: 'nocolon' }), /bad FLEXPRICE_TEMPORAL_ADDR/);
});
