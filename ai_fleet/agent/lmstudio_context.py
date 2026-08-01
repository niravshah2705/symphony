"""Context-window management for LM Studio (port of agent/lmstudio-context.js).

The deep agent re-sends its ENTIRE, growing message history on every turn, but a
fixed-window local provider (LM Studio / oMLX) has a hard context window. A long
coder run therefore overflows the window and 400s. This module bounds the prompt
— but only when it actually exceeds the budget — using one of two strategies:

  - 'trim'      — drop the oldest middle turns, keep the head + most recent turns.
  - 'summarize' — condense the oldest middle turns into a single summary message
                  (via an injected LLM call) and keep the most recent turns
                  verbatim.
  - 'none'      — pass through unchanged (send as-is; may overflow).

All estimates are model-agnostic char->token approximations (no per-model
tokenizer): deliberately conservative so we over-count and manage sooner rather
than under-count and overflow.

Messages may be LangChain message objects (``langchain_core.messages``) OR plain
dicts ``{role|type, content}``. Type detection uses the LangChain ``.type``
attribute ('human'|'ai'|'system'|'chat'|'tool'), falling back to a dict role.
"""

from __future__ import annotations

import json
import math

from langchain_core.messages import HumanMessage

from ai_fleet.config import CONFIG

# Flat per-message allowance for role/formatting tokens the char estimate misses.
LMSTUDIO_MESSAGE_TOKEN_OVERHEAD = 4
# Cap on reduce passes when a summarized middle is still too big to fit in one go.
MAX_REDUCE_PASSES = 3

# System prompt for the summarization sub-call (kept terse and information-dense).
SUMMARY_SYSTEM_PROMPT = (
    "You are compressing an AI coding agent's working history so it fits a smaller "
    "context window. Summarize the conversation excerpt below into a compact, "
    "information-dense progress note. Preserve: decisions made, files created or "
    "edited (with paths), commands run and their key results, errors encountered, and "
    "any open TODOs or next steps. Omit chit-chat and redundant detail. Write terse "
    "notes, not prose. Do not invent information."
)

# Header on the injected summary message so it is recognizable in transcripts.
SUMMARY_MARKER = "[Summary of earlier turns — condensed to fit the context window]"


def _to_number(value):
    """Mirror JS ``Number(x)``: a finite float, or None when not coercible."""
    if value is None or isinstance(value, bool):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(num) or math.isinf(num):
        return None
    return num


def _cpt(chars_per_token):
    """JS ``Number(charsPerToken) || CONFIG.LMSTUDIO.charsPerToken``."""
    num = _to_number(chars_per_token)
    return num if num else CONFIG.LMSTUDIO.charsPerToken


def _content_of(message):
    """Read the content off a LangChain message object or a plain dict."""
    if isinstance(message, dict):
        return message.get("content")
    return getattr(message, "content", None)


def message_type(message):
    """LangChain message type ('system'|'human'|'ai'|'tool'|'chat'|…), tolerant of
    plain role dicts. Uses the LangChain ``.type`` attribute; maps a dict
    role/type of 'user'->'human' and 'assistant'->'ai'."""
    if message is None:
        return "generic"
    if not isinstance(message, dict):
        t = getattr(message, "type", None)
        if isinstance(t, str) and t:
            return t
        role = getattr(message, "role", None)
    else:
        role = message.get("role") or message.get("type")
    if role == "user":
        return "human"
    if role == "assistant":
        return "ai"
    return role or "generic"


def content_to_text(content):
    """Flatten a message's content (string | content blocks) to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, str):
                parts.append(b)
            elif isinstance(b, dict):
                parts.append(b.get("text") or "")
            else:
                parts.append(getattr(b, "text", None) or "")
        return "\n".join(parts)
    if content is None:
        return ""
    return str(content)


def _tool_calls_of(message):
    """Extract tool-call entries from either the LangChain or OpenAI shape."""
    if isinstance(message, dict):
        calls = message.get("tool_calls")
        if calls is None:
            kwargs = message.get("additional_kwargs") or {}
            calls = kwargs.get("tool_calls") if isinstance(kwargs, dict) else None
    else:
        calls = getattr(message, "tool_calls", None)
        if calls is None:
            kwargs = getattr(message, "additional_kwargs", None) or {}
            calls = kwargs.get("tool_calls") if isinstance(kwargs, dict) else None
    return calls if isinstance(calls, list) else []


def _message_char_length(message):
    """Approximate character length of a message's content + any tool-call payload."""
    if not message:
        return 0
    chars = len(content_to_text(_content_of(message)))
    tool_calls = _tool_calls_of(message)
    if tool_calls:
        chars += len(json.dumps(tool_calls))
    return chars


def estimate_text_tokens(text, chars_per_token=None):
    """Token estimate for a free-text string."""
    cpt = _cpt(chars_per_token)
    length = len(text) if isinstance(text, str) else 0
    return math.ceil(length / cpt)


def estimate_message_tokens(message, chars_per_token=None):
    """Model-agnostic token estimate for a single chat message (over-estimates)."""
    cpt = _cpt(chars_per_token)
    return math.ceil(_message_char_length(message) / cpt) + LMSTUDIO_MESSAGE_TOKEN_OVERHEAD


def _total_tokens(messages, chars_per_token=None):
    """Total estimated token cost of a message list."""
    return sum(estimate_message_tokens(m, chars_per_token) for m in messages)


def serialize_message_for_summary(message):
    """Render a message as a single text line for the summarizer's input."""
    role = message_type(message).upper()
    text = content_to_text(_content_of(message))
    call_strs = []
    for tc in _tool_calls_of(message):
        tc = tc if isinstance(tc, dict) else {}
        fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
        name = tc.get("name") or fn.get("name") or "tool"
        args_raw = tc.get("args") if tc.get("args") is not None else fn.get("arguments")
        try:
            args = args_raw if isinstance(args_raw, str) else json.dumps(args_raw or {})
        except Exception:
            args = ""
        call_strs.append(f"→calls {name}({args})")
    calls = " ".join(call_strs)
    line = f"{role}: {text}{f' {calls}' if calls else ''}"
    return line.strip()


def split_for_budget(messages, *, budget, summary_reserve=0, chars_per_token=None):
    """Split a history into a preserved head (leading system prompt(s) + the first
    human message — the task), a ``tail`` of the most recent messages that fit the
    budget (after reserving ``summary_reserve`` tokens), and the ``middle`` in
    between. A tool result never leads the tail (its assistant tool_call sits in
    the middle) — it is moved into the middle instead."""
    def cost(m):
        return estimate_message_tokens(m, chars_per_token)

    head = []
    i = 0
    n = len(messages)
    while i < n and message_type(messages[i]) == "system":
        head.append(messages[i])
        i += 1
    if i < n and message_type(messages[i]) == "human":
        head.append(messages[i])
        i += 1

    remaining = budget - sum(cost(m) for m in head) - summary_reserve
    tail = []
    j = n - 1
    while j >= i:
        c = cost(messages[j])
        if c > remaining:
            break
        tail.insert(0, messages[j])
        remaining -= c
        j -= 1
    middle = list(messages[i : j + 1])
    # Move orphaned leading tool result(s) out of the tail and into the middle.
    while tail and message_type(tail[0]) == "tool":
        middle.append(tail.pop(0))
    return {"head": head, "middle": middle, "tail": tail}


def trim_messages_for_budget(messages, budget_tokens, chars_per_token=None):
    """Trim a history to fit ``budget_tokens``: keep the head + most recent turns,
    drop the middle. A leading tool result is never kept. ``budget_tokens`` <= 0
    (or a history that already fits) is a pass-through."""
    budget = _to_number(budget_tokens)
    if not isinstance(messages, list) or budget is None or not (budget > 0):
        return messages
    if _total_tokens(messages, chars_per_token) <= budget:
        return messages
    split = split_for_budget(messages, budget=budget, summary_reserve=0, chars_per_token=chars_per_token)
    return [*split["head"], *split["tail"]]


async def _map_summarize(blocks, effective_budget, chars_per_token, summarize):
    """Map step: pack serialized blocks into chunks that fit ``effective_budget``
    and summarize each chunk. An oversized single block is truncated to fit and
    summarized on its own. Returns one summary string per chunk."""
    summaries = []
    buf = []
    buf_tokens = 0

    async def flush():
        nonlocal buf, buf_tokens
        if not buf:
            return
        summaries.append(await summarize("\n".join(buf)))
        buf = []
        buf_tokens = 0

    for block in blocks:
        t = estimate_text_tokens(block, chars_per_token)
        if t > effective_budget:
            await flush()
            cpt = _cpt(chars_per_token)
            summaries.append(await summarize(block[: max(0, int(effective_budget * cpt))]))
            continue
        if buf_tokens + t > effective_budget:
            await flush()
        buf.append(block)
        buf_tokens += t
    await flush()
    return summaries


async def _summarize_middle(middle, *, budget, chars_per_token, summary_max_tokens, summarize):
    """Summarize the middle turns into a single note, map-reduce style so the
    summarizer input never exceeds the window."""
    prompt_tokens = estimate_text_tokens(SUMMARY_SYSTEM_PROMPT, chars_per_token)
    effective_budget = max(256, budget - summary_max_tokens - prompt_tokens - LMSTUDIO_MESSAGE_TOKEN_OVERHEAD)
    blocks = [serialize_message_for_summary(m) for m in middle]
    summaries = await _map_summarize(blocks, effective_budget, chars_per_token, summarize)
    passes = 0
    while len(summaries) > 1 and passes < MAX_REDUCE_PASSES:
        joined = "\n\n".join(summaries)
        if estimate_text_tokens(joined, chars_per_token) <= summary_max_tokens:
            return joined
        summaries = await _map_summarize(summaries, effective_budget, chars_per_token, summarize)
        passes += 1
    return "\n\n".join(summaries)


async def prepare_messages(*, messages, mode, budget, chars_per_token=None, summary_max_tokens=None, summarize):
    """Prepare a history for a fixed-window call, applying the configured strategy
    ONLY when the estimated prompt exceeds ``budget``. ``summarize(text)`` is an
    async callable injected by the caller (so this module needs no LLM client and
    stays testable). On any summarization failure we fall back to trimming so the
    run still proceeds."""
    budget_num = _to_number(budget)
    if not isinstance(messages, list) or budget_num is None or not (budget_num > 0) or mode == "none":
        return messages
    if _total_tokens(messages, chars_per_token) <= budget_num:  # only when bigger
        return messages
    if mode != "summarize":
        return trim_messages_for_budget(messages, budget_num, chars_per_token)

    reserve = _to_number(summary_max_tokens) or CONFIG.LMSTUDIO.summaryMaxTokens
    split = split_for_budget(messages, budget=budget_num, summary_reserve=reserve, chars_per_token=chars_per_token)
    head, middle, tail = split["head"], split["middle"], split["tail"]
    if not middle:
        return trim_messages_for_budget(messages, budget_num, chars_per_token)

    try:
        summary_text = await _summarize_middle(
            middle, budget=budget_num, chars_per_token=chars_per_token, summary_max_tokens=reserve, summarize=summarize
        )
    except Exception:
        return trim_messages_for_budget(messages, budget_num, chars_per_token)

    summary_msg = HumanMessage(f"{SUMMARY_MARKER}\n{summary_text}")
    return [*head, summary_msg, *tail]
