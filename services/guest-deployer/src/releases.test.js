'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createGuestReleases, GUEST_TOKEN } = require('./releases');

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TOKEN_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const TOKEN_B = '9c5b2a11-7d3e-4f60-8b19-2ad4c6e8f013';
const TOKEN_C = '1e8d4f77-3b26-4c91-b0a5-5f7d9c2e1460';

async function dir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'guest-releases-'));
}

function clock(start = T0) {
  const state = { at: start };
  return { now: () => state.at, advance: (ms) => { state.at += ms; return state.at; } };
}

test('a recorded preview carries the retention window and survives a restart', async (t) => {
  const dataDir = await dir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { now } = clock();
  const releases = createGuestReleases({ dataDir, retentionMs: DAY, now });

  const { entry, evicted } = await releases.add({ token: TOKEN_A, template: 'helloworld', variant: { accent: 'amber' } });
  assert.deepEqual(evicted, []);
  assert.equal(entry.token, TOKEN_A);
  assert.equal(entry.expiresAt, new Date(T0 + DAY).toISOString());
  assert.equal(path.join(dataDir, 'releases.json'), releases.ledgerPath);

  const reopened = createGuestReleases({ dataDir, retentionMs: DAY, now });
  assert.deepEqual(await reopened.get(TOKEN_A), entry, 'the ledger is the only record; a restart must not forget a live preview');
});

test('a token is the shape we mint or nothing', async (t) => {
  const dataDir = await dir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const releases = createGuestReleases({ dataDir, retentionMs: DAY, now: clock().now });
  for (const bad of ['../../etc/passwd', `${TOKEN_A}/..`, 'nope', TOKEN_A.toUpperCase(), '']) {
    await assert.rejects(() => Promise.resolve().then(() => releases.requireToken(bad)), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'guest_preview_token_invalid');
      return true;
    }, `${bad} must not be treated as a preview handle`);
  }
  assert.ok(GUEST_TOKEN.test(TOKEN_A));
});

test('a customisation replaces the files, never the lifetime', async (t) => {
  const dataDir = await dir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { now, advance } = clock();
  const releases = createGuestReleases({ dataDir, retentionMs: DAY, now });
  const created = await releases.add({ token: TOKEN_A, template: 'helloworld' });

  advance(6 * 60 * 60 * 1000);
  const updated = await releases.update({ token: TOKEN_A, template: 'helloworld', variant: { stack: 'static' } });
  assert.deepEqual(updated.variant, { stack: 'static' });
  assert.equal(updated.expiresAt, created.entry.expiresAt, 'clicking more must not buy more retention');
  assert.equal(updated.createdAt, created.entry.createdAt);
  assert.equal(updated.updatedAt, new Date(T0 + 6 * 60 * 60 * 1000).toISOString());

  await assert.rejects(() => releases.update({ token: TOKEN_C, template: 'helloworld' }), (error) => {
    assert.equal(error.status, 410);
    assert.equal(error.code, 'guest_preview_expired');
    return true;
  }, 'an unknown handle cannot be created by re-deploying it');
});

test('the sweep is what enforces retention: an aged-out preview disappears from the live set', async (t) => {
  const dataDir = await dir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { now, advance } = clock();
  const releases = createGuestReleases({ dataDir, retentionMs: DAY, now });
  await releases.add({ token: TOKEN_A, template: 'helloworld' });
  advance(60 * 60 * 1000);
  await releases.add({ token: TOKEN_B, template: 'tic-tac-toe' });

  advance(23 * 60 * 60 * 1000);
  assert.equal(await releases.get(TOKEN_A), null, 'a full day after it was minted the preview is gone');
  const live = await releases.live();
  assert.deepEqual(live.map((e) => e.token), [TOKEN_B]);

  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'releases.json'), 'utf8'));
  assert.deepEqual(persisted.releases.map((e) => e.token), [TOKEN_B], 'the sweep is written, not just remembered');
});

test('at capacity the preview that expires first makes room, and the caller is told', async (t) => {
  const dataDir = await dir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const { now, advance } = clock();
  const releases = createGuestReleases({ dataDir, retentionMs: DAY, now, maxLive: 2 });
  await releases.add({ token: TOKEN_A, template: 'helloworld' });
  advance(1000);
  await releases.add({ token: TOKEN_B, template: 'helloworld' });
  advance(1000);
  const { evicted } = await releases.add({ token: TOKEN_C, template: 'helloworld' });
  assert.deepEqual(evicted, [TOKEN_A]);
  assert.deepEqual((await releases.live()).map((e) => e.token), [TOKEN_B, TOKEN_C]);
  assert.equal(await releases.get(TOKEN_A), null);
});

test('a corrupt ledger reads as empty instead of wedging every deploy', async (t) => {
  const dataDir = await dir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'releases.json'), '{ this is not json', 'utf8');
  const releases = createGuestReleases({ dataDir, retentionMs: DAY, now: clock().now });
  assert.deepEqual(await releases.live(), []);
  await releases.add({ token: TOKEN_A, template: 'helloworld' });
  assert.deepEqual((await releases.live()).map((e) => e.token), [TOKEN_A]);
});

test('remove reports whether there was anything to withdraw', async (t) => {
  const dataDir = await dir();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const releases = createGuestReleases({ dataDir, retentionMs: DAY, now: clock().now });
  await releases.add({ token: TOKEN_A, template: 'helloworld' });
  assert.equal(await releases.remove(TOKEN_A), true);
  assert.equal(await releases.remove(TOKEN_A), false);
  assert.deepEqual(await releases.live(), []);
});
