"""Port of packages/shared/src/agent/llm-retry.test.js."""

import pytest

from ai_fleet.agent.llm_retry import (
    is_retryable_stream_error,
    run_with_retry,
    stream_with_retry,
)


class APIError(Exception):
    """Mirrors the JS APIError shape: a named error with an optional HTTP status.

    When ``status`` is None the instance carries no ``.status`` attribute, matching
    the in-stream OpenAI error (a 200 already returned, so there is no status).
    """

    def __init__(self, message="", status=None):
        super().__init__(message)
        if status is not None:
            self.status = status


def _api_stream_error():
    return APIError("An error occurred while processing your request.")


# ----------------------- is_retryable_stream_error ------------------------

def test_openai_in_stream_error_apierror_no_status_is_retryable():
    # The exact shape thrown from openai streaming when the SSE body carries an
    # `error` event mid-generation — the gap SDK retries miss.
    assert is_retryable_stream_error(_api_stream_error()) is True


def test_transient_http_statuses_are_retryable():
    for status in [429, 500, 502, 503, 504, 529]:
        assert is_retryable_stream_error({"status": status}) is True, f"status {status}"


def test_deterministic_client_errors_are_not_retryable():
    for status in [400, 401, 403, 404, 422]:
        err = APIError("nope", status=status)
        assert is_retryable_stream_error(err) is False, f"status {status}"


def test_dropped_connection_error_codes_are_retryable():
    assert is_retryable_stream_error({"code": "ECONNRESET"}) is True
    assert is_retryable_stream_error({"cause": {"code": "UND_ERR_SOCKET"}}) is True


def test_ordinary_error_with_no_signal_is_not_retryable():
    assert is_retryable_stream_error(Exception("boom")) is False
    assert is_retryable_stream_error(None) is False


def test_httpx_transport_and_timeout_errors_are_retryable():
    httpx = pytest.importorskip("httpx")
    assert is_retryable_stream_error(httpx.ConnectError("refused")) is True
    assert is_retryable_stream_error(httpx.ReadTimeout("slow")) is True


def test_builtin_connection_error_family_is_retryable():
    assert is_retryable_stream_error(ConnectionResetError("reset")) is True


# ------------------------------ run_with_retry ---------------------------

async def test_run_with_retry_returns_first_success_without_retrying():
    calls = 0

    async def fn():
        nonlocal calls
        calls += 1
        return "ok"

    out = await run_with_retry(fn, 1)
    assert out == "ok"
    assert calls == 1


async def test_run_with_retry_retries_once_then_succeeds():
    calls = 0
    attempts = []

    async def fn():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise _api_stream_error()
        return "recovered"

    out = await run_with_retry(fn, 1, lambda err, attempt: attempts.append(attempt))
    assert out == "recovered"
    assert calls == 2
    assert attempts == [1]


async def test_run_with_retry_gives_up_after_exhausting_retries():
    calls = 0

    async def fn():
        nonlocal calls
        calls += 1
        raise _api_stream_error()

    with pytest.raises(APIError, match="An error occurred"):
        await run_with_retry(fn, 2)
    assert calls == 3  # 1 initial + 2 retries


async def test_run_with_retry_does_not_retry_a_non_retryable_error():
    calls = 0
    not_retryable = APIError("bad request", status=400)

    async def fn():
        nonlocal calls
        calls += 1
        raise not_retryable

    with pytest.raises(APIError, match="bad request"):
        await run_with_retry(fn, 3)
    assert calls == 1


async def test_run_with_retry_with_zero_retries_never_retries():
    calls = 0

    async def fn():
        nonlocal calls
        calls += 1
        raise _api_stream_error()

    with pytest.raises(APIError):
        await run_with_retry(fn, 0)
    assert calls == 1


# ---------------------------- stream_with_retry --------------------------

async def _from_list(items):
    for item in items:
        yield item


async def test_stream_with_retry_passes_chunks_through_on_success():
    out = []
    async for chunk in stream_with_retry(lambda: _from_list([1, 2, 3]), 1):
        out.append(chunk)
    assert out == [1, 2, 3]


async def test_stream_with_retry_retries_when_failing_before_first_chunk():
    attempts = 0

    def make_stream():
        nonlocal attempts
        attempts += 1

        async def gen():
            if attempts == 1:
                raise _api_stream_error()
            yield "a"
            yield "b"

        return gen()

    out = []
    async for chunk in stream_with_retry(make_stream, 1):
        out.append(chunk)
    assert out == ["a", "b"]
    assert attempts == 2


async def test_stream_with_retry_does_not_retry_after_a_chunk_yielded():
    attempts = 0

    def make_stream():
        nonlocal attempts
        attempts += 1

        async def gen():
            yield "partial"
            raise _api_stream_error()

        return gen()

    out = []
    with pytest.raises(APIError, match="An error occurred"):
        async for chunk in stream_with_retry(make_stream, 3):
            out.append(chunk)
    assert out == ["partial"]
    assert attempts == 1
