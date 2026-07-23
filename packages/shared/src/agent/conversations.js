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

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConversationError('each message must be an object.');
  }
  const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null;
  if (!role) throw new ConversationError('message role must be "user" or "assistant".');

  if (role === 'user') {
    const text = bound(raw.text, MAX_TEXT);
    if (!text) throw new ConversationError('a user message requires text.');
    return { role, text };
  }

  const title = bound(raw.title, MAX_TITLE);
  const copy = bound(raw.copy, MAX_COPY);
  if (!title && !copy) throw new ConversationError('an assistant message requires copy or title.');
  return {
    role,
    intent: bound(raw.intent, MAX_INTENT),
    title,
    copy,
    label: bound(raw.label, MAX_LABEL),
    warning: bound(raw.warning, MAX_WARNING),
    input: bound(raw.input, MAX_TEXT),
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
  ConversationError,
  normalizeMessage,
  normalizeMessages,
  deriveTitle,
  normalizeTitle,
  summarizeConversation,
};
