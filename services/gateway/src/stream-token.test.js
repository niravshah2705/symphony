'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { mintStreamToken, verifyStreamToken } = require('./stream-token');

test('mint + verify roundtrip for the same conversationId', () => {
  const token = mintStreamToken('conv1');
  assert.equal(verifyStreamToken(token, 'conv1'), true);
});

test('token is bound to its conversationId (mismatch is rejected)', () => {
  const token = mintStreamToken('conv1');
  assert.equal(verifyStreamToken(token, 'conv2'), false);
});

test('malformed or empty tokens are rejected', () => {
  assert.equal(verifyStreamToken('', 'c'), false);
  assert.equal(verifyStreamToken('abc', 'c'), false);
  assert.equal(verifyStreamToken('123.badsig', 'c'), false);
  assert.equal(verifyStreamToken(mintStreamToken('c'), ''), false);
});

test('expired tokens are rejected', () => {
  const past = Date.now() - 1000;
  assert.equal(verifyStreamToken(`${past}.whatever`, 'c'), false);
});

test('fails closed when auth is enabled but STREAM_TOKEN_SECRET is unset', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./stream-token')"], {
    cwd: __dirname,
    encoding: 'utf8',
    env: {
      ...process.env,
      STREAM_TOKEN_SECRET: '',
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'demo-proj',
      FIREBASE_API_KEY: 'AIzaTESTKEY',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STREAM_TOKEN_SECRET is required/);
});
