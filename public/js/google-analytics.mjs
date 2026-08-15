const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]+$/;
const GA4_USER_ID_MAX_LENGTH = 256;
const GA4_USER_ID_FORBIDDEN = /[\s@/?#]/u;
const GTAG_SCRIPT_ID = 'ai-fleet-google-analytics';
const GTAG_SCRIPT_URL = 'https://www.googletagmanager.com/gtag/js';
export const ANALYTICS_CONSENT_KEY = 'ai-fleet.analytics-consent';
const ANALYTICS_ENABLED = 'enabled';
const ANALYTICS_DISABLED = 'disabled';
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
  'privacy',
  'terms',
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

export function normalizeAnalyticsConsent(value) {
  return value === ANALYTICS_ENABLED || value === ANALYTICS_DISABLED ? value : '';
}

function resolveStorage(windowRef, storageRef) {
  if (storageRef !== undefined) return storageRef;
  try {
    return windowRef?.localStorage || null;
  } catch {
    return null;
  }
}

// Analytics is intentionally opt-out on deployments that configure GA4. A
// missing, malformed, or unreadable preference therefore retains the existing
// enabled behavior.
export function getAnalyticsConsent({ windowRef = globalThis.window, storageRef } = {}) {
  const storage = resolveStorage(windowRef, storageRef);
  try {
    return normalizeAnalyticsConsent(storage?.getItem?.(ANALYTICS_CONSENT_KEY)) || ANALYTICS_ENABLED;
  } catch {
    return ANALYTICS_ENABLED;
  }
}

function gaCookieNames(documentRef) {
  let cookieHeader = '';
  try {
    cookieHeader = documentRef?.cookie || '';
  } catch {
    return [];
  }
  return [...new Set(cookieHeader
    .split(';')
    .map((part) => part.trim().split('=', 1)[0])
    .filter((name) => /^_ga(?:$|_[A-Za-z0-9_-]+$)/u.test(name)))];
}

function cookieDomains(locationRef) {
  const hostname = String(locationRef?.hostname || '').trim().toLowerCase();
  if (!hostname || hostname === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return [];
  const parts = hostname.split('.').filter(Boolean);
  const domains = [];
  // Try the current hostname and each registrable-looking parent. Browsers
  // ignore invalid public-suffix attempts, while this clears GA cookies set by
  // either a host-only or parent-domain configuration.
  for (let index = 0; index < parts.length - 1; index += 1) {
    domains.push(parts.slice(index).join('.'));
  }
  return domains;
}

export function expireGoogleAnalyticsCookies({
  documentRef = globalThis.document,
  locationRef = globalThis.location,
} = {}) {
  const names = gaCookieNames(documentRef);
  const expiration = 'Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; SameSite=Lax';
  for (const name of names) {
    const attempts = [
      `${name}=; ${expiration}`,
      ...cookieDomains(locationRef).map((domain) => `${name}=; ${expiration}; Domain=${domain}`),
    ];
    for (const cookie of attempts) {
      try {
        documentRef.cookie = cookie;
      } catch {
        // Continue through the remaining visible cookies/domains. Sandboxed
        // documents may reject writes even though the preference still saves.
      }
    }
  }
  return names;
}

export function setAnalyticsConsent(value, {
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  locationRef = windowRef?.location,
  storageRef,
} = {}) {
  const normalized = normalizeAnalyticsConsent(value);
  if (!normalized) throw new TypeError('Analytics consent must be enabled or disabled.');

  const storage = resolveStorage(windowRef, storageRef);
  if (!storage || typeof storage.setItem !== 'function') {
    throw new Error('Browser storage is unavailable.');
  }
  // Persist first. If this throws, the dialog remains open and no transient
  // consent state is presented as a durable choice.
  storage.setItem(ANALYTICS_CONSENT_KEY, normalized);

  // Do not call ensureGtag here: revoking consent must never create GA globals
  // or download the tag in a browser that started with analytics disabled.
  if (typeof windowRef?.gtag === 'function') {
    windowRef.gtag('consent', 'update', {
      analytics_storage: normalized === ANALYTICS_ENABLED ? 'granted' : 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
  }
  if (normalized === ANALYTICS_DISABLED) {
    expireGoogleAnalyticsCookies({ documentRef, locationRef });
  }
  return normalized;
}

// GA4 permits an operator-defined, non-PII user_id of at most 256 characters.
// AI Fleet supplies only the gateway-verified Firebase subject. Reject common
// PII/URL shapes defensively so a future caller cannot accidentally substitute
// an email address, page URL, token-bearing query, or display label.
export function normalizeGa4UserId(value) {
  if (typeof value !== 'string') return '';
  const userId = value.trim();
  const lowerUserId = userId.toLowerCase();
  if (
    !userId
    || userId.length > GA4_USER_ID_MAX_LENGTH
    || GA4_USER_ID_FORBIDDEN.test(userId)
    || lowerUserId === 'null'
    || lowerUserId === 'undefined'
  ) return '';
  return userId;
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
    states.set(measurementId, {
      initialized: false,
      lastPageLocation: '',
      // undefined means this page has never associated a GA user_id. Once a
      // user signs out, null is retained so later config calls keep it cleared.
      userId: undefined,
    });
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
  storageRef,
  now = () => new Date(),
} = {}) {
  const normalizedMeasurementId = normalizeGa4MeasurementId(measurementId);
  const analyticsAllowed = getAnalyticsConsent({ windowRef, storageRef }) !== ANALYTICS_DISABLED;
  const enabled = Boolean(
    normalizedMeasurementId
    && analyticsAllowed
    && windowRef
    && typeof windowRef === 'object'
    && documentRef?.head
    && typeof documentRef.createElement === 'function'
  );

  if (!enabled) {
    return Object.freeze({ enabled: false, measurementId: '', trackPageView: () => false });
  }

  const state = stateFor(windowRef, normalizedMeasurementId);

  function routeConfig(pageLocation, pageTitle, userId) {
    const config = {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      // GA also attaches these configured defaults to automatically collected
      // events. Keep them canonical so those events cannot recover the browser's
      // real fallback pathname, query string, hash parameters, or document title.
      page_location: pageLocation,
      page_title: pageTitle,
    };
    if (userId) config.user_id = userId;
    else if (state.userId !== undefined) config.user_id = null;
    return config;
  }

  function initialize(pageLocation, pageTitle, userId) {
    if (state.initialized) return true;
    try {
      const gtag = ensureGtag(windowRef);
      gtag('js', now());
      gtag('config', normalizedMeasurementId, routeConfig(pageLocation, pageTitle, userId));
      loadGtagScript(documentRef, normalizedMeasurementId);
      state.initialized = true;
      state.userId = userId || undefined;
      return true;
    } catch {
      return false;
    }
  }

  function trackPageView(route = windowRef.location?.hash, identity = {}) {
    // Consent can change while this tracker remains alive. Suppress every
    // future event immediately; the preferences UI then reloads the same hash
    // so the next startup remains entirely free of GA globals and requests.
    if (getAnalyticsConsent({ windowRef, storageRef }) === ANALYTICS_DISABLED) return false;
    const pageLocation = sanitizedPageLocation(windowRef.location, route);
    const pageTitle = sanitizedPageTitle(route);
    if (!pageLocation) return false;

    const authenticated = identity?.authenticated === true;
    const authenticationStatus = authenticated ? 'authenticated' : 'anonymous';
    const userId = authenticated ? normalizeGa4UserId(identity?.userId) : '';
    const alreadyInitialized = state.initialized;
    if (!initialize(pageLocation, pageTitle, userId)) return false;

    try {
      let identityChanged = false;
      if (alreadyInitialized) {
        const nextUserId = userId || null;
        const mustClearUserId = !userId && state.userId !== undefined && state.userId !== null;
        if ((userId && state.userId !== userId) || mustClearUserId) {
          // Google recommends the global set command when login state changes
          // after initialization; JavaScript null is the only supported logout
          // value. Never use an empty/dummy identifier.
          windowRef.gtag('set', { user_id: nextUserId });
          state.userId = nextUserId;
          identityChanged = true;
        }
      }

      // Identity can change during an in-place auth-expiry rerender. Its GA
      // global context is synchronized above. Refresh this measurement target
      // too because config-scoped values override global set values in gtag.
      // The route itself is still the same view and must not be counted twice.
      const duplicatePageView = pageLocation === state.lastPageLocation;

      // Refresh GA's defaults before the explicit view so later automatic events
      // remain associated with the same canonical virtual route.
      if (alreadyInitialized && (!duplicatePageView || identityChanged)) {
        windowRef.gtag('config', normalizedMeasurementId, routeConfig(pageLocation, pageTitle, userId));
      }
      if (duplicatePageView) return false;

      windowRef.gtag('event', 'page_view', {
        page_location: pageLocation,
        // Derive the title from the same route allowlist as page_location. A
        // future UI title may contain tenant or record context; never forward it.
        page_title: pageTitle,
        authentication_status: authenticationStatus,
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

export function trackGoogleAnalyticsPageView(route, identity) {
  browserAnalytics ||= createGoogleAnalytics();
  return browserAnalytics.trackPageView(route, identity);
}
