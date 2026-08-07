'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('./localization');
const {
  createLocalizationRouter,
  suggestionsForRequest,
  translationForBody,
} = router;

test('localization router exposes the agreed suggestions and translation routes', () => {
  const created = createLocalizationRouter();
  const routes = created.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.deepEqual(routes, ['GET /suggestions', 'POST /translate']);
});

test('suggestions use browser hints and coarse IP location without returning the address', async () => {
  let lookedUpIp = null;
  const payload = await suggestionsForRequest(
    {
      query: { languages: 'fr-FR,hi-IN;q=0.8' },
      headers: { 'accept-language': 'de-DE;q=0.5' },
      ip: '8.8.8.8',
      socket: {},
    },
    {
      geolocate: async (ip) => {
        lookedUpIp = ip;
        return { countryCode: 'IN', region: 'Gujarat', ip, latitude: 23.2 };
      },
    }
  );
  assert.equal(lookedUpIp, '8.8.8.8');
  assert.equal(payload.locale, 'fr');
  assert.equal(payload.countryCode, 'IN');
  assert.equal(payload.region, 'Gujarat');
  assert.ok(payload.suggestions.length <= 5);
  assert.ok(payload.suggestions.some((item) => item.tag === 'en'));
  assert.ok(payload.suggestions.some((item) => item.tag === 'gu-IN'));
  assert.doesNotMatch(JSON.stringify(payload), /8\.8\.8\.8|latitude/);
});

test('suggestions remain usable when lookup is offline or the request address is private', async () => {
  const offline = await suggestionsForRequest(
    { query: { languages: 'gu' }, headers: {}, ip: '1.1.1.1', socket: {} },
    { geolocate: async () => { throw new Error('offline'); } }
  );
  assert.equal(offline.locale, 'gu-IN');
  assert.equal(offline.countryCode, null);
  assert.equal(offline.region, null);

  let calls = 0;
  const local = await suggestionsForRequest(
    { query: {}, headers: { 'accept-language': 'en-US' }, ip: '127.0.0.1', socket: {} },
    {
      geolocate: async () => { calls += 1; },
      geolocateCurrent: async () => ({ countryCode: 'IN', region: 'Gujarat', ip: 'must-not-leak' }),
    }
  );
  assert.equal(local.locale, 'en');
  assert.equal(calls, 0);
  assert.equal(local.countryCode, 'IN');
  assert.equal(local.region, 'Gujarat');
  assert.doesNotMatch(JSON.stringify(local), /must-not-leak/);
});

test('translation body passes only locale, texts, and server settings to the translator', async () => {
  const settings = { byomProvider: 'ollama', ollamaModel: 'gemma-local' };
  let received = null;
  const payload = await translationForBody(
    { locale: 'gu-IN', texts: ['Agent', 'Settings'], ignored: 'not forwarded' },
    {
      settingsProvider: () => settings,
      translator: async (request) => {
        received = request;
        return {
          locale: 'gu-IN',
          translations: ['એજન્ટ', 'સેટિંગ્સ'],
          provider: 'ollama',
          model: 'gemma-local',
          fallback: false,
        };
      },
    }
  );
  assert.deepEqual(received, { locale: 'gu-IN', texts: ['Agent', 'Settings'], settings });
  assert.deepEqual(payload.translations, ['એજન્ટ', 'સેટિંગ્સ']);
  assert.equal(payload.fallback, false);
});

test('translation route helper rejects a missing JSON object before reading settings', async () => {
  let settingsRead = false;
  await assert.rejects(
    translationForBody(null, { settingsProvider: () => { settingsRead = true; } }),
    (error) => error.status === 400 && /JSON request body/.test(error.message)
  );
  assert.equal(settingsRead, false);
});
