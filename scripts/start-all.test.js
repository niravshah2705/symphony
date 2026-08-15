'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('local stream-token broker is standalone and exclusively receives its secret', () => {
  const previousSecret = process.env.STREAM_TOKEN_SECRET;
  process.env.STREAM_TOKEN_SECRET = 'local-stream-secret-for-test';
  delete require.cache[require.resolve('./start-all')];

  try {
    const { envFor, LOCAL_DEPENDENCIES } = require('./start-all');
    const broker = LOCAL_DEPENDENCIES.find((entry) => entry.name === 'stream-token-broker');
    assert.equal(broker.entry, 'services/proxy/src/stream-token-server.js');

    const brokerEnv = envFor('stream-token-broker');
    const gatewayEnv = envFor('gateway');
    const plannerEnv = envFor('planner');

    assert.equal(brokerEnv.STREAM_TOKEN_SECRET, 'local-stream-secret-for-test');
    assert.equal(brokerEnv.PROXY_CAPABILITIES, undefined);
    assert.equal(brokerEnv.INTERNAL_API_TOKEN, undefined);
    assert.equal(gatewayEnv.STREAM_TOKEN_SECRET, undefined);
    assert.equal(plannerEnv.STREAM_TOKEN_SECRET, undefined);
    assert.equal(gatewayEnv.STREAM_TOKEN_SERVICE_URL, `http://127.0.0.1:${broker.healthPort}`);
    assert.equal(gatewayEnv.STREAM_TOKEN_PROXY_URL, undefined);
  } finally {
    if (previousSecret === undefined) delete process.env.STREAM_TOKEN_SECRET;
    else process.env.STREAM_TOKEN_SECRET = previousSecret;
    delete require.cache[require.resolve('./start-all')];
  }
});
