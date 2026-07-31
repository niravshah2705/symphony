"""Validation and shaping for agent-workspace conversation threads
(port of agent/conversations.js).

Persistence lives in the store; this module is the boundary that keeps stored
messages small and allowlisted. A stored assistant message is a BOUNDED
TRANSCRIPT (enough to re-render the chat bubble), never the full routed payload
— `input` lets a historical "Open result" re-route the original request live.

Port notes: store/output dict keys stay camelCase (`createdAt`, `updatedAt`,
`messageCount` cross the store / HTTP boundary) per the SPA contract. `bound`
preserves internal whitespace (trim only, no collapse); `derive_title` /
`normalize_title` collapse whitespace, mirroring the JS.
"""

from __future__ import annotations

import re

MAX_MESSAGES_PER_REQUEST = 10
MAX_TEXT = 8_000  # user input (matches the omnibox composer maxlength)
MAX_COPY = 2_000
MAX_TITLE = 120
MAX_LABEL = 80
MAX_INTENT = 40
MAX_WARNING = 400
TITLE_FROM_TEXT = 60


class ConversationError(Exception):
    """Boundary validation failure for a conversation write (HTTP 400 by default)."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.name = "ConversationError"
        self.message = message
        self.status = status


def _stringify(value):
    """Mirror JS `String(value)` for the scalar cases these boundaries see."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _bound(value, max_):
    """Trim + bound; preserves internal whitespace so the transcript stays faithful."""
    s = "" if value is None else _stringify(value)
    return s.strip()[:max_]


def normalize_message(raw):
    if not isinstance(raw, dict):
        raise ConversationError("each message must be an object.")
    raw_role = raw.get("role")
    role = "assistant" if raw_role == "assistant" else ("user" if raw_role == "user" else None)
    if not role:
        raise ConversationError('message role must be "user" or "assistant".')

    if role == "user":
        text = _bound(raw.get("text"), MAX_TEXT)
        if not text:
            raise ConversationError("a user message requires text.")
        return {"role": role, "text": text}

    title = _bound(raw.get("title"), MAX_TITLE)
    copy = _bound(raw.get("copy"), MAX_COPY)
    if not title and not copy:
        raise ConversationError("an assistant message requires copy or title.")
    return {
        "role": role,
        "intent": _bound(raw.get("intent"), MAX_INTENT),
        "title": title,
        "copy": copy,
        "label": _bound(raw.get("label"), MAX_LABEL),
        "warning": _bound(raw.get("warning"), MAX_WARNING),
        "input": _bound(raw.get("input"), MAX_TEXT),
    }


def normalize_messages(list_):
    """Boundary validation for an append request — bounded count, allowlisted fields."""
    if not isinstance(list_, list) or not list_:
        raise ConversationError("messages must be a non-empty array.")
    if len(list_) > MAX_MESSAGES_PER_REQUEST:
        raise ConversationError(f"messages must be {MAX_MESSAGES_PER_REQUEST} or fewer per request.")
    return [normalize_message(item) for item in list_]


def derive_title(text):
    """First single line of the opening user message, bounded — the auto-title."""
    raw = "" if text is None else _stringify(text)
    clean = re.sub(r"\s+", " ", raw).strip()[:TITLE_FROM_TEXT]
    return clean or "New conversation"


def normalize_title(value):
    raw = "" if value is None else _stringify(value)
    title = re.sub(r"\s+", " ", raw).strip()[:MAX_TITLE]
    if not title:
        raise ConversationError("title is required.")
    return title


def summarize_conversation(conversation):
    """Lightweight list-row shape — never ships the messages array."""
    source = conversation or {}
    messages = source.get("messages")
    return {
        "id": source.get("id"),
        "title": source.get("title") or "New conversation",
        "createdAt": source.get("createdAt") or None,
        "updatedAt": source.get("updatedAt") or None,
        "messageCount": len(messages) if isinstance(messages, list) else 0,
    }
