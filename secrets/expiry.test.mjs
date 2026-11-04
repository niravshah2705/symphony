import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPIRY_OPTIONS,
  DEFAULT_EXPIRY,
  expiryMs,
  expiresAtDate,
  isExpired,
} from './expiry.mjs';

test('expiry presets cover 1h / 24h / 48h / 7d', () => {
  assert.deepEqual(EXPIRY_OPTIONS.map((o) => o.id), ['1h', '24h', '48h', '7d']);
  assert.equal(expiryMs('1h'), 3600e3);
  assert.equal(expiryMs('24h'), 86400e3);
  assert.equal(expiryMs('48h'), 172800e3);
  assert.equal(expiryMs('7d'), 604800e3);
});

test('default expiry is 24h', () => {
  assert.equal(DEFAULT_EXPIRY, '24h');
  assert.ok(EXPIRY_OPTIONS.some((o) => o.id === DEFAULT_EXPIRY));
});

test('unknown expiry ids are refused, not silently defaulted', () => {
  assert.throws(() => expiryMs('30m'), /unknown expiry/);
  assert.throws(() => expiryMs(undefined), /unknown expiry/);
});

test('expiresAtDate adds exactly the preset to now', () => {
  const now = Date.UTC(2026, 10, 4, 12, 0, 0);
  const d = expiresAtDate('48h', now);
  assert.equal(d.getTime() - now, expiryMs('48h'));
});

test('isExpired flips at the deadline', () => {
  const deadline = 1_000_000;
  assert.equal(isExpired(deadline, deadline - 1), false);
  assert.equal(isExpired(deadline, deadline), true);
});

test('maximum preset is within the 7-day rules bound', () => {
  const max = Math.max(...EXPIRY_OPTIONS.map((o) => o.ms));
  assert.equal(max, 7 * 24 * 60 * 60 * 1000);
});
