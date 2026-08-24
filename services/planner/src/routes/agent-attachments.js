'use strict';

/**
 * Chat attachments: upload -> extract -> chunk -> embed -> index, plus
 * retrieval and an LLM-synthesized "ask" endpoint. Split out of agent.js
 * (already large) since this is a fully self-contained, newly-added surface.
 *
 * Ingestion/retrieval logic lives in @ai-fleet/shared/attachments/service.js
 * (no LLM-calling code there — that package has no agent-SDK dependency); the
 * /ask endpoint's LLM synthesis is implemented here instead, where
 * resolveLlm/createChatModel are already available.
 */

const express = require('express');
const { getConversation } = require('@ai-fleet/shared/store');
const { asyncHandler } = require('@ai-fleet/shared/util');
const { CONFIG } = require('@ai-fleet/shared/config');
const { SENTINEL_TOKEN } = require('@ai-fleet/shared/egress');
const { getSettings } = require('@ai-fleet/shared/store');
const { resolveLlm, createChatModel } = require('@ai-fleet/shared/agent/llm');
const { normalizeEventContext, matchesEventContext } = require('@ai-fleet/shared/messaging/events');
const { redactSecrets } = require('@ai-fleet/shared/agent/tools/exec');
const attachmentsService = require('@ai-fleet/shared/attachments/service');
const attachmentTypes = require('@ai-fleet/shared/attachments/types');
const { isValidAttachmentId } = require('@ai-fleet/shared/attachments/model');

const CONV_ID_PATTERN = /^conv_[A-Za-z0-9_-]{1,64}$/;
const MAX_REDACT_BYTES = 1_000_000; // matches agent.js's redactUserText cap
const redactUserText = (value) => redactSecrets(String(value == null ? '' : value), [], MAX_REDACT_BYTES);

const router = express.Router();

function requestWorkspaceContext(req) {
  const getHeader = (name) => {
    if (req && typeof req.get === 'function') return req.get(name);
    return req && req.headers ? req.headers[name] : undefined;
  };
  return normalizeEventContext({
    organizationId: getHeader('x-ai-fleet-organization-id') || '',
    projectId: getHeader('x-ai-fleet-project-id') || '',
  });
}

function conversationForRequest(req, id) {
  const conversation = getConversation(id);
  return conversation && matchesEventContext(conversation, requestWorkspaceContext(req)) ? conversation : null;
}

// Attachments/RAG never use the "no headers = trusted local" fallback that
// conversation routes tolerate — both an organization and a project must be
// selected for any attachment request.
function requireOrgProjectContext(req, res) {
  const context = requestWorkspaceContext(req);
  if (!context.organizationId || !context.projectId) {
    res.status(400).json({ error: 'An organization and project must be selected to use attachments.' });
    return null;
  }
  return context;
}

function attachmentDeps(context) {
  return {
    embeddingApiKey: CONFIG.EGRESS_PROXY_URL ? SENTINEL_TOKEN : getSettings().antigravityApiKey || '',
    workspaceContext: context,
  };
}

// Duplicated in business-pipeline.js/rubric-middleware.js/framework.js/
// local-intelligence.js/lmstudio-context.js — small enough that extracting a
// shared helper isn't worth a new cross-module dependency for this one call site.
function messageText(response) {
  if (!response) return '';
  const content = response.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part && part.text) || '').join('');
  return '';
}

// GET /api/agent/attachment-types — canonical allowlist, so the composer's
// drag/drop filter never drifts from server-side enforcement. NOT nested
// under /conversations/ — agent.js already registers GET /conversations/:id,
// which would otherwise shadow a single-segment /conversations/attachment-types
// path (Express matches route order, and :id matches any literal segment).
router.get('/attachment-types', (req, res) => {
  res.json({ types: attachmentTypes.SUPPORTED_ATTACHMENT_TYPES, maxBytes: attachmentTypes.MAX_ATTACHMENT_BYTES });
});

// POST /api/agent/conversations/:id/attachments — validate + mint a signed
// GCS upload URL. The browser PUTs bytes directly to GCS next.
router.post(
  '/conversations/:id/attachments',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || '');
    if (!CONV_ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation id.' });
    const context = requireOrgProjectContext(req, res);
    if (!context) return;
    if (!conversationForRequest(req, id)) return res.status(404).json({ error: 'Conversation not found.' });

    const body = req.body || {};
    const result = await attachmentsService.mintUpload(
      {
        orgId: context.organizationId,
        projectId: context.projectId,
        conversationId: id,
        filename: body.filename,
        mimeType: body.mimeType,
        size: body.size,
      },
      attachmentDeps(context)
    );
    res.status(201).json(result);
  })
);

// POST /api/agent/conversations/:id/attachments/:attachmentId/complete —
// verify the object actually landed in GCS (never trust the browser's claim),
// then run the ingest pipeline for extractable types.
router.post(
  '/conversations/:id/attachments/:attachmentId/complete',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || '');
    const attachmentId = String(req.params.attachmentId || '');
    if (!CONV_ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation id.' });
    if (!isValidAttachmentId(attachmentId)) return res.status(400).json({ error: 'Invalid attachment id.' });
    const context = requireOrgProjectContext(req, res);
    if (!context) return;
    if (!conversationForRequest(req, id)) return res.status(404).json({ error: 'Conversation not found.' });

    const attachment = await attachmentsService.completeUpload(
      { orgId: context.organizationId, projectId: context.projectId, conversationId: id, attachmentId },
      attachmentDeps(context)
    );
    res.json({ attachment });
  })
);

// GET /api/agent/conversations/:id/attachments — list, for chip rendering and
// status polling.
router.get(
  '/conversations/:id/attachments',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || '');
    if (!CONV_ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation id.' });
    const context = requireOrgProjectContext(req, res);
    if (!context) return;
    if (!conversationForRequest(req, id)) return res.status(404).json({ error: 'Conversation not found.' });

    const attachments = await attachmentsService.listAttachments(
      { orgId: context.organizationId, projectId: context.projectId, conversationId: id },
      attachmentDeps(context)
    );
    res.json({ attachments });
  })
);

// DELETE /api/agent/conversations/:id/attachments/:attachmentId
router.delete(
  '/conversations/:id/attachments/:attachmentId',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || '');
    const attachmentId = String(req.params.attachmentId || '');
    if (!CONV_ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation id.' });
    if (!isValidAttachmentId(attachmentId)) return res.status(400).json({ error: 'Invalid attachment id.' });
    const context = requireOrgProjectContext(req, res);
    if (!context) return;
    if (!conversationForRequest(req, id)) return res.status(404).json({ error: 'Conversation not found.' });

    await attachmentsService.removeAttachment(
      { orgId: context.organizationId, projectId: context.projectId, conversationId: id, attachmentId },
      attachmentDeps(context)
    );
    res.json({ ok: true });
  })
);

// GET /api/agent/conversations/:id/attachments/search?q=... — pure retrieval,
// no LLM call: filename+snippet result cards, the same shape as the existing
// lexical documents/memory sources in the knowledge-intent fan-out.
router.get(
  '/conversations/:id/attachments/search',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || '');
    if (!CONV_ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation id.' });
    const context = requireOrgProjectContext(req, res);
    if (!context) return;
    if (!conversationForRequest(req, id)) return res.status(404).json({ error: 'Conversation not found.' });

    const query = redactUserText(String((req.query && req.query.q) || '').trim());
    if (!query) return res.json({ results: [] });

    const chunks = await attachmentsService.searchAttachments({ conversationId: id, query, limit: 5 }, attachmentDeps(context));
    res.json({
      results: chunks.map((chunk) => ({
        attachmentId: chunk.attachmentId,
        filename: chunk.filename,
        snippet: String(chunk.text || '').slice(0, 400),
      })),
    });
  })
);

// POST /api/agent/conversations/:id/attachments/ask — retrieve + synthesize a
// hosted-LLM answer. Deliberately separate from the local-only `general`
// intent (local-intelligence.js's documented local-model-only guarantee) —
// attaching a file is an explicit, opt-in action, unlike arbitrary typed chat
// text, so crossing to a hosted provider here doesn't weaken that guarantee.
// Known gap: image attachments are not inlined as multimodal content in this
// pass (no precedent for that anywhere in this codebase yet) — they're stored
// and viewable, but don't contribute to the synthesized answer below.
router.post(
  '/conversations/:id/attachments/ask',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || '');
    if (!CONV_ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation id.' });
    const context = requireOrgProjectContext(req, res);
    if (!context) return;
    if (!conversationForRequest(req, id)) return res.status(404).json({ error: 'Conversation not found.' });

    const question = redactUserText(String((req.body && req.body.question) || '').trim());
    if (!question) return res.status(400).json({ error: 'question is required.' });

    const chunks = await attachmentsService.searchAttachments({ conversationId: id, query: question, limit: 5 }, attachmentDeps(context));
    if (!chunks.length) {
      return res.json({ answer: "I couldn't find anything in this conversation's attachments to answer that.", citations: [] });
    }

    const llm = await resolveLlm(getSettings(), 'thinking');
    if (!llm || !llm.provider) return res.status(400).json({ error: 'No thinking model is configured.' });
    const model = createChatModel(llm, { json: false });
    const excerpts = chunks.map((c, i) => `[${i + 1}] (${c.filename})\n${c.text}`).join('\n\n');
    const system = 'Answer the question using ONLY the attached excerpts below. Cite sources as [1], [2], etc. '
      + 'If the excerpts do not contain the answer, say so plainly rather than guessing.';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let answer;
    try {
      const response = await model.invoke(
        [['system', system], ['human', `${excerpts}\n\nQuestion: ${question}`]],
        { signal: controller.signal, runName: 'attachments-ask' }
      );
      answer = messageText(response);
    } finally {
      clearTimeout(timer);
    }

    res.json({
      answer,
      citations: chunks.map((c) => ({ attachmentId: c.attachmentId, filename: c.filename, snippet: String(c.text || '').slice(0, 400) })),
    });
  })
);

module.exports = router;
