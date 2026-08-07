'use strict';

const { subscribe, subscribeWorkspace, WORKSPACE_CHANNEL } = require('@ai-fleet/shared/messaging/events');
const { verifyStreamToken } = require('./stream-token');
const { CONFIG } = require('@ai-fleet/shared/config');

/**
 * Server-Sent Events endpoints:
 *   GET /api/agent/stream?conversationId=...&t=<token>  — one conversation's steps
 *   GET /api/agent/workspace-stream?t=<token>           — the global workspace feed
 *
 * The conversation stream delivers one browser's intermittent agent responses;
 * the workspace stream delivers typed status/jobs/coder/gate snapshots that
 * replace the SPA's polling loops. Both are fed by the same event relay
 * (in-process bus locally, Firestore onSnapshot in the cloud), so they work
 * regardless of which gateway instance holds the connection.
 *
 * EventSource cannot set an Authorization header, so when app auth is enabled a
 * short-lived signed stream token is validated from the query string instead of
 * the standard bearer middleware (both routes are mounted before it).
 */

const HEARTBEAT_MS = 15000;

/** Wire an open response to a channel subscription (headers, preamble, heartbeat, teardown). */
function streamChannel(req, res, subscribeChannel) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Disable proxy/CDN buffering so events flush immediately.
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');

  const send = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (_) {
      /* client gone; teardown below handles cleanup */
    }
  };
  const unsubscribe = subscribeChannel(send);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      /* ignore */
    }
  }, HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/** True when auth is enabled and the query-string token does NOT match the channel. */
function tokenRejected(req, channelId) {
  if (!CONFIG.AUTH || !CONFIG.AUTH.enabled) return false;
  const token = String(req.query.t || req.query.token || '').trim();
  return !verifyStreamToken(token, channelId);
}

// GET /api/agent/stream — one conversation's event stream.
function handleStream(req, res) {
  const conversationId = String(req.query.conversationId || req.query.c || '').trim();
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId is required.' });
    return;
  }
  if (tokenRejected(req, conversationId)) {
    res.status(401).json({ error: 'Invalid or expired stream token.' });
    return;
  }
  streamChannel(req, res, (cb) => subscribe(conversationId, cb));
}

// GET /api/agent/workspace-stream — the global workspace event stream.
function handleWorkspaceStream(req, res) {
  if (tokenRejected(req, WORKSPACE_CHANNEL)) {
    res.status(401).json({ error: 'Invalid or expired stream token.' });
    return;
  }
  streamChannel(req, res, subscribeWorkspace);
}

module.exports = { handleStream, handleWorkspaceStream, HEARTBEAT_MS };
