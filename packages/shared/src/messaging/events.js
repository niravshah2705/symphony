'use strict';

const { EventEmitter } = require('node:events');
const { CONFIG } = require('../config');
const log = require('../logger');

/**
 * Conversation event relay — the transport behind the gateway's SSE stream.
 *
 * Agent workers `publishEvent(conversationId, event)` as they produce steps /
 * partial responses; the gateway `subscribe(conversationId, cb)`s to feed one
 * browser's EventSource.
 *
 * Publish path:
 *   - CONFIG.EVENTS_BACKEND === 'firestore' → write step docs under
 *     aifleet_events/{id}/steps (cloud; any gateway instance can read them).
 *   - else if CONFIG.EVENTS_SINK_URL is set → POST to the gateway collector
 *     (local multi-process dev: worker process → gateway process).
 *   - else → the in-process memory bus (single-process / tests).
 *
 * Subscribe path (only the gateway subscribes, to feed SSE):
 *   - 'firestore' → onSnapshot (initial snapshot replays history, then streams).
 *   - else → the in-process memory bus, into which the collector `ingest`s
 *     events received over HTTP.
 */

const MAX_BUFFER = 200;
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const buffers = new Map(); // conversationId -> event[]

/**
 * Reserved channel id for GLOBAL workspace events (typed status/jobs/coder/gate
 * snapshots) that are not tied to any one conversation. It rides the exact same
 * relay as a conversation stream — a fixed key in the memory bus, the same POST
 * shape into the http-sink collector, and a fixed doc under the Firestore events
 * collection — so it works across all three backends with no parallel code path.
 */
const WORKSPACE_CHANNEL = '__workspace__';

function memoryPublish(conversationId, event) {
  const buffer = buffers.get(conversationId) || [];
  buffers.set(conversationId, [...buffer, event].slice(-MAX_BUFFER));
  emitter.emit(conversationId, event);
}

function memorySubscribe(conversationId, cb) {
  for (const event of buffers.get(conversationId) || []) cb(event);
  const listener = (event) => cb(event);
  emitter.on(conversationId, listener);
  return () => emitter.off(conversationId, listener);
}

let db = null;
function getDb() {
  if (db) return db;
  const { Firestore } = require('@google-cloud/firestore');
  db = new Firestore({ projectId: CONFIG.GCP.projectId || undefined });
  return db;
}

const EVENTS_ROOT = 'aifleet_events';

function stepsCollection(conversationId) {
  return getDb().collection(EVENTS_ROOT).doc(conversationId).collection('steps');
}

function firestorePublish(conversationId, event) {
  return stepsCollection(conversationId).add({ ...event, ts: event.ts || new Date().toISOString() });
}

function firestoreSubscribe(conversationId, cb) {
  return stepsCollection(conversationId)
    .orderBy('ts')
    .onSnapshot(
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'added') cb(change.doc.data());
        }
      },
      (err) => log.error(`events onSnapshot ${conversationId} error: ${err && err.message ? err.message : err}`)
    );
}

function httpPublish(conversationId, event) {
  return fetch(CONFIG.EVENTS_SINK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, event }),
  });
}

/** Publish one event to a conversation stream. Fire-and-forget (never throws). */
function publishEvent(conversationId, event) {
  if (!conversationId || !event) return;
  if (CONFIG.EVENTS_BACKEND === 'firestore') {
    Promise.resolve(firestorePublish(conversationId, event)).catch((err) => {
      log.error(`events publish ${conversationId} failed: ${err && err.message ? err.message : err}`);
    });
    return;
  }
  if (CONFIG.EVENTS_SINK_URL) {
    Promise.resolve(httpPublish(conversationId, event)).catch((err) => {
      log.error(`events sink POST ${conversationId} failed: ${err && err.message ? err.message : err}`);
    });
    return;
  }
  memoryPublish(conversationId, event);
}

/** Inject an event received over HTTP (gateway collector) into the local bus. */
function ingest(conversationId, event) {
  if (!conversationId || !event) return;
  memoryPublish(conversationId, event);
}

/**
 * Subscribe to a conversation's events. Replays history, then streams new ones.
 * @returns {() => void} unsubscribe
 */
function subscribe(conversationId, cb) {
  if (!conversationId || typeof cb !== 'function') return () => {};
  return CONFIG.EVENTS_BACKEND === 'firestore'
    ? firestoreSubscribe(conversationId, cb)
    : memorySubscribe(conversationId, cb);
}

/**
 * Publish a typed event to the GLOBAL workspace channel (drives the SPA's
 * workspace SSE stream: agent-status / jobs / coder / gate). Fire-and-forget.
 */
function publishWorkspace(event) {
  return publishEvent(WORKSPACE_CHANNEL, event);
}

/** Subscribe to the global workspace channel. Replays recent history, then streams. */
function subscribeWorkspace(cb) {
  return subscribe(WORKSPACE_CHANNEL, cb);
}

module.exports = {
  publishEvent,
  subscribe,
  ingest,
  publishWorkspace,
  subscribeWorkspace,
  WORKSPACE_CHANNEL,
  MAX_BUFFER,
};
