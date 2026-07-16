'use strict';

const express = require('express');
const { getSettings } = require('@ai-fleet/shared/store');
const { asyncHandler } = require('@ai-fleet/shared/util');
const {
  parseLanguageHints,
  normalizeGeoResult,
  languageSuggestions,
  requestIp,
  isPublicIp,
  locateIp,
  locateCurrentIp,
  translateTexts,
  LocalizationError,
} = require('@ai-fleet/shared/agent/localization');

function queryLanguages(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

/** Build the privacy-filtered GET /suggestions payload without requiring Express in tests. */
async function suggestionsForRequest(req, { geolocate = locateIp, geolocateCurrent = locateCurrentIp } = {}) {
  const browserLanguages = parseLanguageHints(
    queryLanguages(req && req.query && req.query.languages),
    req && req.headers && req.headers['accept-language']
  );
  const ip = requestIp(req);
  let location = null;
  if (ip && isPublicIp(ip)) {
    try {
      // The address is used transiently for lookup only. normalizeGeoResult
      // allowlists countryCode/region and prevents any provider echo from
      // reaching the browser.
      location = normalizeGeoResult(await geolocate(ip));
    } catch (_) {
      location = null;
    }
  } else {
    try {
      // On localhost the browser address is loopback, so use the server's
      // public egress location. Only the allowlisted country/region are kept.
      location = normalizeGeoResult(await geolocateCurrent());
    } catch (_) {
      location = null;
    }
  }
  return languageSuggestions({
    browserLanguages,
    countryCode: location && location.countryCode,
    region: location && location.region,
  });
}

async function translationForBody(
  body,
  { settingsProvider = getSettings, translator = translateTexts } = {}
) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LocalizationError('A JSON request body is required.');
  }
  return translator({
    locale: body.locale,
    texts: body.texts,
    settings: settingsProvider(),
  });
}

function createLocalizationRouter(options = {}) {
  const router = express.Router();

  // GET /api/locale/suggestions?languages=gu-IN,en-US
  router.get('/suggestions', asyncHandler(async (req, res) => {
    res.json(await suggestionsForRequest(req, options));
  }));

  // POST /api/locale/translate { locale: "gu-IN", texts: ["Agent", "Settings"] }
  router.post('/translate', asyncHandler(async (req, res) => {
    res.json(await translationForBody(req.body, options));
  }));

  return router;
}

const router = createLocalizationRouter();

module.exports = router;
module.exports.createLocalizationRouter = createLocalizationRouter;
module.exports.suggestionsForRequest = suggestionsForRequest;
module.exports.translationForBody = translationForBody;
