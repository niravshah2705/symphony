"""Retry for transient / in-stream LLM errors (port of agent/llm-retry.js).

The provider SDKs retry connection-level and pre-response failures (their own
``maxRetries``), but NOT an error that arrives AFTER a successful ``200`` — e.g.
OpenAI's streaming layer raises an ``APIError`` (with no HTTP status) when the
SSE body carries an ``error`` event mid-generation ("An error occurred while
processing your request"). Those surface straight through LangChain to the
caller and are exactly the flaky failures worth one more attempt.

This module is provider-agnostic and side-effect free (logging is injected via
``on_retry``) so it stays pure and testable. ``run_with_retry`` wraps a
``_generate`` (aggregated) call; ``stream_with_retry`` wraps a streaming
generator and only retries BEFORE the first chunk is yielded — once tokens have
reached the caller, re-running would duplicate output, so the error is re-raised.

Python note: the JS matches Node/undici socket error codes. Here we additionally
match httpx transport/timeout exceptions and the builtin ``ConnectionError``
family, since those are how transient network failures surface in Python. httpx
is imported lazily so the module works without it installed.
"""

from __future__ import annotations

import math

# HTTP statuses worth retrying (transient server/rate-limit/timeout conditions).
# 4xx client errors other than 408/409/429 are deliberately excluded — retrying
# a 400/401/404 just repeats a deterministic failure.
RETRYABLE_STATUS = frozenset([408, 409, 429, 500, 502, 503, 504, 529])

# Socket/connection error codes that can interrupt an in-flight stream.
RETRYABLE_CODES = frozenset([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EPIPE",
    "ERR_STREAM_PREMATURE_CLOSE",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
])


def _get(err, key):
    """Read ``key`` off an error whether it is a dict or an object/exception."""
    if err is None:
        return None
    if isinstance(err, dict):
        return err.get(key)
    return getattr(err, key, None)


def _status_of(err):
    if err is None:
        return None
    # err.status ?? err.statusCode ?? err.status_code ?? err.response?.status
    for key in ("status", "statusCode", "status_code"):
        value = _get(err, key)
        if value is not None:
            return value
    response = _get(err, "response")
    if response is not None:
        return _get(response, "status") or _get(response, "status_code")
    return None


def _code_of(err):
    if err is None:
        return None
    code = _get(err, "code")
    if code is not None:
        return code
    cause = _get(err, "cause")
    if cause is not None:
        return _get(cause, "code")
    return None


def _name_of(err):
    if err is None:
        return ""
    name = _get(err, "name")
    if name:
        return name
    return type(err).__name__


def _finite_number(value):
    """Mirror JS ``Number(x)`` + ``Number.isFinite``; return None when not finite."""
    if value is None or isinstance(value, bool):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(num) or math.isinf(num):
        return None
    return num


def _is_transport_error(err):
    """httpx transport/timeout exceptions and the builtin ConnectionError family."""
    if isinstance(err, ConnectionError):  # builtin (ECONNRESET etc. surface here)
        return True
    try:
        import httpx  # lazy: module must work without network deps installed
    except Exception:
        return False
    return isinstance(err, (httpx.TransportError, httpx.TimeoutException))


def is_retryable_stream_error(err) -> bool:
    """Whether an error looks transient and safe to retry."""
    if err is None:
        return False
    status = _finite_number(_status_of(err))
    if status is not None and int(status) in RETRYABLE_STATUS:
        return True
    if _is_transport_error(err):
        return True
    # A provider stream `error` event surfaces as an APIError with NO HTTP status
    # (the request already returned 200). This is the specific gap SDK retries miss.
    name = _name_of(err)
    if name in ("APIError", "OpenAIError") and status is None:
        return True
    if _code_of(err) in RETRYABLE_CODES:
        return True
    return False


def _coerce_retries(retries) -> int:
    """JS ``Number.isFinite(Number(retries)) ? max(0, floor(Number(retries))) : 0``."""
    num = _finite_number(retries)
    if num is None:
        return 0
    return max(0, math.floor(num))


async def run_with_retry(fn, retries, on_retry=None):
    """Run an awaitable, retrying up to ``retries`` times on a transient error.

    ``fn`` is an async callable. ``retries`` is additional attempts after the
    first (0 = no retry). ``on_retry(err, attempt)`` is an optional callback.
    """
    max_retries = _coerce_retries(retries)
    attempt = 0
    while True:
        try:
            return await fn()
        except Exception as err:
            if attempt >= max_retries or not is_retryable_stream_error(err):
                raise
            attempt += 1
            if on_retry:
                on_retry(err, attempt)


async def stream_with_retry(make_stream, retries, on_retry=None):
    """Wrap a streaming generator, retrying only until the first chunk is yielded.

    ``make_stream`` MUST return a FRESH async iterable each call (a new request).
    Once output has started, re-running would duplicate emitted tokens, so the
    error is re-raised instead of retried.
    """
    max_retries = _coerce_retries(retries)
    attempt = 0
    while True:
        yielded = False
        try:
            async for chunk in make_stream():
                yielded = True
                yield chunk
            return
        except Exception as err:
            # Never retry once output has started (would duplicate emitted tokens).
            if yielded or attempt >= max_retries or not is_retryable_stream_error(err):
                raise
            attempt += 1
            if on_retry:
                on_retry(err, attempt)
