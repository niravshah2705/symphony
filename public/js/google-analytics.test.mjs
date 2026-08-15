import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYTICS_CONSENT_KEY,
  createGoogleAnalytics,
  getAnalyticsConsent,
  normalizeGa4MeasurementId,
  normalizeGa4UserId,
  normalizeAnalyticsConsent,
  normalizeTopLevelRoute,
  sanitizedPageLocation,
  sanitizedPageTitle,
  setAnalyticsConsent,
} from './google-analytics.mjs';

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    value: (key) => values.get(key),
  };
}

function fakeBrowser({
  measurementId = 'G-ABC123',
  hash = '#/agent',
  title = 'Agent | AI Fleet',
} = {}) {
  const scripts = [];
  const documentRef = {
    title,
    head: { append: (node) => scripts.push(node) },
    createElement: (tagName) => ({ tagName }),
    getElementById: (id) => scripts.find((script) => script.id === id) || null,
    querySelector: () => null,
  };
  const windowRef = {
    __GA_MEASUREMENT_ID__: measurementId,
    location: {
      origin: 'https://fleet.example',
      hostname: 'fleet.example',
      pathname: '/private-customer/private-record',
      search: '?email=private-user@example.com',
      hash,
    },
  };
  return { documentRef, scripts, windowRef };
}

function callsOf(windowRef, command) {
  return windowRef.dataLayer
    .filter((args) => args[0] === command)
    .map((args) => Array.from(args));
}

test('accepts only normalized GA4 measurement IDs', () => {
  assert.equal(normalizeGa4MeasurementId('G-ABC123'), 'G-ABC123');
  assert.equal(normalizeGa4MeasurementId(' G-9Z '), 'G-9Z');
  for (const value of ['', 'G-', 'g-ABC123', 'UA-123-1', 'G-ABC_123', null, undefined]) {
    assert.equal(normalizeGa4MeasurementId(value), '');
  }
});

test('normalizes the two persisted analytics choices and defaults invalid data to enabled', () => {
  assert.equal(normalizeAnalyticsConsent('enabled'), 'enabled');
  assert.equal(normalizeAnalyticsConsent('disabled'), 'disabled');
  for (const value of ['', ' disabled ', 'DISABLED', null, undefined, false]) {
    assert.equal(normalizeAnalyticsConsent(value), '');
  }

  assert.equal(getAnalyticsConsent({ storageRef: memoryStorage() }), 'enabled');
  assert.equal(getAnalyticsConsent({
    storageRef: memoryStorage({ [ANALYTICS_CONSENT_KEY]: 'corrupt' }),
  }), 'enabled');
  assert.equal(getAnalyticsConsent({
    storageRef: { getItem: () => { throw new Error('blocked'); } },
  }), 'enabled');
  assert.equal(getAnalyticsConsent({
    storageRef: memoryStorage({ [ANALYTICS_CONSENT_KEY]: 'disabled' }),
  }), 'disabled');
});

test('accepts only bounded opaque GA4 user IDs', () => {
  assert.equal(normalizeGa4UserId('firebase|ada'), 'firebase|ada');
  assert.equal(normalizeGa4UserId(' subject-123 '), 'subject-123');
  assert.equal(normalizeGa4UserId('x'.repeat(256)), 'x'.repeat(256));
  for (const value of [
    '',
    'null',
    'undefined',
    'private-user@example.com',
    'https://identity.example/users/123',
    'subject with spaces',
    'x'.repeat(257),
    null,
    undefined,
  ]) {
    assert.equal(normalizeGa4UserId(value), '');
  }
});

test('blank or invalid configuration is a network-free no-op', () => {
  for (const measurementId of ['', 'not-a-ga4-id']) {
    const { documentRef, scripts, windowRef } = fakeBrowser({ measurementId });
    const analytics = createGoogleAnalytics({ windowRef, documentRef });

    assert.equal(analytics.enabled, false);
    assert.equal(analytics.trackPageView('agent'), false);
    assert.equal(scripts.length, 0);
    assert.equal(windowRef.dataLayer, undefined);
    assert.equal(windowRef.gtag, undefined);
  }
});

test('a persisted opt-out suppresses all GA initialization side effects', () => {
  const { documentRef, scripts, windowRef } = fakeBrowser();
  const storageRef = memoryStorage({ [ANALYTICS_CONSENT_KEY]: 'disabled' });
  windowRef.localStorage = storageRef;
  const analytics = createGoogleAnalytics({ windowRef, documentRef });

  assert.equal(analytics.enabled, false);
  assert.equal(analytics.trackPageView('agent'), false);
  assert.equal(scripts.length, 0);
  assert.equal(windowRef.dataLayer, undefined);
  assert.equal(windowRef.gtag, undefined);
});

test('queues gtag calls as Arguments objects', () => {
  const { documentRef, windowRef } = fakeBrowser();
  const analytics = createGoogleAnalytics({ windowRef, documentRef });

  assert.equal(analytics.trackPageView('agent'), true);
  assert.ok(windowRef.dataLayer.length > 0);
  for (const entry of windowRef.dataLayer) {
    assert.equal(Object.prototype.toString.call(entry), '[object Arguments]');
    assert.equal(Array.isArray(entry), false);
  }
});

test('loads gtag once and configures privacy-safe manual page views', () => {
  const { documentRef, scripts, windowRef } = fakeBrowser();
  const instant = new Date('2026-08-14T00:00:00.000Z');
  const analytics = createGoogleAnalytics({ windowRef, documentRef, now: () => instant });

  const identity = { authenticated: true, userId: 'firebase|ada' };
  assert.equal(analytics.trackPageView('agent', identity), true);
  assert.equal(analytics.trackPageView('settings', identity), true);
  assert.equal(scripts.length, 1);
  assert.deepEqual(scripts[0], {
    tagName: 'script',
    id: 'ai-fleet-google-analytics',
    async: true,
    src: 'https://www.googletagmanager.com/gtag/js?id=G-ABC123',
  });
  assert.deepEqual(callsOf(windowRef, 'js'), [['js', instant]]);
  assert.deepEqual(callsOf(windowRef, 'config'), [
    ['config', 'G-ABC123', {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      user_id: 'firebase|ada',
      page_location: 'https://fleet.example/#/agent',
      page_title: 'Agent',
    }],
    ['config', 'G-ABC123', {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      user_id: 'firebase|ada',
      page_location: 'https://fleet.example/#/settings',
      page_title: 'Settings',
    }],
  ]);
  assert.deepEqual(callsOf(windowRef, 'event'), [
    ['event', 'page_view', {
      page_location: 'https://fleet.example/#/agent',
      page_title: 'Agent',
      authentication_status: 'authenticated',
      send_to: 'G-ABC123',
    }],
    ['event', 'page_view', {
      page_location: 'https://fleet.example/#/settings',
      page_title: 'Settings',
      authentication_status: 'authenticated',
      send_to: 'G-ABC123',
    }],
  ]);
});

test('strips invite tokens, IDs, hash parameters, and UI titles from page-view data', () => {
  const secret = 'invite-token-do-not-send';
  const { documentRef, windowRef } = fakeBrowser({
    hash: `#/invite?token=${secret}&organization=org-private`,
    title: `Invitation for private-user@example.com | ${secret}`,
  });
  const analytics = createGoogleAnalytics({ windowRef, documentRef });

  assert.equal(analytics.trackPageView(undefined, {
    authenticated: true,
    userId: 'private-user@example.com',
  }), true);
  const [[, , event]] = callsOf(windowRef, 'event');
  assert.deepEqual(event, {
    page_location: 'https://fleet.example/#/invite',
    page_title: 'Invite',
    authentication_status: 'authenticated',
    send_to: 'G-ABC123',
  });
  assert.equal(JSON.stringify(windowRef.dataLayer).includes(secret), false);
  assert.equal(JSON.stringify(windowRef.dataLayer).includes('private-user@example.com'), false);
  assert.equal(JSON.stringify(windowRef.dataLayer).includes('private-customer'), false);
  assert.deepEqual(callsOf(windowRef, 'config')[0][2], {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    page_location: 'https://fleet.example/#/invite',
    page_title: 'Invite',
  });
});

test('sets user_id after login and clears invalid identity or logout without leaking it into events', () => {
  const { documentRef, windowRef } = fakeBrowser();
  const analytics = createGoogleAnalytics({ windowRef, documentRef });

  assert.equal(analytics.trackPageView('agent', {
    authenticated: false,
    userId: 'firebase|must-ignore',
  }), true);
  assert.equal(analytics.trackPageView('settings', {
    authenticated: true,
    userId: 'firebase|ada',
  }), true);
  assert.equal(analytics.trackPageView('settings', {
    authenticated: true,
    userId: 'firebase|ada',
  }), false, 'same route and identity is a shell rerender');
  assert.equal(analytics.trackPageView('settings', {
    authenticated: true,
    userId: 'private-user@example.com',
  }), false, 'an invalid replacement identity is cleared without duplicating the route');
  assert.equal(analytics.trackPageView('settings', { authenticated: false }), false,
    'logout clears identity without duplicating the current route');
  assert.equal(analytics.trackPageView('agent', { authenticated: false }), true);

  assert.deepEqual(callsOf(windowRef, 'set'), [
    ['set', { user_id: 'firebase|ada' }],
    ['set', { user_id: null }],
  ]);
  assert.deepEqual(
    callsOf(windowRef, 'config').map(([, , config]) => config.user_id),
    [undefined, 'firebase|ada', null, null]
  );
  const pageViews = callsOf(windowRef, 'event').map(([, , event]) => event);
  assert.deepEqual(
    pageViews.map((event) => event.authentication_status),
    ['anonymous', 'authenticated', 'anonymous']
  );
  assert.equal(pageViews.some((event) => Object.hasOwn(event, 'user_id')), false);
  assert.equal(JSON.stringify(windowRef.dataLayer).includes('firebase|must-ignore'), false);
  assert.equal(JSON.stringify(windowRef.dataLayer).includes('private-user@example.com'), false);
});

test('same-route auth expiry clears target config without sending another page view', () => {
  const { documentRef, windowRef } = fakeBrowser();
  const analytics = createGoogleAnalytics({ windowRef, documentRef });

  assert.equal(analytics.trackPageView('agent', {
    authenticated: true,
    userId: 'firebase|ada',
  }), true);
  assert.equal(analytics.trackPageView('agent', { authenticated: false }), false);

  assert.deepEqual(callsOf(windowRef, 'set'), [['set', { user_id: null }]]);
  assert.deepEqual(
    callsOf(windowRef, 'config').map(([, , config]) => config.user_id),
    ['firebase|ada', null]
  );
  assert.equal(callsOf(windowRef, 'event').length, 1);
});

test('persisted revocation updates a loaded tag, clears GA cookies, and suppresses future views', () => {
  const { documentRef, windowRef } = fakeBrowser();
  const storageRef = memoryStorage();
  windowRef.localStorage = storageRef;
  const cookieWrites = [];
  Object.defineProperty(documentRef, 'cookie', {
    configurable: true,
    get: () => '_ga=GA1.1.1.1; _ga_FLEET=GS1.1.1; session=keep-me; _gat=not-ga4',
    set: (value) => cookieWrites.push(value),
  });
  const analytics = createGoogleAnalytics({ windowRef, documentRef });
  assert.equal(analytics.trackPageView('agent'), true);

  assert.equal(setAnalyticsConsent('disabled', {
    windowRef,
    documentRef,
    storageRef,
  }), 'disabled');
  assert.equal(storageRef.value(ANALYTICS_CONSENT_KEY), 'disabled');
  assert.deepEqual(callsOf(windowRef, 'consent'), [[
    'consent',
    'update',
    {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    },
  ]]);
  assert.ok(cookieWrites.length >= 2);
  assert.ok(cookieWrites.every((value) => /^_ga(?:=|_FLEET=)/u.test(value)));
  assert.ok(cookieWrites.every((value) => value.includes('Max-Age=0') && value.includes('Path=/')));
  assert.equal(cookieWrites.some((value) => value.includes('session') || value.includes('_gat')), false);

  assert.equal(analytics.trackPageView('settings'), false);
  assert.equal(callsOf(windowRef, 'event').length, 1);
});

test('a failed preference write does not revoke loaded consent or clear cookies', () => {
  const { documentRef, windowRef } = fakeBrowser();
  const cookieWrites = [];
  Object.defineProperty(documentRef, 'cookie', {
    configurable: true,
    get: () => '_ga=GA1.1.1.1',
    set: (value) => cookieWrites.push(value),
  });
  const analytics = createGoogleAnalytics({ windowRef, documentRef });
  assert.equal(analytics.trackPageView('agent'), true);

  assert.throws(() => setAnalyticsConsent('disabled', {
    windowRef,
    documentRef,
    storageRef: { setItem: () => { throw new Error('quota'); } },
  }), /quota/);
  assert.equal(callsOf(windowRef, 'consent').length, 0);
  assert.deepEqual(cookieWrites, []);
  assert.equal(analytics.trackPageView('settings'), true);
});

test('deduplicates shell rerenders but tracks a route when it is revisited', () => {
  const { documentRef, windowRef } = fakeBrowser({ hash: '#/invite?token=first' });
  const analytics = createGoogleAnalytics({ windowRef, documentRef });

  assert.equal(analytics.trackPageView(undefined, { authenticated: false }), true);
  documentRef.title = 'Localized invitation title';
  windowRef.location.hash = '#/invite?token=second';
  assert.equal(analytics.trackPageView(undefined, { authenticated: false }), false, 'same top-level route is a shell rerender');
  assert.equal(analytics.trackPageView('settings', { authenticated: false }), true);
  assert.equal(analytics.trackPageView('invite', { authenticated: false }), true);

  assert.deepEqual(
    callsOf(windowRef, 'event').map(([, , event]) => event.page_location),
    [
      'https://fleet.example/#/invite',
      'https://fleet.example/#/settings',
      'https://fleet.example/#/invite',
    ]
  );
});

test('normalizes only the top-level hash route', () => {
  assert.equal(normalizeTopLevelRoute('#/Agent-Jobs/job-123?token=secret'), 'agent-jobs');
  assert.equal(normalizeTopLevelRoute('#/invite?token=secret'), 'invite');
  assert.equal(normalizeTopLevelRoute('#/?token=secret'), '');
  assert.equal(normalizeTopLevelRoute('#/private-customer-record'), '');
  assert.equal(sanitizedPageTitle('#/agent-jobs/job-123'), 'Agent Jobs');
  assert.equal(
    sanitizedPageLocation(
      { origin: 'https://fleet.example', pathname: '/', hash: '#/invite?token=secret' }
    ),
    'https://fleet.example/#/invite'
  );
});

test('the analytics allowlist covers every application route and nothing else', () => {
  const routes = [
    'agent', 'workflows', 'agent-jobs', 'calls', 'business', 'projects', 'board',
    'analytics', 'cost', 'troubleshooting', 'settings', 'organization', 'invite',
    'privacy', 'terms',
  ];
  for (const route of routes) assert.equal(normalizeTopLevelRoute(route), route);
  for (const route of ['unknown', 'user-123', 'project-private', '']) {
    assert.equal(normalizeTopLevelRoute(route), '');
  }
});
