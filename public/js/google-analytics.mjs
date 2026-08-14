const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]+$/;
const GTAG_SCRIPT_ID = 'ai-fleet-google-analytics';
const GTAG_SCRIPT_URL = 'https://www.googletagmanager.com/gtag/js';
const TRACKED_ROUTES = new Set([
  'agent',
  'workflows',
  'agent-jobs',
  'calls',
  'business',
  'projects',
  'board',
  'analytics',
  'cost',
  'troubleshooting',
  'settings',
  'organization',
  'invite',
]);

// Shared state keeps initialization and page-view deduplication stable even if
// more than one caller creates a tracker for the same browser window.
const statesByWindow = new WeakMap();
const scriptedDocuments = new WeakSet();

export function normalizeGa4MeasurementId(value) {
  if (typeof value !== 'string') return '';
  const measurementId = value.trim();
  return GA4_MEASUREMENT_ID.test(measurementId) ? measurementId : '';
}

export function normalizeTopLevelRoute(value) {
  const route = String(value || '')
    .trim()
    .replace(/^#/, '')
    .replace(/^\/+/, '')
    .split(/[/?#]/, 1)[0]
    .toLowerCase();
  return TRACKED_ROUTES.has(route) ? route : '';
}

export function sanitizedPageTitle(route) {
  const topLevelRoute = normalizeTopLevelRoute(route);
  if (!topLevelRoute) return '';
  return topLevelRoute
    .split('-')
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function sanitizedPageLocation(location, route = location?.hash) {
  const topLevelRoute = normalizeTopLevelRoute(route);
  const origin = typeof location?.origin === 'string' ? location.origin : '';
  if (!origin || !topLevelRoute) return '';
  // Firebase's SPA fallback can render index.html for an arbitrary pathname.
  // Build the virtual URL solely from the origin and allowlisted route so that
  // path segments, query strings, and hash parameters can never reach GA.
  return `${origin}/#/${topLevelRoute}`;
}

function stateFor(windowRef, measurementId) {
  let states = statesByWindow.get(windowRef);
  if (!states) {
    states = new Map();
    statesByWindow.set(windowRef, states);
  }
  if (!states.has(measurementId)) {
    states.set(measurementId, { initialized: false, lastPageLocation: '' });
  }
  return states.get(measurementId);
}

function ensureGtag(windowRef) {
  if (!Array.isArray(windowRef.dataLayer)) windowRef.dataLayer = [];
  if (typeof windowRef.gtag !== 'function') {
    function gtag() {
      windowRef.dataLayer.push(arguments);
    }
    windowRef.gtag = gtag;
  }
  return windowRef.gtag;
}

function hasGtagScript(documentRef) {
  if (scriptedDocuments.has(documentRef)) return true;
  if (documentRef.getElementById?.(GTAG_SCRIPT_ID)) return true;
  return Boolean(documentRef.querySelector?.(`script[src^="${GTAG_SCRIPT_URL}"]`));
}

function loadGtagScript(documentRef, measurementId) {
  if (hasGtagScript(documentRef)) {
    scriptedDocuments.add(documentRef);
    return;
  }

  const script = documentRef.createElement('script');
  script.id = GTAG_SCRIPT_ID;
  script.async = true;
  script.src = `${GTAG_SCRIPT_URL}?id=${encodeURIComponent(measurementId)}`;
  scriptedDocuments.add(documentRef);
  try {
    documentRef.head.append(script);
  } catch (error) {
    scriptedDocuments.delete(documentRef);
    throw error;
  }
}

/**
 * Create a small, dependency-injectable GA4 adapter. It remains completely
 * inert unless the browser-provided measurement ID is valid.
 */
export function createGoogleAnalytics({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  measurementId = windowRef?.__GA_MEASUREMENT_ID__,
  now = () => new Date(),
} = {}) {
  const normalizedMeasurementId = normalizeGa4MeasurementId(measurementId);
  const enabled = Boolean(
    normalizedMeasurementId
    && windowRef
    && typeof windowRef === 'object'
    && documentRef?.head
    && typeof documentRef.createElement === 'function'
  );

  if (!enabled) {
    return Object.freeze({ enabled: false, measurementId: '', trackPageView: () => false });
  }

  const state = stateFor(windowRef, normalizedMeasurementId);

  function routeConfig(pageLocation, pageTitle) {
    return {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      // GA also attaches these configured defaults to automatically collected
      // events. Keep them canonical so those events cannot recover the browser's
      // real fallback pathname, query string, hash parameters, or document title.
      page_location: pageLocation,
      page_title: pageTitle,
    };
  }

  function initialize(pageLocation, pageTitle) {
    if (state.initialized) return true;
    try {
      const gtag = ensureGtag(windowRef);
      gtag('js', now());
      gtag('config', normalizedMeasurementId, routeConfig(pageLocation, pageTitle));
      loadGtagScript(documentRef, normalizedMeasurementId);
      state.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  function trackPageView(route = windowRef.location?.hash) {
    const pageLocation = sanitizedPageLocation(windowRef.location, route);
    const pageTitle = sanitizedPageTitle(route);
    if (!pageLocation || pageLocation === state.lastPageLocation) return false;
    const alreadyInitialized = state.initialized;
    if (!initialize(pageLocation, pageTitle)) return false;

    try {
      // Refresh GA's defaults before the explicit view so later automatic events
      // remain associated with the same canonical virtual route.
      if (alreadyInitialized) {
        windowRef.gtag('config', normalizedMeasurementId, routeConfig(pageLocation, pageTitle));
      }
      windowRef.gtag('event', 'page_view', {
        page_location: pageLocation,
        // Derive the title from the same route allowlist as page_location. A
        // future UI title may contain tenant or record context; never forward it.
        page_title: pageTitle,
        send_to: normalizedMeasurementId,
      });
      state.lastPageLocation = pageLocation;
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    enabled: true,
    measurementId: normalizedMeasurementId,
    trackPageView,
  });
}

let browserAnalytics;

export function trackGoogleAnalyticsPageView(route) {
  browserAnalytics ||= createGoogleAnalytics();
  return browserAnalytics.trackPageView(route);
}
