'use strict';

const events = require('@ai-fleet/shared-core/messaging/events');
const streamTokens = require('./stream-token');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const { cleanContextId } = require('./request-context');

/**
 * Server-Sent Events endpoints:
 *   GET /api/agent/stream?conversationId=...&t=<token>  — one conversation's steps
 *   GET /api/agent/workspace-stream?t=<token>           — the global workspace feed
 *
 * EventSource cannot set an Authorization header, so these routes are mounted
 * before bearer authentication. When auth is enabled, the gateway delegates
 * token verification to its loopback proxy sidecar before it subscribes.
 */

const HEARTBEAT_MS = 15000;

function queryContext(req) {
  const query = (req && req.query) || {};
  return {
    organizationId: cleanContextId(query.organizationId),
    projectId: cleanContextId(query.projectId),
  };
}

/** Wire an open response to a channel subscription (headers, preamble, heartbeat, teardown). */
function streamChannel(req, res, subscribeChannel) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
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

function createSseHandlers(options = {}) {
  const authEnabled = options.authEnabled === undefined
    ? Boolean(CONFIG.AUTH && CONFIG.AUTH.enabled)
    : Boolean(options.authEnabled);
  const verifyStreamToken = options.verifyStreamToken || streamTokens.verifyStreamToken;
  const subscribe = options.subscribe || events.subscribe;
  const subscribeWorkspace = options.subscribeWorkspace || events.subscribeWorkspace;

  async function authorize(req, res, channelId, context) {
    if (!authEnabled) return true;
    const token = String((req.query && (req.query.t || req.query.token)) || '').trim();
    let valid;
    try {
      valid = await verifyStreamToken(token, channelId, context);
    } catch (_) {
      res.status(503).json({
        error: 'Stream token service is unavailable.',
        code: 'stream_token_unavailable',
      });
      return false;
    }
    if (!valid) {
      res.status(401).json({ error: 'Invalid or expired stream token.' });
      return false;
    }
    return true;
  }

  async function handleStream(req, res) {
    const conversationId = String((req.query && (req.query.conversationId || req.query.c)) || '').trim();
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId is required.' });
      return;
    }
    const context = queryContext(req);
    if (!await authorize(req, res, conversationId, context)) return;
    streamChannel(req, res, (cb) => subscribe(conversationId, cb, context));
  }

  async function handleWorkspaceStream(req, res) {
    const context = queryContext(req);
    if (!await authorize(req, res, events.WORKSPACE_CHANNEL, context)) return;
    streamChannel(req, res, (cb) => subscribeWorkspace(cb, context));
  }

  return { handleStream, handleWorkspaceStream };
}

const { handleStream, handleWorkspaceStream } = createSseHandlers();

module.exports = {
  handleStream,
  handleWorkspaceStream,
  createSseHandlers,
  queryContext,
  HEARTBEAT_MS,
};
