'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const templates = require('@software-factory/shared-core/agent/guest-demo/templates');
const { createGuestReleases } = require('./releases');
const { createGuestDeployService } = require('./service');

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function setup(options = {}) {
  const dataDir = options.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'guest-service-'));
  if (!options.dataDir) await fs.mkdir(dataDir, { recursive: true });
  const hosting = {
    calls: [],
    async publish(input) {
      hosting.calls.push(input);
      return { versionName: `v${hosting.calls.length}`, releaseName: `r${hosting.calls.length}`, fileCount: input.files.length };
    },
  };
  const state = { at: T0 };
  const logs = [];
  const retentionMs = options.retentionMs ?? DAY;
  const make = (over = {}) => createGuestDeployService({
    config: { retentionMs },
    releases: createGuestReleases({ dataDir, retentionMs, now: () => state.at }),
    hosting,
    templates: options.templates || templates,
    baseOrigin: options.baseOrigin === null ? null : 'https://previews.example.test',
    now: () => state.at,
    log: (entry) => logs.push(entry),
    ...over,
  });
  const advance = (ms) => { state.at += ms; };
  return { svc: make(), make, hosting, logs, state, advance, dataDir, cleanup: () => fs.rm(dataDir, { recursive: true, force: true }) };
}

const prefixes = (call) => [...new Set(call.files.map((f) => f.path.split('/')[0]))].sort();

test('a deploy mints the handle, renders the bundle under it, and releases the union', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  const result = await h.svc.deploy({ template: 'helloworld', variant: { accent: 'emerald' } });

  assert.match(result.token, UUID_RE, 'the token is a minted uuid, never caller-supplied');
  assert.equal(result.url, `https://previews.example.test/${result.token}/`);
  assert.equal(result.expiresAt, new Date(T0 + DAY).toISOString());
  assert.equal(h.hosting.calls.length, 1);

  const files = h.hosting.calls[0].files;
  assert.deepEqual(prefixes(h.hosting.calls[0]), [result.token], 'no file may sit outside its own preview prefix');
  assert.ok(files.some((f) => f.path === `${result.token}/index.html`));
  assert.ok(files.some((f) => f.path === `${result.token}/styles.css`));
});

test('one guest customising cannot delete another guest preview', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  const a = await h.svc.deploy({ template: 'helloworld' });
  const b = await h.svc.deploy({ template: 'tic-tac-toe' });

  const last = h.hosting.calls[h.hosting.calls.length - 1];
  const union = [
    ...h.svc.filesFor({ token: a.token, template: 'helloworld', variant: {} }),
    ...h.svc.filesFor({ token: b.token, template: 'tic-tac-toe', variant: {} }),
  ].map((f) => f.path).sort();
  assert.deepEqual(last.files.map((f) => f.path).sort(), union, 'the release is the union of every live preview');
  assert.equal(b.live, 2, 'the second deploy reports both previews still serving');
  assert.equal(last.files.length, union.length);
});

test('a customisation re-releases the same handle with the new variant and the old expiry', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  const first = await h.svc.deploy({ template: 'helloworld', variant: { accent: 'emerald' } });
  h.advance(60 * 60 * 1000);
  const again = await h.svc.redeploy({ token: first.token, template: 'helloworld', variant: { accent: 'amber' } });

  assert.equal(again.token, first.token, 'the visitor keeps one URL');
  assert.equal(again.expiresAt, first.expiresAt, 'and does not buy more retention');
  const released = h.hosting.calls[1].files.find((f) => f.path === `${first.token}/styles.css`).content;
  const before = h.hosting.calls[0].files.find((f) => f.path === `${first.token}/styles.css`).content;
  assert.notEqual(released, before, 'the accent actually changed in the released bytes');
});

test('an unknown handle cannot be customised into existence', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  const ghost = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  await assert.rejects(() => h.svc.redeploy({ token: ghost, template: 'helloworld' }), (error) => {
    assert.equal(error.status, 410);
    return true;
  });
  assert.equal(h.hosting.calls.length, 0, 'a refused re-release must not touch the site');
});

test('retention is enforced by the release, not by a delete call', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  const a = await h.svc.deploy({ template: 'helloworld' });
  h.advance(DAY - 1000);
  const b = await h.svc.deploy({ template: 'tic-tac-toe' });
  assert.deepEqual(prefixes(h.hosting.calls[1]), [a.token, b.token].sort());

  h.advance(2000);
  const c = await h.svc.deploy({ template: 'clone-storefront' });
  assert.deepEqual(prefixes(h.hosting.calls[2]), [b.token, c.token].sort(), 'the day-old preview is simply not in the new version');
});

test('removing the last preview releases an empty site rather than leaving stale pages', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  const a = await h.svc.deploy({ template: 'helloworld' });
  const removed = await h.svc.remove(a.token);
  assert.equal(removed.live, 0);
  assert.deepEqual(h.hosting.calls[1], { files: [], allowEmpty: true }, 'an empty union is still a release, so the pages really go away');
  assert.equal(await h.svc.remove(a.token), null, 'an unknown handle is not reported as a success');
});

test('the tick publishes when the live set moved and stays quiet when it did not', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await h.svc.deploy({ template: 'helloworld' });
  const calls = h.hosting.calls.length;

  assert.deepEqual(await h.svc.tick(), { published: false, live: 1 }, 'nothing changed, so no new version');
  assert.equal(h.hosting.calls.length, calls);

  h.advance(DAY);
  const swept = await h.svc.tick();
  assert.equal(swept.published, true, 'an expired preview has to be withdrawn by releasing without it');
  assert.equal(swept.live, 0);
  assert.deepEqual(await h.svc.tick(), { published: false, live: 0 });
});

test('a fresh process re-releases once at boot, because a crash can strand a version', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  const a = await h.svc.deploy({ template: 'helloworld' });
  const restarted = h.make();
  const result = await restarted.tick();
  assert.equal(result.published, true, 'a boot release is what closes a crash between finalize and release');
  assert.deepEqual(prefixes(h.hosting.calls[h.hosting.calls.length - 1]), [a.token], 'and it reproduces the live set from the ledger');
});

test('a bundle that no longer builds is dropped from the release, not allowed to block every preview', async (t) => {
  const good = await setup();
  t.after(good.cleanup);
  const stale = await good.svc.deploy({ template: 'tic-tac-toe' });
  const fresh = await good.svc.deploy({ template: 'helloworld' });

  const brokenTemplates = {
    buildGuestRelease({ template }) {
      if (template === 'tic-tac-toe') throw new Error('the bundle moved on');
      return templates.buildGuestRelease({ template });
    },
  };
  const after = await setup({ templates: brokenTemplates, dataDir: good.dataDir });
  t.after(after.cleanup);
  const result = await after.svc.tick();
  assert.deepEqual(result.skipped, [stale.token]);
  assert.deepEqual(prefixes(after.hosting.calls[0]), [fresh.token], 'the healthy preview still ships');
  assert.ok(after.logs.some((entry) => entry.level === 'error' && entry.op === 'render'), 'and the operator is told which one failed');
});

test('with no configured origin the deployer still publishes and simply reports no URL', async (t) => {
  const h = await setup({ baseOrigin: null });
  t.after(h.cleanup);
  const result = await h.svc.deploy({ template: 'helloworld' });
  assert.equal(result.url, null);
  const status = await h.svc.status(result.token);
  assert.equal(status.url, null);
  assert.equal(status.template, 'helloworld');
});

test('a variant is allowlisted by the bundle, so a caller cannot smuggle arbitrary content', async (t) => {
  const h = await setup();
  t.after(h.cleanup);
  await assert.rejects(() => h.svc.deploy({ template: 'helloworld', variant: { content: '<script>alert(1)</script>' } }), (error) => {
    assert.equal(error.code, 'guest_variant_invalid');
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(h.hosting.calls.length, 0, 'a rejected deploy must not release anything');
});
