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
    const agentEnv = envFor('agent');

    assert.equal(brokerEnv.STREAM_TOKEN_SECRET, 'local-stream-secret-for-test');
    assert.equal(brokerEnv.PROXY_CAPABILITIES, undefined);
    assert.equal(brokerEnv.INTERNAL_API_TOKEN, undefined);
    assert.equal(gatewayEnv.STREAM_TOKEN_SECRET, undefined);
    assert.equal(agentEnv.STREAM_TOKEN_SECRET, undefined);
    assert.equal(gatewayEnv.STREAM_TOKEN_SERVICE_URL, `http://127.0.0.1:${broker.healthPort}`);
    assert.equal(gatewayEnv.STREAM_TOKEN_PROXY_URL, undefined);
  } finally {
    if (previousSecret === undefined) delete process.env.STREAM_TOKEN_SECRET;
    else process.env.STREAM_TOKEN_SECRET = previousSecret;
    delete require.cache[require.resolve('./start-all')];
  }
});

test('the guest broker is opt-in and holds the hosting credential alone', () => {
  const previous = { project: process.env.GUEST_FIREBASE_PROJECT, token: process.env.GUEST_DEPLOYER_INTERNAL_TOKEN };
  process.env.GUEST_FIREBASE_PROJECT = 'guest-previews-demo';
  process.env.GUEST_DEPLOYER_INTERNAL_TOKEN = 'guest-broker-secret-for-test';
  delete require.cache[require.resolve('./start-all')];

  try {
    const { envFor, LOCAL_DEPENDENCIES } = require('./start-all');
    const broker = LOCAL_DEPENDENCIES.find((entry) => entry.name === 'guest-deployer');
    assert.equal(broker.entry, 'services/guest-deployer/src/server.js');

    const brokerEnv = envFor('guest-deployer');
    assert.equal(brokerEnv.GUEST_DEPLOY_INTERNAL_TOKEN, 'guest-broker-secret-for-test');
    assert.equal(brokerEnv.INTERNAL_API_TOKEN, undefined, 'the platform S2S token must not ride into the process that can write the guest site');
    assert.equal(brokerEnv.GUEST_FIREBASE_PROJECT, 'guest-previews-demo');

    // Only the gateway calls it, and with the broker's own secret under the
    // gateway-side name. Any other workload receiving it would be a second
    // place for the same credential.
    for (const name of ['gateway', 'agent', 'egress-proxy', 'stream-token-broker']) {
      const env = envFor(name);
      if (name === 'gateway') {
        assert.equal(env.GUEST_DEPLOYER_URL, `http://127.0.0.1:${broker.healthPort}`);
        assert.equal(env.GUEST_DEPLOYER_INTERNAL_TOKEN, 'guest-broker-secret-for-test');
      } else {
        assert.equal(env.GUEST_DEPLOYER_URL, undefined, `${name} must not learn where the guest broker lives`);
        assert.equal(env.GUEST_DEPLOYER_INTERNAL_TOKEN, undefined);
      }
      assert.equal(env.GUEST_DEPLOY_INTERNAL_TOKEN, undefined, `${name} must not hold the broker's own secret`);
    }
  } finally {
    restore(previous);
  }
});

test('no guest project named means no broker started and no URL handed out', () => {
  const previous = { project: process.env.GUEST_FIREBASE_PROJECT, token: process.env.GUEST_DEPLOYER_INTERNAL_TOKEN };
  delete process.env.GUEST_FIREBASE_PROJECT;
  delete process.env.GUEST_DEPLOYER_INTERNAL_TOKEN;
  delete require.cache[require.resolve('./start-all')];

  try {
    const { envFor, LOCAL_DEPENDENCIES } = require('./start-all');
    assert.equal(LOCAL_DEPENDENCIES.some((entry) => entry.name === 'guest-deployer'), false,
      'a broker without a Firebase project would publish wherever the ambient credential points');
    assert.equal(envFor('gateway').GUEST_DEPLOYER_URL, undefined,
      'the gateway must fall back to rendering the preview step as skipped, not to a URL that 404s');
  } finally {
    restore(previous);
  }
});

function restore(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[require.resolve('./start-all')];
}
