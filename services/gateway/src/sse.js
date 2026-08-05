'use strict';

const { subscribe } = require('@ai-fleet/shared/messaging/events');
const { verifyStreamToken } = require('./stream-token');
const { CONFIG } = require('@ai-fleet/shared/config');

/**
 * Server-Sent Events endpoint: GET /api/agent/stream?conversationId=...&t=<token>
 *
 * Delivers a conversation's intermittent agent responses to one browser. Fed by
 * the event relay (in-process bus locally, Firestore onSnapshot in the cloud),
 * so it works regardless of which gateway instance holds the connection.
 *
 * EventSource cannot set an Authorization header, so when app auth is enabled a
 * short-lived signed stream token is validated from the query string instead of
 * the standard bearer middleware (this route is mounted before it).
 */

const HEARTBEAT_MS = 15000;

function handleStream(req, res) {
  const conversationId = String(req.query.conversationId || req.query.c || '').trim();
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId is required.' });
    return;
  }

  // Authorize the stream. No-op when auth is disabled (local dev).
  if (CONFIG.AUTH && CONFIG.AUTH.enabled) {
    const token = String(req.query.t || req.query.token || '').trim();
    if (!verifyStreamToken(token, conversationId)) {
      res.status(401).json({ error: 'Invalid or expired stream token.' });
      return;
    }
  }

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
  const unsubscribe = subscribe(conversationId, send);
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

module.exports = { handleStream, HEARTBEAT_MS };
