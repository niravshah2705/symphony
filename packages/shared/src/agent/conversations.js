'use strict';

/**
 * Validation and shaping for agent-workspace conversation threads. Persistence
 * lives in store.js (addConversation/appendConversationMessages/...); this module
 * is the boundary that keeps stored messages small and allowlisted.
 *
 * A stored assistant message is a BOUNDED TRANSCRIPT (enough to re-render the
 * chat bubble), never the full routed payload — `input` lets a historical
 * "Open result" re-route the original request live (routing is read-only).
 */

const MAX_MESSAGES_PER_REQUEST = 10;
const MAX_TEXT = 8_000; // user input (matches the omnibox composer maxlength)
const MAX_COPY = 2_000;
const MAX_TITLE = 120;
const MAX_LABEL = 80;
const MAX_INTENT = 40;
const MAX_WARNING = 400;
const TITLE_FROM_TEXT = 60;
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_ATTACHMENT_FILENAME = 255;
const MAX_CITATION_SNIPPET = 2_000; // matches MAX_COPY
const ATTACHMENT_ID_PATTERN = /^att_[a-zA-Z0-9-]{8,64}$/;

class ConversationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ConversationError';
    this.status = status;
  }
}

/** Trim + bound; preserves internal whitespace so the transcript stays faithful. */
function bound(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/** Bounded reference to an already-uploaded attachment — no gcsPath in the transcript. */
function normalizeAttachmentRef(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConversationError('each attachment reference must be an object.');
  }
  const id = String(raw.id == null ? '' : raw.id).trim();
  if (!ATTACHMENT_ID_PATTERN.test(id)) throw new ConversationError('attachment id is invalid.');
  const filename = bound(raw.filename, MAX_ATTACHMENT_FILENAME);
  if (!filename) throw new ConversationError('attachment filename is required.');
  const mimeType = bound(raw.mimeType, 120);
  const size = Number(raw.size);
  if (!Number.isFinite(size) || size <= 0) throw new ConversationError('attachment size must be a positive number.');
  return { id, filename, mimeType, size };
}

function normalizeAttachmentRefs(list) {
  if (list == null) return undefined;
  if (!Array.isArray(list)) throw new ConversationError('attachments must be an array.');
  if (list.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ConversationError(`a message may reference at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`);
  }
  return list.map(normalizeAttachmentRef);
}

/** Bounded citation into an attachment's extracted text, surfaced by the attachments "ask" endpoint. */
function normalizeCitation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConversationError('each citation must be an object.');
  }
  const attachmentId = String(raw.attachmentId == null ? '' : raw.attachmentId).trim();
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) throw new ConversationError('citation attachmentId is invalid.');
  const filename = bound(raw.filename, MAX_ATTACHMENT_FILENAME);
  const snippet = bound(raw.snippet, MAX_CITATION_SNIPPET);
  if (!snippet) throw new ConversationError('a citation requires a snippet.');
  return { attachmentId, filename, snippet };
}

function normalizeCitations(list) {
  if (list == null) return undefined;
  if (!Array.isArray(list)) throw new ConversationError('citations must be an array.');
  if (list.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ConversationError(`a message may include at most ${MAX_ATTACHMENTS_PER_MESSAGE} citations.`);
  }
  return list.map(normalizeCitation);
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConversationError('each message must be an object.');
  }
  const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null;
  if (!role) throw new ConversationError('message role must be "user" or "assistant".');

  if (role === 'user') {
    const text = bound(raw.text, MAX_TEXT);
    if (!text) throw new ConversationError('a user message requires text.');
    const attachments = normalizeAttachmentRefs(raw.attachments);
    return attachments ? { role, text, attachments } : { role, text };
  }

  const title = bound(raw.title, MAX_TITLE);
  const copy = bound(raw.copy, MAX_COPY);
  if (!title && !copy) throw new ConversationError('an assistant message requires copy or title.');
  const citations = normalizeCitations(raw.citations);
  return {
    role,
    intent: bound(raw.intent, MAX_INTENT),
    title,
    copy,
    label: bound(raw.label, MAX_LABEL),
    warning: bound(raw.warning, MAX_WARNING),
    input: bound(raw.input, MAX_TEXT),
    ...(citations ? { citations } : {}),
  };
}

/** Boundary validation for an append request — bounded count, allowlisted fields. */
function normalizeMessages(list) {
  if (!Array.isArray(list) || !list.length) {
    throw new ConversationError('messages must be a non-empty array.');
  }
  if (list.length > MAX_MESSAGES_PER_REQUEST) {
    throw new ConversationError(`messages must be ${MAX_MESSAGES_PER_REQUEST} or fewer per request.`);
  }
  return list.map(normalizeMessage);
}

/** First single line of the opening user message, bounded — the auto-title. */
function deriveTitle(text) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, TITLE_FROM_TEXT);
  return clean || 'New conversation';
}

function normalizeTitle(value) {
  const title = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (!title) throw new ConversationError('title is required.');
  return title;
}

/** Lightweight list-row shape — never ships the messages array. */
function summarizeConversation(conversation) {
  const source = conversation || {};
  return {
    id: source.id,
    title: source.title || 'New conversation',
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
    messageCount: Array.isArray(source.messages) ? source.messages.length : 0,
  };
}

module.exports = {
  MAX_MESSAGES_PER_REQUEST,
  MAX_TEXT,
  MAX_ATTACHMENTS_PER_MESSAGE,
  ConversationError,
  normalizeMessage,
  normalizeMessages,
  normalizeAttachmentRefs,
  normalizeCitations,
  deriveTitle,
  normalizeTitle,
  summarizeConversation,
};
