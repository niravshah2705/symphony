'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LANGUAGE_CATALOG,
  LIMITS,
  LocalizationError,
  TranslationCache,
  normalizeLocaleTag,
  supportedLocale,
  parseLanguageHints,
  languageSuggestions,
  normalizeIp,
  isPublicIp,
  locateIp,
  locateCurrentIp,
  clearCurrentLocationCache,
  normalizeTranslationRequest,
  protectText,
  normalizeTranslationModel,
  translationPrompt,
  translateTexts,
} = require('./localization');

test('locale tags are canonical BCP 47 values resolved against a small catalog', () => {
  assert.equal(normalizeLocaleTag(' gu_in '), 'gu-IN');
  assert.equal(normalizeLocaleTag('EN-us'), 'en-US');
  assert.equal(normalizeLocaleTag('not a locale'), null);
  assert.equal(supportedLocale('gu-Gujr-IN'), 'gu-IN');
  assert.equal(supportedLocale('en-IN'), 'en');
  assert.equal(supportedLocale('it-IT'), null);
  assert.ok(LANGUAGE_CATALOG.length < 12);
  assert.deepEqual(LANGUAGE_CATALOG.find((item) => item.tag === 'gu-IN'), {
    tag: 'gu-IN',
    label: 'Gujarati',
    nativeLabel: 'ગુજરાતી',
    direction: 'ltr',
  });
});

test('language hints honor quality, canonicalize, deduplicate, and ignore unsupported tags', () => {
  assert.deepEqual(
    parseLanguageHints('de-DE;q=0.3, gu_IN;q=1, fr-FR;q=0.8, gu;q=0.5, it-IT'),
    ['gu-IN', 'fr', 'de']
  );
  assert.deepEqual(parseLanguageHints('*;q=1, en;q=0, ja-JP'), ['ja-JP']);
  assert.deepEqual(parseLanguageHints('fr;q=bogus, de;q=1.0000, en'), ['en']);
  assert.ok(parseLanguageHints(Array.from({ length: 30 }, (_, index) => `en-${index}`)).length <= LIMITS.languageHints);
});

test('suggestions are ranked by browser and location but always keep English and Gujarati', () => {
  const result = languageSuggestions({
    browserLanguages: ['fr-FR', 'de-DE', 'ja-JP', 'ar'],
    countryCode: 'IN',
    region: ' Gujarat\n',
  });
  assert.equal(result.locale, 'fr');
  assert.equal(result.countryCode, 'IN');
  assert.equal(result.region, 'Gujarat');
  assert.ok(result.suggestions.length <= 5);
  assert.ok(result.suggestions.some((item) => item.tag === 'en'));
  assert.ok(result.suggestions.some((item) => item.tag === 'gu-IN'));
  assert.equal(result.suggestions[0].reason, 'browser');
});

test('IP handling accepts public addresses and rejects local or reserved addresses', () => {
  assert.equal(normalizeIp('::ffff:8.8.8.8'), '8.8.8.8');
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('10.1.2.3'), false);
  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('192.168.2.2'), false);
  assert.equal(isPublicIp('203.0.113.8'), false);
  assert.equal(isPublicIp('::1'), false);
  assert.equal(isPublicIp('2001:db8::1'), false);
});

test('IP geolocation returns only a bounded country/region and fails closed offline', async () => {
  const requested = [];
  const location = await locateIp('8.8.8.8', {
    fetchImpl: async (url) => {
      requested.push(url);
      return {
        ok: true,
        json: async () => ({ success: true, country_code: 'us', region: ' California\n', ip: '8.8.8.8' }),
      };
    },
  });
  assert.deepEqual(location, { countryCode: 'US', region: 'California' });
  assert.equal(Object.hasOwn(location, 'ip'), false);
  assert.equal(requested.length, 1);
  assert.equal(await locateIp('127.0.0.1', { fetchImpl: async () => assert.fail('must not fetch') }), null);
  assert.equal(await locateIp('8.8.4.4', { fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('localhost geolocation uses public egress lookup without returning an address', async () => {
  clearCurrentLocationCache();
  let requested = '';
  const location = await locateCurrentIp({
    fetchImpl: async (url) => {
      requested = url;
      return {
        ok: true,
        json: async () => ({ success: true, country_code: 'in', region: 'Gujarat', ip: '198.51.100.2' }),
      };
    },
  });
  assert.equal(requested, 'https://ipwho.is/?fields=success,country_code,region');
  assert.deepEqual(location, { countryCode: 'IN', region: 'Gujarat' });
  assert.equal(Object.hasOwn(location, 'ip'), false);
  clearCurrentLocationCache();
});

test('translation request bounds string count, item size, and total size', () => {
  assert.deepEqual(normalizeTranslationRequest('gu', ['Agent', 'Settings']), {
    locale: 'gu-IN',
    texts: ['Agent', 'Settings'],
  });
  assert.throws(() => normalizeTranslationRequest('it', ['Agent']), LocalizationError);
  assert.throws(() => normalizeTranslationRequest('gu-IN', 'Agent'), /array of strings/);
  assert.throws(() => normalizeTranslationRequest('gu-IN', [42]), /texts\[0\]/);
  assert.throws(
    () => normalizeTranslationRequest('gu-IN', ['x'.repeat(LIMITS.textChars + 1)]),
    /2,500 characters or fewer/
  );
});

test('translation protection preserves placeholders, URLs, HTML, printf values, and code byte-for-byte', () => {
  const source = 'Open {project} at https://example.com/a?q=1, run `npm test`, then show <b>%1$s</b>.';
  const protection = protectText(source);
  assert.doesNotMatch(protection.protectedText, /example\.com|npm test|\{project\}|<b>|%1\$s/);
  const modelText = `ખોલો ${protection.tokens.map((entry) => entry.token).join(' અને ')}.`;
  const [restored] = normalizeTranslationModel({ translations: [modelText] }, [protection]);
  for (const protectedValue of ['{project}', 'https://example.com/a?q=1,', '`npm test`', '<b>', '%1$s', '</b>']) {
    assert.ok(restored.includes(protectedValue));
  }
  assert.throws(
    () => normalizeTranslationModel({ translations: [modelText.replace(protection.tokens[0].token, 'બદલ્યું')] }, [protection]),
    /protected content/
  );
  assert.throws(
    () => normalizeTranslationModel(
      { translations: ['__AI_FLEET_L10N_The repository needs attention.__'] },
      [protectText('The repository needs attention.')]
    ),
    /unknown protected token/
  );
});

test('Gujarati prompt explicitly requests all UI and internal-status communication', () => {
  const prompt = translationPrompt('gu-IN', [protectText('Agent started')]);
  assert.match(prompt, /Gujarati \(ગુજરાતી\), locale gu-IN/);
  assert.match(prompt, /including internal status messages/);
  assert.match(prompt, /untrusted_ui_strings/);
  assert.doesNotMatch(prompt, /beginning __AI_FLEET_L10N_/);

  const protectedPrompt = translationPrompt('gu-IN', [protectText('Open {project}')]);
  assert.match(protectedPrompt, /Only copy tokens already present/);
});

test('translation uses exact deterministic source fallback when local inference is unavailable', async () => {
  const input = ['Agent started', 'Open {project}'];
  const result = await translateTexts(
    {
      locale: 'gu-IN',
      texts: input,
      settings: { byomProvider: 'ollama', ollamaModel: 'local-model' },
    },
    { resolveLocal: async () => { throw new Error('offline'); }, cache: null }
  );
  assert.deepEqual(result.translations, input);
  assert.equal(result.provider, 'ollama');
  assert.equal(result.model, 'local-model');
  assert.equal(result.fallback, true);
});

test('successful local translations are cached by model, locale, and input without raw cache keys', async () => {
  const cache = new TranslationCache({ maxEntries: 2, ttlMs: 60_000 });
  let calls = 0;
  const deps = {
    cache,
    resolveLocal: async () => ({ provider: 'ollama', model: 'gemma-local', host: 'http://localhost' }),
    runStructured: async ({ normalize }) => {
      calls += 1;
      return {
        value: normalize({ translations: ['એજન્ટ', 'સેટિંગ્સ'] }),
        usedFallback: false,
      };
    },
  };
  const request = {
    locale: 'gu-IN',
    texts: ['Agent', 'Settings'],
    settings: { byomProvider: 'ollama', ollamaModel: 'gemma-local' },
  };
  const first = await translateTexts(request, deps);
  const second = await translateTexts(request, deps);
  assert.deepEqual(first.translations, ['એજન્ટ', 'સેટિંગ્સ']);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.fallback, false);
  assert.equal(calls, 1);
  assert.equal([...cache.entries.keys()].some((key) => key.includes('Agent')), false);
});

test('English identity translation does not invoke a model', async () => {
  const result = await translateTexts(
    { locale: 'en-US', texts: ['Agent'], settings: {} },
    { resolveLocal: async () => assert.fail('must not resolve a model'), cache: null }
  );
  assert.deepEqual(result, {
    locale: 'en',
    translations: ['Agent'],
    provider: null,
    model: null,
    fallback: false,
    cached: false,
  });
});
