'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { trustProxyHops, configureTrustProxy } = require('./trust-proxy');

test('trusts exactly one hop on Cloud Run and none locally', () => {
  assert.equal(trustProxyHops({ K_SERVICE: 'gateway' }), 1);
  assert.equal(trustProxyHops({}), 0);
});

test('bounded explicit hop count overrides Cloud Run detection', () => {
  assert.equal(trustProxyHops({ K_SERVICE: 'gateway', TRUST_PROXY_HOPS: '2' }), 2);
  assert.equal(trustProxyHops({ K_SERVICE: 'gateway', TRUST_PROXY_HOPS: 'true' }), 0);
  assert.equal(trustProxyHops({ K_SERVICE: 'gateway', TRUST_PROXY_HOPS: '999' }), 0);
});

test('configures Express only when trust is enabled', () => {
  const calls = [];
  assert.equal(configureTrustProxy({ set: (...args) => calls.push(args) }, { K_SERVICE: 'gateway' }), 1);
  assert.deepEqual(calls, [['trust proxy', 1]]);
});
