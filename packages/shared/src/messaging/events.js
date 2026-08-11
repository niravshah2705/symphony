'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { CONFIG, namespaceCollection } = require('../config');
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

function cleanContextId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

/** Normalize either browser-style or runtime-style native workspace context. */
function normalizeEventContext(value = {}) {
  const organizationId = cleanContextId(value.organizationId || value.orgId);
  const projectId = organizationId
    ? cleanContextId(value.projectId || value.nativeProjectId)
    : '';
  return Object.freeze({ organizationId, projectId });
}

/**
 * Scope a relay channel without exposing tenant identifiers in Firestore paths.
 * Empty context preserves the legacy channel for local/auth-disabled installs.
 */
function scopedChannelId(conversationId, context = {}) {
  const normalized = normalizeEventContext(context);
  if (!normalized.organizationId) return conversationId;
  const digest = crypto.createHash('sha256')
    .update(`${normalized.organizationId}\0${normalized.projectId}`)
    .digest('hex')
    .slice(0, 32);
  return `${conversationId}--${digest}`;
}

function matchesEventContext(resource, context = {}) {
  const actual = normalizeEventContext(resource);
  const expected = normalizeEventContext(context);
  return actual.organizationId === expected.organizationId
    && actual.projectId === expected.projectId;
}

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

// Namespaced per tenant (empty STORE_NAMESPACE → the shared 'aifleet_events'
// root, unchanged). Isolates a per-tenant gateway's SSE event stream from other
// tenants sharing the same Firestore database.
const EVENTS_ROOT = namespaceCollection('aifleet_events');

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

function httpPublish(conversationId, event, context) {
  return fetch(CONFIG.EVENTS_SINK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, event, context: normalizeEventContext(context) }),
  });
}

/** Publish one event to a conversation stream. Fire-and-forget (never throws). */
function publishEvent(conversationId, event, context = {}) {
  if (!conversationId || !event) return;
  const channelId = scopedChannelId(conversationId, context);
  if (CONFIG.EVENTS_BACKEND === 'firestore') {
    Promise.resolve(firestorePublish(channelId, event)).catch((err) => {
      log.error(`events publish ${channelId} failed: ${err && err.message ? err.message : err}`);
    });
    return;
  }
  if (CONFIG.EVENTS_SINK_URL) {
    Promise.resolve(httpPublish(conversationId, event, context)).catch((err) => {
      log.error(`events sink POST ${channelId} failed: ${err && err.message ? err.message : err}`);
    });
    return;
  }
  memoryPublish(channelId, event);
}

/** Inject an event received over HTTP (gateway collector) into the local bus. */
function ingest(conversationId, event, context = {}) {
  if (!conversationId || !event) return;
  memoryPublish(scopedChannelId(conversationId, context), event);
}

/**
 * Subscribe to a conversation's events. Replays history, then streams new ones.
 * @returns {() => void} unsubscribe
 */
function subscribe(conversationId, cb, context = {}) {
  if (!conversationId || typeof cb !== 'function') return () => {};
  const channelId = scopedChannelId(conversationId, context);
  return CONFIG.EVENTS_BACKEND === 'firestore'
    ? firestoreSubscribe(channelId, cb)
    : memorySubscribe(channelId, cb);
}

/**
 * Publish a typed event to the GLOBAL workspace channel (drives the SPA's
 * workspace SSE stream: agent-status / jobs / coder / gate). Fire-and-forget.
 */
function publishWorkspace(event, context = {}) {
  return publishEvent(WORKSPACE_CHANNEL, event, context);
}

/**
 * Subscribe to exact project events plus organization-wide events. This lets a
 * project selection receive its own snapshots and org-wide billing notices,
 * without receiving another project's jobs or status.
 */
function subscribeWorkspace(cb, context = {}) {
  const normalized = normalizeEventContext(context);
  if (!normalized.organizationId || !normalized.projectId) {
    return subscribe(WORKSPACE_CHANNEL, cb, normalized);
  }
  const unsubscribeOrganization = subscribe(WORKSPACE_CHANNEL, cb, {
    organizationId: normalized.organizationId,
  });
  const unsubscribeProject = subscribe(WORKSPACE_CHANNEL, cb, normalized);
  return () => {
    unsubscribeOrganization();
    unsubscribeProject();
  };
}

module.exports = {
  publishEvent,
  subscribe,
  ingest,
  publishWorkspace,
  subscribeWorkspace,
  normalizeEventContext,
  matchesEventContext,
  scopedChannelId,
  WORKSPACE_CHANNEL,
  MAX_BUFFER,
};
