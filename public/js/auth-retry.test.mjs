import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as authRetry from './auth-retry.mjs';

const {
  shouldRetryAuth,
  shouldNotifyAuthenticationRequired,
  createSingleFlight,
} = authRetry;

// shouldRetryAuth — the single source of truth for both the retry gate and the
// notify gate in api.js. Only an APP-auth 401 (or the identity probe) retries;
// connected-tool 401s and 403/500 must not.
test('shouldRetryAuth: 401 with authentication_required is retryable', () => {
  assert.equal(shouldRetryAuth({ status: 401, code: 'authentication_required', path: '/projects' }), true);
});

test('shouldRetryAuth: 401 on /auth/me is retryable even without a code', () => {
  assert.equal(shouldRetryAuth({ status: 401, code: '', path: '/auth/me' }), true);
});

test('shouldRetryAuth: connected-tool 401 (other code) is NOT retryable', () => {
  assert.equal(shouldRetryAuth({ status: 401, code: 'linear_unauthorized', path: '/projects' }), false);
});

test('shouldRetryAuth: 403 access_denied is NOT retryable', () => {
  assert.equal(shouldRetryAuth({ status: 403, code: 'access_denied', path: '/settings-policy/settings/org' }), false);
});

test('shouldRetryAuth: 500 is NOT retryable', () => {
  assert.equal(shouldRetryAuth({ status: 500, code: '', path: '/org/users' }), false);
});

test('shouldRetryAuth: 2xx is NOT retryable', () => {
  assert.equal(shouldRetryAuth({ status: 200, code: '', path: '/projects' }), false);
});

test('shouldRetryAuth: tolerates a missing argument', () => {
  assert.equal(shouldRetryAuth(), false);
});

// shouldNotifyAuthenticationRequired — an application-auth failure only owns
// the global sign-in notification when this browser session has an application
// token provider. Anonymous identity probes and connected-tool failures must
// remain ordinary request errors instead of locking the workspace.
test('shouldNotifyAuthenticationRequired: app-auth 401 with a token provider notifies', () => {
  assert.equal(shouldNotifyAuthenticationRequired({
    status: 401,
    code: 'authentication_required',
    path: '/projects',
    hasAccessTokenProvider: true,
  }), true);
});

test('shouldNotifyAuthenticationRequired: app-auth 401 without a token provider does not notify', () => {
  assert.equal(shouldNotifyAuthenticationRequired({
    status: 401,
    code: 'authentication_required',
    path: '/projects',
    hasAccessTokenProvider: false,
  }), false);
});

test('shouldNotifyAuthenticationRequired: anonymous provider-less identity 401 does not notify', () => {
  assert.equal(shouldNotifyAuthenticationRequired({
    status: 401,
    code: '',
    path: '/auth/me',
    hasAccessTokenProvider: false,
  }), false);
});

test('shouldNotifyAuthenticationRequired: signed-in identity 401 notifies', () => {
  assert.equal(shouldNotifyAuthenticationRequired({
    status: 401,
    code: '',
    path: '/auth/me',
    hasAccessTokenProvider: true,
  }), true);
});

test('shouldNotifyAuthenticationRequired: unrelated provider 401 never notifies', () => {
  assert.equal(shouldNotifyAuthenticationRequired({
    status: 401,
    code: 'linear_unauthorized',
    path: '/projects',
    hasAccessTokenProvider: true,
  }), false);
});

// createSingleFlight — coalesces a concurrent burst onto ONE call to fn so a
// 12-call parallel batch triggers exactly one token refresh, then clears the
// slot so a later burst refreshes again.
test('createSingleFlight: 12 concurrent calls invoke fn once and share the result', async () => {
  const run = createSingleFlight();
  let calls = 0;
  const fn = () => {
    calls += 1;
    return Promise.resolve('fresh-token');
  };
  const results = await Promise.all(Array.from({ length: 12 }, () => run(fn)));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r === 'fresh-token'));
});

test('createSingleFlight: a rejection propagates to every awaiter', async () => {
  const run = createSingleFlight();
  const fn = () => Promise.reject(new Error('refresh failed'));
  const settled = await Promise.allSettled(Array.from({ length: 5 }, () => run(fn)));
  assert.ok(settled.every((s) => s.status === 'rejected'));
});

test('createSingleFlight: re-invokes fn on a later call once the slot settles', async () => {
  const run = createSingleFlight();
  let calls = 0;
  const fn = () => {
    calls += 1;
    return Promise.resolve(calls);
  };
  await run(fn);
  await run(fn);
  assert.equal(calls, 2);
});

test('createSingleFlight: recovers after a rejected flight', async () => {
  const run = createSingleFlight();
  let calls = 0;
  const fn = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok');
  };
  await assert.rejects(run(fn));
  assert.equal(await run(fn), 'ok');
  assert.equal(calls, 2);
});
