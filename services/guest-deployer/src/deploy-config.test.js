'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { CONFIG } = require('@software-factory/shared-core/config');
const { guestDeployConfig, resolveBindHost, DEFAULT_SITE, CLOUD_RUN_BIND_HOST } = require('./deploy-config');

const BASE = Object.freeze({
  GUEST_DEPLOY_INTERNAL_TOKEN: 'a'.repeat(40),
  GUEST_FIREBASE_PROJECT: 'sf-guest-previews',
});

test('the broker fails closed without its credential or its project', () => {
  assert.throws(() => guestDeployConfig({}), /GUEST_DEPLOY_INTERNAL_TOKEN is required/);
  assert.throws(() => guestDeployConfig({ GUEST_DEPLOY_INTERNAL_TOKEN: 'a'.repeat(40) }), /GUEST_FIREBASE_PROJECT is required/);
  assert.throws(() => guestDeployConfig({ ...BASE, GUEST_DEPLOY_INTERNAL_TOKEN: 'short' }), /at least 16 characters/);
});

test('it rejects an operator typo in a resource name before it reaches a URL', () => {
  assert.throws(() => guestDeployConfig({ ...BASE, GUEST_FIREBASE_PROJECT: 'Bad_Project' }), /project id/);
  assert.throws(() => guestDeployConfig({ ...BASE, GUEST_FIREBASE_SITE: 'Has Spaces' }), /hosting site id/);
  assert.throws(() => guestDeployConfig({ ...BASE, GUEST_HOSTING_CHANNEL: '-lead' }), /channel id/);
  assert.throws(() => guestDeployConfig({ ...BASE, GUEST_PREVIEW_TTL_MS: '0' }), /positive number/);
  assert.throws(() => guestDeployConfig({ ...BASE, GUEST_DEPLOY_DATA_DIR: 'relative/dir' }), /absolute path/);
});

test('the defaults agree with the gateway: one day, the guest site, loopback only', () => {
  const config = guestDeployConfig(BASE);
  assert.equal(config.retentionMs, CONFIG.GUEST_DEMO.previewTtlMs, 'retention must be the value the session advertises');
  assert.equal(config.site, DEFAULT_SITE);
  assert.equal(config.channel, 'live');
  assert.equal(config.bindHost, '127.0.0.1', 'a broker with a hosting credential must not bind outward by default');
  assert.equal(config.port, 8080);
  assert.equal(config.previewBaseOrigin, `https://${DEFAULT_SITE}.web.app`);
  assert.ok(path.isAbsolute(config.dataDir));
  assert.deepEqual(config.maxBodyBytes, 64 * 1024);
  assert.throws(() => { config.token = 'x'; }, TypeError, 'the resolved config is frozen');
});

test('an explicit preview origin is normalised, not re-quoted', () => {
  assert.equal(guestDeployConfig({ ...BASE, GUEST_PREVIEW_BASE_URL: 'https://previews.example.com///' }).previewBaseOrigin, 'https://previews.example.com');
});

test('resolveBindHost allows only the two addresses this process can be deployed on', () => {
  assert.equal(resolveBindHost(''), '127.0.0.1');
  assert.equal(resolveBindHost(CLOUD_RUN_BIND_HOST), CLOUD_RUN_BIND_HOST);
  assert.equal(resolveBindHost(`  ${CLOUD_RUN_BIND_HOST}  `), CLOUD_RUN_BIND_HOST, 'surrounding whitespace is not a third address');
  assert.throws(() => resolveBindHost('10.0.0.1'), /must be 127.0.0.1 or 0.0.0.0/);
});
