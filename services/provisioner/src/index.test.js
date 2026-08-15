'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCfg } = require('./index');

test('buildCfg passes the shared stream-token broker URL into tenant plans', () => {
  const previous = process.env.STREAM_TOKEN_SERVICE_URL;
  process.env.STREAM_TOKEN_SERVICE_URL = 'https://stream-token-broker.example';
  try {
    assert.equal(
      buildCfg('123456').streamTokenServiceUrl,
      'https://stream-token-broker.example',
    );
  } finally {
    if (previous === undefined) delete process.env.STREAM_TOKEN_SERVICE_URL;
    else process.env.STREAM_TOKEN_SERVICE_URL = previous;
  }
});
