import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoogleAnalytics,
  normalizeGa4MeasurementId,
  normalizeTopLevelRoute,
  sanitizedPageLocation,
  sanitizedPageTitle,
} from './google-analytics.mjs';

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

  assert.equal(analytics.trackPageView('agent'), true);
  assert.equal(analytics.trackPageView('settings'), true);
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
      page_location: 'https://fleet.example/#/agent',
      page_title: 'Agent',
    }],
    ['config', 'G-ABC123', {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      page_location: 'https://fleet.example/#/settings',
      page_title: 'Settings',
    }],
  ]);
  assert.deepEqual(callsOf(windowRef, 'event'), [
    ['event', 'page_view', {
      page_location: 'https://fleet.example/#/agent',
      page_title: 'Agent',
      send_to: 'G-ABC123',
    }],
    ['event', 'page_view', {
      page_location: 'https://fleet.example/#/settings',
      page_title: 'Settings',
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

  assert.equal(analytics.trackPageView(), true);
  const [[, , event]] = callsOf(windowRef, 'event');
  assert.deepEqual(event, {
    page_location: 'https://fleet.example/#/invite',
    page_title: 'Invite',
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

test('deduplicates shell rerenders but tracks a route when it is revisited', () => {
  const { documentRef, windowRef } = fakeBrowser({ hash: '#/invite?token=first' });
  const analytics = createGoogleAnalytics({ windowRef, documentRef });

  assert.equal(analytics.trackPageView(), true);
  documentRef.title = 'Localized invitation title';
  windowRef.location.hash = '#/invite?token=second';
  assert.equal(analytics.trackPageView(), false, 'same top-level route is a shell rerender');
  assert.equal(analytics.trackPageView('settings'), true);
  assert.equal(analytics.trackPageView('invite'), true);

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
  ];
  for (const route of routes) assert.equal(normalizeTopLevelRoute(route), route);
  for (const route of ['unknown', 'user-123', 'project-private', '']) {
    assert.equal(normalizeTopLevelRoute(route), '');
  }
});
