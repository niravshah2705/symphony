'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { eulaUserKey, isAcceptedRecord, resolveEulaStatus, requireEulaAccepted } = require('./eula');

const VERSION = '1.0.0';

function req(auth, method = 'POST') {
  return { method, auth };
}
function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    json(body) { this.body = body; return this; },
  };
}
// A store stub: pre-load acceptance records keyed exactly as the gate keys them.
function readerFrom(records = {}) {
  return (key) => records[key] || null;
}

/* ----------------------------- key derivation ---------------------------- */

test('eulaUserKey: no identity (AUTH disabled) → shared local key', () => {
  assert.equal(eulaUserKey({ auth: { mode: 'disabled', user: null } }), 'user:__local__');
  assert.equal(eulaUserKey({}), 'user:__local__');
});

test('eulaUserKey: firebase user keyed by uid, lowercased; email fallback', () => {
  assert.equal(eulaUserKey({ auth: { user: { sub: 'UID-1', email: 'a@b.com' } } }), 'user:uid-1');
  assert.equal(eulaUserKey({ auth: { user: { email: 'Op@UiPath.com' } } }), 'user:op@uipath.com');
});

test('eulaUserKey is derived from req.auth only — a body cannot spoof it', () => {
  // A body-supplied id must be ignored (the gate never reads req.body).
  const request = { method: 'POST', auth: { user: { sub: 'real' } }, body: { userId: 'attacker', key: 'user:admin' } };
  assert.equal(eulaUserKey(request), 'user:real');
});

/* ------------------------------ acceptance ------------------------------- */

test('isAcceptedRecord requires accepted status AND the current version', () => {
  assert.equal(isAcceptedRecord({ status: 'accepted', version: VERSION }, VERSION), true);
  assert.equal(isAcceptedRecord({ status: 'accepted', version: '0.9.0' }, VERSION), false); // stale version re-prompts
  assert.equal(isAcceptedRecord({ status: 'rejected', version: VERSION }, VERSION), false);
  assert.equal(isAcceptedRecord(null, VERSION), false);
});

test('resolveEulaStatus reports accepted for the caller with a current record', () => {
  const status = resolveEulaStatus(req({ user: { sub: 'u1' } }), {
    readUser: readerFrom({ 'user:u1': { status: 'accepted', version: VERSION, via: 'user', at: 'T' } }),
    version: VERSION,
  });
  assert.equal(status.accepted, true);
  assert.equal(status.key, 'user:u1');
  assert.equal(status.acceptedVersion, VERSION);
});

test('resolveEulaStatus reports not-accepted when the record is a rejection', () => {
  const status = resolveEulaStatus(req({ user: { sub: 'u1' } }), {
    readUser: readerFrom({ 'user:u1': { status: 'rejected', version: VERSION } }),
    version: VERSION,
  });
  assert.equal(status.accepted, false);
  assert.equal(status.status, 'rejected');
});

/* -------------------------------- gate ----------------------------------- */

test('requireEulaAccepted calls next() when the caller has accepted', () => {
  const gate = requireEulaAccepted({ readUser: readerFrom({ 'user:u1': { status: 'accepted', version: VERSION } }), version: VERSION });
  const res = responseRecorder();
  let called = false;
  gate(req({ user: { sub: 'u1' } }), res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('requireEulaAccepted returns 403 EULA_REQUIRED when not accepted', () => {
  const gate = requireEulaAccepted({ readUser: readerFrom({}), version: VERSION });
  const res = responseRecorder();
  let called = false;
  gate(req({ user: { sub: 'u1' } }), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'EULA_REQUIRED');
  assert.equal(res.body.version, VERSION);
});

test('requireEulaAccepted 403s a stale-version acceptance (re-prompt on bump)', () => {
  const gate = requireEulaAccepted({ readUser: readerFrom({ 'user:u1': { status: 'accepted', version: '0.9.0' } }), version: VERSION });
  const res = responseRecorder();
  let called = false;
  gate(req({ user: { sub: 'u1' } }), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('requireEulaAccepted never gates a CORS preflight', () => {
  const gate = requireEulaAccepted({ readUser: readerFrom({}), version: VERSION });
  const res = responseRecorder();
  let called = false;
  gate(req({ user: { sub: 'u1' } }, 'OPTIONS'), res, () => { called = true; });
  assert.equal(called, true);
});
