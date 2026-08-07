'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const credentials = require('./credentials');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adlc-home-'));
  const prev = process.env.ADLC_HOME;
  process.env.ADLC_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.ADLC_HOME;
    else process.env.ADLC_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('save → load roundtrip under $ADLC_HOME', () => {
  withHome(() => {
    credentials.save({ token: 'tok-abc', apiUrl: 'http://gw', savedAt: 'now' });
    const loaded = credentials.load();
    assert.equal(loaded.token, 'tok-abc');
    assert.equal(loaded.apiUrl, 'http://gw');
    assert.equal(credentials.storedToken(), 'tok-abc');
  });
});

test('credential file is 0600 in a 0700 dir', () => {
  withHome((home) => {
    const file = credentials.save({ token: 't' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  });
});

test('load returns null when absent, and never throws on corrupt JSON', () => {
  withHome(() => {
    assert.equal(credentials.load(), null);
    assert.equal(credentials.storedToken(), null);
    fs.mkdirSync(credentials.homeDir(), { recursive: true });
    fs.writeFileSync(credentials.credentialsPath(), 'not json');
    assert.equal(credentials.load(), null);
  });
});

test('clear removes the file and is idempotent', () => {
  withHome(() => {
    credentials.save({ token: 't' });
    assert.equal(credentials.clear(), true);
    assert.equal(credentials.load(), null);
    assert.equal(credentials.clear(), false);
  });
});

test('mask never reveals the middle of the token', () => {
  assert.equal(credentials.mask('abcdefghijklmnop'), 'abcd…mnop');
  assert.equal(credentials.mask('short'), '*****');
  assert.equal(credentials.mask(''), '');
});
