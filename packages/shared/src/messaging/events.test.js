'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// EVENTS_BACKEND defaults to 'memory' — exercise the in-process relay.
const events = require('./events');

test('subscribe receives events published after subscribing', () => {
  const got = [];
  const unsub = events.subscribe('c1', (e) => got.push(e));
  events.publishEvent('c1', { message: 'hello' });
  assert.deepEqual(got, [{ message: 'hello' }]);
  unsub();
});

test('subscribe replays buffered history first (late subscriber)', () => {
  events.publishEvent('c2', { n: 1 });
  events.publishEvent('c2', { n: 2 });
  const got = [];
  const unsub = events.subscribe('c2', (e) => got.push(e));
  assert.deepEqual(got, [{ n: 1 }, { n: 2 }]);
  unsub();
});

test('unsubscribe stops further delivery', () => {
  const got = [];
  const unsub = events.subscribe('c3', (e) => got.push(e));
  unsub();
  events.publishEvent('c3', { x: 1 });
  assert.equal(got.length, 0);
});

test('publishEvent is a safe no-op for missing conversationId or event', () => {
  assert.doesNotThrow(() => events.publishEvent('', { a: 1 }));
  assert.doesNotThrow(() => events.publishEvent('c4', null));
});

test('subscribe returns a no-op unsubscribe when conversationId is missing', () => {
  const unsub = events.subscribe('', () => {});
  assert.equal(typeof unsub, 'function');
  assert.doesNotThrow(() => unsub());
});

test('conversation channels isolate the selected organization and native project', () => {
  const alpha = [];
  const beta = [];
  const otherOrg = [];
  const alphaContext = { organizationId: 'org-a', projectId: 'project-a' };
  const unsubAlpha = events.subscribe('context-conversation', (event) => alpha.push(event), alphaContext);
  const unsubBeta = events.subscribe('context-conversation', (event) => beta.push(event), {
    organizationId: 'org-a', projectId: 'project-b',
  });
  const unsubOther = events.subscribe('context-conversation', (event) => otherOrg.push(event), {
    organizationId: 'org-b', projectId: 'project-a',
  });

  events.publishEvent('context-conversation', { message: 'alpha only' }, alphaContext);
  assert.deepEqual(alpha, [{ message: 'alpha only' }]);
  assert.deepEqual(beta, []);
  assert.deepEqual(otherOrg, []);
  assert.doesNotMatch(events.scopedChannelId('context-conversation', alphaContext), /org-a|project-a/);

  unsubAlpha();
  unsubBeta();
  unsubOther();
});

/* ----------------------- Global workspace channel ----------------------- */

test('subscribeWorkspace receives typed events published via publishWorkspace', () => {
  const got = [];
  const unsub = events.subscribeWorkspace((e) => got.push(e));
  events.publishWorkspace({ type: 'jobs', jobs: [] });
  events.publishWorkspace({ type: 'coder', coder: { running: true } });
  assert.deepEqual(got, [{ type: 'jobs', jobs: [] }, { type: 'coder', coder: { running: true } }]);
  unsub();
});

test('the workspace channel is isolated from conversation streams', () => {
  // The single workspace channel replays its buffered history to a late
  // subscriber, so assert on membership (marker present, cross-channel absent)
  // rather than exact array equality.
  const workspace = [];
  const conversation = [];
  const unsubW = events.subscribeWorkspace((e) => workspace.push(e));
  const unsubC = events.subscribe('isolation-conv', (e) => conversation.push(e));
  events.publishWorkspace({ type: 'agent-status', status: { marker: 'iso' } });
  events.publishEvent('isolation-conv', { message: 'hi' });
  assert.ok(workspace.some((e) => e.status && e.status.marker === 'iso'), 'workspace saw its own event');
  assert.ok(!workspace.some((e) => e.message === 'hi'), 'workspace never saw the conversation event');
  assert.deepEqual(conversation, [{ message: 'hi' }]);
  unsubW();
  unsubC();
});

test('ingest routes an http-sink workspace event onto the workspace channel', () => {
  const got = [];
  const unsub = events.subscribeWorkspace((e) => got.push(e));
  // The gateway collector calls ingest(conversationId, event); the workspace
  // channel rides the same path under its reserved id.
  events.ingest(events.WORKSPACE_CHANNEL, { type: 'gate', gateId: 'gate_x', status: 'proceeded' });
  assert.deepEqual(got.at(-1), { type: 'gate', gateId: 'gate_x', status: 'proceeded' });
  unsub();
});

test('workspace subscribers receive exact-project and org-wide events only', () => {
  const got = [];
  const context = { organizationId: 'workspace-org-a', projectId: 'workspace-project-a' };
  const unsub = events.subscribeWorkspace((event) => got.push(event), context);

  events.publishWorkspace({ type: 'notification', marker: 'org' }, { organizationId: 'workspace-org-a' });
  events.publishWorkspace({ type: 'jobs', marker: 'project' }, context);
  events.publishWorkspace({ type: 'jobs', marker: 'sibling' }, {
    organizationId: 'workspace-org-a', projectId: 'workspace-project-b',
  });
  events.publishWorkspace({ type: 'jobs', marker: 'other-org' }, {
    organizationId: 'workspace-org-b', projectId: 'workspace-project-a',
  });

  assert.deepEqual(got.map((event) => event.marker), ['org', 'project']);
  unsub();
});

test('WORKSPACE_CHANNEL is a reserved, non-conversation id', () => {
  assert.equal(events.WORKSPACE_CHANNEL, '__workspace__');
});
