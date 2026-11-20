'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// A guest transcript is org-less, so the property worth pinning is not "does the
// record save" but "does the record stay out of every workspace". Isolate to a
// temp dir before requiring store and never touch the real data/store.json.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-guest-'));
process.env.SOFTWARE_FACTORY_DATA_DIR = TMP_DIR;

const store = require('./store');

const LEGACY_FILE = path.join(TMP_DIR, 'store.json');
const WORKSPACES_DIR = path.join(TMP_DIR, 'workspaces');
const DAY_MS = 86400000;

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

function readRaw(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

test('a created session is bound to the clicked command and expires in 1 day', () => {
  const session = store.createGuestSession({
    commandId: 'gcmd.helloworld',
    nodeId: 'helloworld.stack',
    template: 'helloworld',
    variant: { stack: 'node' },
  });
  assert.match(session.id, /^gcs_/);
  assert.equal(session.commandId, 'gcmd.helloworld');
  assert.deepEqual(session.nodesVisited, ['helloworld.stack']);
  assert.deepEqual(session.variant, { stack: 'node' });
  assert.equal(Date.parse(session.expiresAt) - Date.parse(session.createdAt), store.GUEST_SESSION_TTL_MS);
  assert.equal(store.GUEST_SESSION_TTL_MS, DAY_MS);
  assert.equal(session.previewToken, null);
  // Nothing on the record can tie it to a tenant or a person.
  for (const forbidden of ['orgId', 'nativeProjectId', 'userId', 'visitorKey', 'visitorKeyHash', 'email']) {
    assert.ok(!(forbidden in session), `guest record grew a ${forbidden} field`);
  }
  assert.deepEqual(store.getGuestSession(session.id), session);
});

test('guest transcripts never enter a tenant workspace or the conversation list', () => {
  const session = store.createGuestSession({ commandId: 'gcmd.tictactoe', nodeId: 'tictactoe.theme' });
  store.runWithWorkspaceContext({ organizationId: 'acme-org' }, () => {
    const conversation = store.addConversation({ title: 'Acme thread' });
    // The guest collection is global, so it is still reachable — the point is
    // that it never joins the tenant's own conversation list.
    assert.ok(store.getGuestSession(session.id));
    assert.deepEqual(store.listConversations().map((c) => c.id), [conversation.id]);
    assert.ok(!store.listConversations().some((c) => String(c.id).startsWith('gcs_')));
  });

  // The transcript is only reachable globally, and the conversation list — which
  // the signed-in UI renders — never carries it.
  assert.ok(store.getGuestSession(session.id));
  assert.ok(!store.listConversations().some((c) => String(c.id).startsWith('gcs_')));

  // Strongest form: the physical org file must not contain a guest id at all.
  const workspaceFiles = fs.existsSync(WORKSPACES_DIR) ? fs.readdirSync(WORKSPACES_DIR) : [];
  for (const file of workspaceFiles) {
    assert.ok(!readRaw(path.join(WORKSPACES_DIR, file)).includes(session.id), `${file} leaked a guest session`);
  }
  assert.ok(readRaw(LEGACY_FILE).includes(session.id));
});

test('appending messages keeps the newest 40 and reports the overflow', () => {
  const session = store.createGuestSession({ commandId: 'gcmd.docs-search' });
  const cap = store.MAX_MESSAGES_PER_GUEST_SESSION;
  const first = store.appendGuestMessages(session.id, Array.from({ length: cap }, (_, i) => ({ role: 'assistant', text: `m${i}` })));
  assert.equal(first.overflow, false);
  assert.equal(first.session.messages.length, cap);
  assert.equal(first.session.messages[0].text, 'm0');

  const second = store.appendGuestMessages(session.id, [{ role: 'user', text: 'one too many' }]);
  assert.equal(second.overflow, true);
  assert.equal(second.session.messages.length, cap);
  assert.equal(second.session.messages.at(-1).text, 'one too many');
  assert.equal(second.session.messages[0].text, 'm1', 'the oldest message is the one that goes');
  for (const message of second.session.messages) assert.match(message.id, /^gmsg_/);

  assert.equal(store.appendGuestMessages('gcs_does_not_exist', [{ role: 'user', text: 'x' }]).session, null);
});

test('advancing the tree merges the variant and never extends the expiry', () => {
  const session = store.createGuestSession({ commandId: 'gcmd.helloworld', nodeId: 'helloworld.stack', variant: { stack: 'node' } });
  const expiresAt = session.expiresAt;
  const touched = store.touchGuestSession(session.id, {
    nodeId: 'helloworld.theme',
    flowId: 'deploy.webapp',
    variant: { accent: 'emerald' },
  });
  assert.equal(touched.nodeId, 'helloworld.theme');
  assert.equal(touched.flowId, 'deploy.webapp');
  assert.deepEqual(touched.variant, { stack: 'node', accent: 'emerald' }, 'a variant key merges instead of replacing');
  assert.deepEqual(touched.nodesVisited, ['helloworld.stack', 'helloworld.theme']);
  assert.equal(touched.expiresAt, expiresAt, 'answering more questions must not buy more retention');
  // Revisiting a node must not grow the trail without bound.
  assert.equal(store.touchGuestSession(session.id, { nodeId: 'helloworld.theme' }).nodesVisited.length, 2);
});

test('the preview token attaches once and its expiry is the deploy-time promise', () => {
  const session = store.createGuestSession({ commandId: 'gcmd.reverse-engineer', template: 'clone-storefront' });
  const at = Date.now() + DAY_MS;
  const updated = store.setGuestPreview(session.id, { previewToken: 'tok_abc', previewExpiresAt: new Date(at).toISOString() });
  assert.equal(updated.previewToken, 'tok_abc');
  assert.equal(Date.parse(updated.previewExpiresAt), at);
  assert.equal(store.getGuestSession(session.id).previewToken, 'tok_abc');
  assert.equal(store.setGuestPreview('gcs_missing', { previewToken: 'x' }), null);
});

test('pruning drops expired transcripts first, then caps the rest by recency', () => {
  const old = store.createGuestSession({ commandId: 'gcmd.helloworld' });
  const fresh = store.createGuestSession({ commandId: 'gcmd.tictactoe' });
  assert.equal(store.isGuestSessionExpired(fresh), false);
  assert.equal(store.isGuestSessionExpired(old, Date.parse(old.expiresAt) + 1), true);
  assert.equal(store.isGuestSessionExpired(null), true, 'an unknown session counts as expired');

  // Age `old` in place rather than by advancing the clock: two sessions created
  // in the same millisecond share an expiresAt, and a sweep that only looked
  // right at hour resolution would pass the test and drop live transcripts in
  // production.
  const raw = JSON.parse(readRaw(LEGACY_FILE));
  fs.writeFileSync(LEGACY_FILE, JSON.stringify({
    ...raw,
    guestSessions: raw.guestSessions.map((s) => (s.id === old.id ? { ...s, expiresAt: '2000-01-01T00:00:00.000Z' } : s)),
  }));

  let live = store.pruneGuestSessions(store.MAX_GUEST_SESSIONS);
  assert.ok(!live.some((s) => s.id === old.id), 'the expired transcript survived the sweep');
  assert.ok(live.some((s) => s.id === fresh.id), 'a live transcript was dropped by the TTL sweep');

  // The count cap keeps the newest, which is the order sessions are stored in.
  live = store.pruneGuestSessions(1);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, fresh.id);
  assert.equal(store.getGuestSession(old.id), null);
});

test('a session id is looked up strictly, so a fabricated one is simply unknown', () => {
  for (const bad of [null, undefined, 7, '', {}, '../../etc/passwd', 'gcs_not_here']) {
    assert.equal(store.getGuestSession(bad), null);
  }
  assert.equal(store.removeGuestSession('gcs_not_here'), false);
  const session = store.createGuestSession({ commandId: 'gcmd.docs-search' });
  assert.equal(store.removeGuestSession(session.id), true);
  assert.equal(store.getGuestSession(session.id), null);
});

test('a store written before the guest collection existed reads as an empty one', () => {
  const raw = JSON.parse(readRaw(LEGACY_FILE));
  delete raw.guestSessions;
  fs.writeFileSync(LEGACY_FILE, JSON.stringify(raw));
  assert.equal(store.createGuestSession({ commandId: 'gcmd.helloworld' }).id.startsWith('gcs_'), true);
  fs.writeFileSync(LEGACY_FILE, JSON.stringify({ ...raw, guestSessions: 'not-an-array' }));
  assert.equal(store.getGuestSession('gcs_any'), null);
});
