import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIRST_LOGIN_EULA_STORAGE_KEY,
  currentVersionOf,
  markFirstLoginEulaSeen,
  readFirstLoginEulaSeen,
  setPendingFirstLoginEula,
  shouldPromptFirstLoginEula,
  takePendingFirstLoginEula,
} from './first-login-eula.mjs';

function storage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
    has: (key) => entries.has(key),
  };
}
const throwing = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceeded'); },
};

const MEMBER = { sub: 'u-member' };
const v2 = { version: '2', accepted: false };

test('only a signed-in caller on a real deployment can be prompted', () => {
  assert.equal(shouldPromptFirstLoginEula({ mode: 'firebase', authenticated: true, eulaStatus: v2 }), true);
  assert.equal(shouldPromptFirstLoginEula({ mode: 'disabled', authenticated: true, eulaStatus: v2 }), false,
    'local development auto-accepts server-side, so a card there records nothing');
  assert.equal(shouldPromptFirstLoginEula({ mode: 'firebase', authenticated: false, eulaStatus: v2 }), false,
    'a guest never accepts the EULA — the demo is not gated (§3)');
  assert.equal(shouldPromptFirstLoginEula(), false, 'an unknown state is not a prompt');
});

test('the server record wins over anything the client remembers', () => {
  assert.equal(shouldPromptFirstLoginEula({
    mode: 'firebase', authenticated: true, eulaStatus: { version: '2', accepted: true }, seenVersion: null,
  }), false);
  assert.equal(shouldPromptFirstLoginEula({
    mode: 'firebase', authenticated: true, eulaStatus: { version: '2', accepted: true, status: 'accepted' },
  }), false, 'an accepted current version is never re-asked, seen flag or not');
  assert.equal(shouldPromptFirstLoginEula({
    mode: 'firebase', authenticated: true, eulaStatus: { version: '2', accepted: false, status: 'accepted' },
  }), true, 'accepted at an older version is a re-prompt on the version bump');
});

test('an organisation member is never newly prompted', () => {
  assert.equal(shouldPromptFirstLoginEula({
    mode: 'firebase', authenticated: true, eulaStatus: v2, hasOrganization: true,
  }), false, 'joining an organisation already recorded acceptance');
});

test('declining is remembered for that version and re-asked on the next one', () => {
  assert.equal(shouldPromptFirstLoginEula({
    mode: 'firebase', authenticated: true, eulaStatus: v2, seenVersion: '2',
  }), false, 'a boot-per-boot nag is not the ask the plan calls for');
  assert.equal(shouldPromptFirstLoginEula({
    mode: 'firebase', authenticated: true, eulaStatus: { version: '3', accepted: false }, seenVersion: '2',
  }), true);
});

test('the seen flag is per user, not per device', () => {
  const local = storage();
  markFirstLoginEulaSeen(local, { user: MEMBER }, '2');
  assert.equal(readFirstLoginEulaSeen(local, { user: { sub: 'u-other' } }), null,
    'a second account in the same browser has not been asked');
  assert.equal(readFirstLoginEulaSeen(local, { user: MEMBER }), '2');
  assert.deepEqual(
    Object.keys(JSON.parse(local.getItem(FIRST_LOGIN_EULA_STORAGE_KEY))),
    ['u-member'],
    'the identity is the record key, so one account cannot clear another',
  );

  const byEmail = storage();
  markFirstLoginEulaSeen(byEmail, { user: { email: 'U.Member@X.io' } }, '2');
  assert.equal(readFirstLoginEulaSeen(byEmail, { user: { email: 'u.member@x.io' } }), '2',
    'a record keyed on email matches the lowercased identity the gateway derives');
});

test('a caller with no identity gets no flag in either direction', () => {
  const local = storage();
  markFirstLoginEulaSeen(local, { user: null }, '2');
  assert.equal(local.has(FIRST_LOGIN_EULA_STORAGE_KEY), false, 'nothing is written for an anonymous session');
  assert.equal(readFirstLoginEulaSeen(local, {}), null);
});

test('storage that throws or is corrupt reads as never-asked and writes nothing', () => {
  assert.equal(readFirstLoginEulaSeen(throwing, { user: MEMBER }), null);
  markFirstLoginEulaSeen(throwing, { user: MEMBER }, '2'); // does not throw
  const corrupt = storage({ [FIRST_LOGIN_EULA_STORAGE_KEY]: 'not json' });
  assert.equal(readFirstLoginEulaSeen(corrupt, { user: MEMBER }), null);
  markFirstLoginEulaSeen(corrupt, { user: MEMBER }, '3');
  assert.deepEqual(JSON.parse(corrupt.getItem(FIRST_LOGIN_EULA_STORAGE_KEY)), { 'u-member': '3' },
    'a corrupt record is replaced, not merged');
  assert.equal(readFirstLoginEulaSeen(null, { user: MEMBER }), null);
});

test('the version the card quotes is the version the server reported', () => {
  assert.equal(currentVersionOf({ eulaStatus: v2 }), '2');
  assert.equal(currentVersionOf({ eulaStatus: v2, currentVersion: '4' }), '4');
  assert.equal(currentVersionOf({}), null);
});

test('the hand-off is one-shot, so a reload does not re-paint the card', () => {
  takePendingFirstLoginEula(); // the module is shared with any earlier test
  setPendingFirstLoginEula('2');
  assert.equal(takePendingFirstLoginEula(), '2');
  assert.equal(takePendingFirstLoginEula(), null);
  setPendingFirstLoginEula('');
  assert.equal(takePendingFirstLoginEula(), 'unknown', 'a missing version still shows the card');
});
