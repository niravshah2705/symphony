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
