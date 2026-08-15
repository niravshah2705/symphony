'use strict';

const { WORKSPACE_CHANNEL } = require('@ai-fleet/shared-core/messaging/events');

function sendUnavailable(res) {
  return res.status(503).json({
    error: 'Stream token service is unavailable.',
    code: 'stream_token_unavailable',
  });
}

/** Build the two public mint handlers with injectable dependencies for tests. */
function createStreamTokenHandlers(options) {
  const {
    mintStreamToken,
    mintWorkspaceToken,
    requestContext,
    getConversation,
    matchesEventContext,
  } = options;

  async function mintConversation(req, res) {
    const conversationId = String((req.query && req.query.conversationId) || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });
    const context = requestContext(req);
    const conversation = getConversation(conversationId);
    if (!conversation || !matchesEventContext(conversation, context)) {
      return res.status(404).json({ error: 'Unknown conversation.' });
    }

    try {
      const token = await mintStreamToken(conversationId, context);
      return res.set('Cache-Control', 'no-store').json({
        token,
        conversationId,
        organizationId: context.organizationId || null,
        projectId: context.projectId || null,
      });
    } catch (_) {
      return sendUnavailable(res);
    }
  }

  async function mintWorkspace(req, res) {
    const context = requestContext(req);
    try {
      const token = await mintWorkspaceToken(context);
      return res.set('Cache-Control', 'no-store').json({
        token,
        conversationId: WORKSPACE_CHANNEL,
        organizationId: context.organizationId || null,
        projectId: context.projectId || null,
      });
    } catch (_) {
      return sendUnavailable(res);
    }
  }

  return { mintConversation, mintWorkspace };
}

module.exports = { createStreamTokenHandlers, sendUnavailable };
