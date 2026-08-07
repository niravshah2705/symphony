'use strict';

const out = require('./output');

/**
 * Follow a conversation's Server-Sent Events stream and print each step live.
 *
 * The gateway SSE endpoint (services/gateway/src/sse.js) keeps the connection
 * open with `: ping` heartbeats and has no explicit terminal frame, so the
 * follower stops on: an idle gap (no events for `idleMs`), an overall cap
 * (`maxMs`), or the server closing the stream. Events are
 * `{ level, message, ts, ... }` (packages/shared/src/messaging/events.js).
 *
 * EventSource can't send an Authorization header, so the stream authorizes via
 * a short-lived signed token from /api/agent/stream-token (a no-op locally when
 * AUTH_MODE=disabled, but always minted for uniformity).
 */

const DEFAULT_IDLE_MS = 45000;
const DEFAULT_MAX_MS = 15 * 60 * 1000;

function formatEvent(event) {
  const level = String(event.level || 'info').toUpperCase();
  const message = event.message !== undefined ? event.message : JSON.stringify(event);
  return `  [${level}] ${message}`;
}

/** Split accumulated SSE text into completed frames, returning [frames, remainder]. */
function drainFrames(buffer) {
  const parts = buffer.split('\n\n');
  const remainder = parts.pop();
  return [parts, remainder];
}

/** Extract the JSON payload from one SSE frame, or null for a comment/heartbeat. */
function parseFrame(frame) {
  const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
  if (dataLines.length === 0) return null;
  const payload = dataLines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
  try {
    return JSON.parse(payload);
  } catch (_) {
    return null;
  }
}

/**
 * @param {import('./client').createClient} client
 * @param {string} conversationId
 * @param {{ idleMs?: number, maxMs?: number, onEvent?: (e:any)=>void, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<any[]>} the events observed
 */
async function follow(client, conversationId, options = {}) {
  const idleMs = options.idleMs || DEFAULT_IDLE_MS;
  const maxMs = options.maxMs || DEFAULT_MAX_MS;
  const onEvent = options.onEvent || ((event) => out.line(formatEvent(event)));
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  const minted = await client.request(
    'GET',
    `/api/agent/stream-token?conversationId=${encodeURIComponent(conversationId)}`
  );
  const token = minted && minted.token ? minted.token : '';
  const url = `${client.base}/api/agent/stream?conversationId=${encodeURIComponent(conversationId)}&t=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const headers = client.headers({ Accept: 'text/event-stream' });
  const res = await fetchImpl(url, { headers, signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`Stream failed: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let idleTimer = null;
  const stop = () => {
    try {
      controller.abort();
    } catch (_) {
      /* already aborted */
    }
  };
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, idleMs);
  };
  const maxTimer = setTimeout(stop, maxMs);
  resetIdle();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const [frames, remainder] = drainFrames(buffer);
      buffer = remainder;
      for (const frame of frames) {
        const event = parseFrame(frame);
        if (!event) continue; // heartbeat / comment
        events.push(event);
        resetIdle();
        onEvent(event);
      }
    }
  } catch (err) {
    if (!(err && err.name === 'AbortError')) throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(maxTimer);
  }

  return events;
}

module.exports = { follow, formatEvent, parseFrame, drainFrames, DEFAULT_IDLE_MS, DEFAULT_MAX_MS };
