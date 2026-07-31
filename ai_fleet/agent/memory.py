"""Typed, persistent workspace memory (port of agent/memory.js).

Five scopes carry durable facts the omnibox can save and recall:
    user      — per-user preferences, role, and stated facts
    business  — durable decisions about a business
    project   — decisions/notes scoped to a project
    task      — notes/outcomes scoped to a task or issue
    workspace — global notes alongside reviewed documentation

This module is deterministic: validation, scope detection, and lexical recall
run with no model call. Persistence lives in the store; writes from free text
are surfaced as a *draft* and confirmed by the user before saving.

Port notes:
- Store/output dict keys stay camelCase (`refId`, `createdAt` cross the store /
  HTTP boundary) per the SPA contract.
- JS regexes use ASCII `\\w`/`\\b` semantics, so patterns are compiled with
  `re.ASCII` to mirror them exactly (inputs are pre-normalized to ASCII spaces
  by `_clean_text`, so `\\s` divergence is moot).
- `REFID_PATTERN` uses `\\Z` (not `$`) so a trailing newline cannot pass, matching
  JS `$` end-of-input semantics.
"""

from __future__ import annotations

import re

MAX_QUERY_CHARS = 8_000
MAX_TITLE_CHARS = 160
MAX_TEXT_CHARS = 2_000
MAX_TAGS = 8
MAX_TAG_CHARS = 40
MAX_RESULTS = 8
TITLE_FROM_TEXT_CHARS = 60
REFID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")

MEMORY_SCOPES = ("user", "business", "project", "task", "workspace")
MEMORY_SOURCES = ("omnibox", "business-pipeline", "approval-gate", "task", "explicit")

STOP_WORDS = frozenset([
    "about", "after", "also", "and", "are", "can", "check", "find", "for", "from", "have",
    "into", "look", "our", "please", "recall", "remember", "save", "search", "show", "that",
    "the", "their", "this", "what", "when", "where", "which", "with", "workspace", "would", "your",
])


class MemoryError(Exception):
    """Boundary validation failure for a memory write/query (HTTP 400 by default).

    Shadows the Python builtin within this module intentionally; call sites use it
    module-qualified so there is no real collision.
    """

    def __init__(self, message, status=400):
        super().__init__(message)
        self.name = "MemoryError"
        self.message = message
        self.status = status


def _stringify(value):
    """Mirror JS `String(value)` for the scalar cases these boundaries see."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _clean_text(value, max_):
    """`String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, max)`."""
    s = "" if value is None else _stringify(value)
    return re.sub(r"\s+", " ", s).strip()[:max_]


def normalize_memory(body):
    """Boundary validation for a memory write. Returns ONLY the allowlisted
    fields — an attacker-supplied `id`/`createdAt` cannot slip through (no mass
    assignment).
    """
    if not isinstance(body, dict):
        raise MemoryError("A memory object is required.")
    scope = str(body.get("scope") or "").strip().lower()
    if scope not in MEMORY_SCOPES:
        raise MemoryError(f"scope must be one of: {', '.join(MEMORY_SCOPES)}.")
    text = _clean_text(body.get("text"), MAX_TEXT_CHARS)
    if not text:
        raise MemoryError("text is required.")

    ref_id = None
    if body.get("refId") is not None and body.get("refId") != "":
        ref_id = _stringify(body.get("refId"))
        if not REFID_PATTERN.match(ref_id):
            raise MemoryError('refId may contain only letters, numbers, "_" and "-" (max 64).')

    title = _clean_text(body.get("title"), MAX_TITLE_CHARS) or text[:TITLE_FROM_TEXT_CHARS]

    tags = []
    if isinstance(body.get("tags"), list):
        seen = []
        for tag in body["tags"]:
            cleaned = _clean_text(tag, MAX_TAG_CHARS)
            if cleaned and cleaned not in seen:
                seen.append(cleaned)
        tags = seen[:MAX_TAGS]

    source = body.get("source") if body.get("source") in MEMORY_SOURCES else "omnibox"
    return {"scope": scope, "refId": ref_id, "title": title, "text": text, "tags": tags, "source": source}


# Keyword fallbacks, checked in priority order after explicit "<scope> memory".
SCOPE_KEYWORDS = (
    ("user", re.compile(
        r"\b(?:remember (?:that )?i\b|i (?:prefer|like|want|always|usually|am|work)\b|"
        r"my (?:name|role|preference|email|timezone|style|goal)\b|about me|remind me|"
        r"note to self|for me)\b",
        re.IGNORECASE | re.ASCII)),
    ("task", re.compile(
        r"\b(?:tasks?|issues?|tickets?|stor(?:y|ies)|bugs?|backlog|sprint)\b",
        re.IGNORECASE | re.ASCII)),
    ("project", re.compile(r"\bprojects?\b", re.IGNORECASE | re.ASCII)),
    ("business", re.compile(
        r"\b(?:business|revenue|pricing|prices?|customers?|markets?|moneti[sz]\w*|sales|"
        r"profit|margins?|go-to-market|startup|company)\b",
        re.IGNORECASE | re.ASCII)),
    ("workspace", re.compile(
        r"\b(?:docs?|documentation|readme|guides?|how (?:do|to)|wiki)\b",
        re.IGNORECASE | re.ASCII)),
)

_EXPLICIT_SCOPE = re.compile(
    r"\b(user|business|project|task|workspace)\s+memor(?:y|ies)\b",
    re.IGNORECASE | re.ASCII)


def detect_memory_scope(query):
    """Deterministic scope inference. Returns a scope or 'all' when ambiguous."""
    input_ = _clean_text(query, MAX_QUERY_CHARS)
    if not input_:
        return "all"
    explicit = _EXPLICIT_SCOPE.search(input_)
    if explicit:
        return explicit.group(1).lower()
    for scope, pattern in SCOPE_KEYWORDS:
        if pattern.search(input_):
            return scope
    return "all"


WRITE_TRIGGER = re.compile(
    r"\b(?:remember(?:\s+that)?|note to self|keep in mind|make a note(?:\s+that)?)\b",
    re.IGNORECASE | re.ASCII)
SCOPED_WRITE = re.compile(
    r"\bsave (?:this )?(?:to|in) (?:my |our |the )?"
    r"(user|business|project|task|workspace) memor(?:y|ies)\s*[:\-]?\s*(.*)$",
    re.IGNORECASE | re.ASCII)
_WRITE_STRIP = re.compile(
    r"^.*?\b(?:remember(?:\s+that)?|note to self|keep in mind|make a note(?:\s+that)?)\s*[:\-]?\s*",
    re.IGNORECASE | re.ASCII)


def detect_memory_write(input_):
    """Recognize a "remember this" style write request and return a DRAFT
    ({scope, title, text}) for the user to confirm — this never persists.
    Returns None when the input is a plain read/query.
    """
    text = _clean_text(input_, MAX_QUERY_CHARS)
    if not text:
        return None

    scoped = SCOPED_WRITE.search(text)
    if scoped:
        return _draft(scoped.group(1).lower(), _clean_text(scoped.group(2), MAX_TEXT_CHARS) or text)
    if not WRITE_TRIGGER.search(text):
        return None

    body = _clean_text(_WRITE_STRIP.sub("", text, count=1), MAX_TEXT_CHARS) or text
    return _draft(detect_memory_scope(text), body)


def _draft(scope, body):
    scope_out = scope if scope in MEMORY_SCOPES else "workspace"
    text = body or ""
    return {"scope": scope_out, "title": text[:TITLE_FROM_TEXT_CHARS] or "Saved note", "text": text}


def _query_terms(query):
    lowered = _clean_text(query, MAX_QUERY_CHARS).lower()
    matches = re.findall(r"[a-z0-9][a-z0-9_-]{1,}", lowered)
    seen = []
    for term in matches:
        if term not in seen:
            seen.append(term)
    return [term for term in seen if len(term) > 2 and term not in STOP_WORDS][:20]


def _match_score(text, terms):
    haystack = _stringify(text or "").lower()
    return sum(1 for term in terms if term in haystack)


def _template(value):
    """Mirror a JS template literal `${value}`: undefined/None -> 'undefined'."""
    if value is None:
        return "undefined"
    return _stringify(value)


def _join(arr):
    """Mirror `Array.prototype.join(' ')`: null/undefined elements -> ''."""
    return " ".join("" if x is None else _stringify(x) for x in arr)


def search_memories(query, memories, options=None):
    """Bounded lexical recall over stored memories, optionally filtered by scope."""
    options = options or {}
    opt_scope = options.get("scope")
    scope = opt_scope if (opt_scope and opt_scope != "all") else None
    terms = _query_terms(query)
    pool = memories if isinstance(memories, list) else []
    pool = [m for m in pool if (not scope or m.get("scope") == scope)]

    scored = []
    for index, memory in enumerate(pool):
        title_raw = memory.get("title")
        text_raw = memory.get("text")
        scope_raw = memory.get("scope")
        tags_raw = memory.get("tags") or []
        score = _match_score(
            f"{_template(title_raw)} {_template(text_raw)} {_join(tags_raw)}", terms)
        record = {
            "id": memory.get("id"),
            "scope": scope_raw,
            "refId": memory.get("refId") or None,
            "type": f"Memory · {_template(scope_raw)}",
            "title": title_raw or "Memory",
            "summary": _clean_text(text_raw, 320),
            "status": memory.get("source") or "Saved",
            "score": score,
        }
        scored.append((score, index, record))

    scored = [entry for entry in scored if (not terms or entry[0] > 0)]
    scored.sort(key=lambda entry: (-entry[0], entry[1]))
    return [record for (_score, _index, record) in scored[:MAX_RESULTS]]
