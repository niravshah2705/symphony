"""Port of packages/shared/src/agent/availability.test.js.

The JS test imports ``AgentError`` (./plan), ``RepositoryBrokerError``
(./repository-broker), and ``AgentRuntimeError`` (./runtimes). Those modules are
not part of this port, so lightweight stand-ins reproduce exactly the shape the
classifier inspects (``name`` / ``code`` / ``status`` / ``cause`` / ``message``).
"""

import json

import pytest

from ai_fleet.agent.availability import (
    AgentAvailabilityError,
    is_model_availability_error,
    is_repository_availability_error,
    pause_reason_for,
    probe_model_availability,
    probe_repository_availability,
)


# --- stand-in error classes (see module docstring) ------------------------- #
class AgentError(Exception):
    def __init__(self, message, status=500, opts=None):
        super().__init__(message)
        opts = opts or {}
        self.name = "AgentError"
        self.message = message
        self.status = status
        self.code = opts.get("code")
        self.cause = opts.get("cause")


class AgentRuntimeError(Exception):
    def __init__(self, message, code, status=500, opts=None):
        super().__init__(message)
        opts = opts or {}
        self.name = "AgentRuntimeError"
        self.message = message
        self.code = code
        self.status = status
        self.cause = opts.get("cause")


class RepositoryBrokerError(Exception):
    def __init__(self, message, code):
        super().__init__(message)
        self.name = "RepositoryBrokerError"
        self.message = message
        self.code = code


def _err_with(message, **attrs):
    """JS ``Object.assign(new Error(message), attrs)``."""
    err = Exception(message)
    err.message = message
    for key, value in attrs.items():
        setattr(err, key, value)
    return err


def _date_utc_ms(year, month0, day):
    from datetime import datetime, timezone

    return int(datetime(year, month0 + 1, day, tzinfo=timezone.utc).timestamp() * 1000)


class Response:
    def __init__(self, status, body):
        self.ok = 200 <= status < 300
        self.status = status
        self._body = body

    async def json(self):
        return self._body


def response(status, body):
    return Response(status, body)


# --------------------------------------------------------------------------- #
def test_pause_reasons_expose_a_stable_nontechnical_ui_contract():
    reason = pause_reason_for(
        "git",
        Exception("git push https://token@example.test failed with 403"),
        {"provider": "gitlab", "taskIdentifier": "ENG-9"},
        _date_utc_ms(2026, 6, 17),
    )
    assert reason == {
        "code": "git-unavailable",
        "resource": "git",
        "message": "GitLab repository access is unavailable. Check the repository and token in Settings, then resume agent jobs.",
        "since": "2026-07-17T00:00:00.000Z",
        "taskIdentifier": "ENG-9",
        "provider": "gitlab",
    }
    serialized = json.dumps(reason)
    assert "token@example" not in serialized
    assert "git push" not in serialized
    assert "403" not in serialized


async def test_repository_preflight_converts_provider_403_into_sanitized_error():
    request = {}

    async def fetch_impl(url, options=None):
        request["url"] = url
        request["options"] = options
        return response(403, {"message": "raw provider detail"})

    with pytest.raises(AgentAvailabilityError) as excinfo:
        await probe_repository_availability(
            {"provider": "github", "repoRef": "acme/app", "token": "stored-secret"},
            {"fetch_impl": fetch_impl},
        )
    error = excinfo.value
    assert error.resource == "git"
    assert error.status == 403
    assert "raw provider detail" not in error.message
    assert "stored-secret" not in error.message
    assert request["url"] == "https://api.github.com/repos/acme/app"
    assert request["options"]["headers"]["Authorization"] == "Bearer stored-secret"
    assert request["options"]["redirect"] == "error"


async def test_repository_preflight_requires_write_permission_before_dispatch():
    async def fetch_impl(url, options=None):
        return response(200, {"permissions": {"pull": True, "push": False}})

    with pytest.raises(AgentAvailabilityError) as excinfo:
        await probe_repository_availability(
            {"provider": "github", "repoRef": "acme/app", "token": "stored-secret"},
            {"fetch_impl": fetch_impl},
        )
    assert excinfo.value.code == "git_write_unavailable"
    assert excinfo.value.status == 403


async def test_local_model_preflight_verifies_that_the_selected_model_is_loaded():
    async def missing(url, options=None):
        return response(200, {"models": [{"name": "another:latest"}]})

    with pytest.raises(AgentAvailabilityError) as excinfo:
        await probe_model_availability(
            {"provider": "ollama", "host": "http://localhost:11434", "model": "wanted:latest"},
            {"fetch_impl": missing},
        )
    assert excinfo.value.resource == "model"
    assert excinfo.value.code == "model_not_found"

    async def loaded(url, options=None):
        return response(200, {"data": [{"id": "local-coder"}]})

    ready = await probe_model_availability(
        {"provider": "lmstudio", "host": "http://localhost:1234", "model": "local-coder"},
        {"fetch_impl": loaded},
    )
    assert ready == {"available": True, "provider": "lmstudio", "model": "local-coder"}


def test_model_classifier_recognizes_hosted_auth_and_network_failures():
    assert is_model_availability_error({"status": 403}) is True
    assert is_model_availability_error({"code": "ECONNREFUSED"}) is True
    assert is_model_availability_error(AgentError("Plan failed validation.", 502, {"code": "model_output_invalid"})) is False
    assert (
        is_model_availability_error(
            AgentError(
                "Model call failed.",
                502,
                {"code": "model_call_failed", "cause": _err_with("connection refused", code="ECONNREFUSED")},
            )
        )
        is True
    )
    assert (
        is_model_availability_error(
            AgentRuntimeError(
                "SDK execution failed.",
                "runtime_execution_failed",
                502,
                {"cause": _err_with("Request failed with HTTP 403")},
            )
        )
        is True
    )
    assert is_model_availability_error(Exception("ordinary workflow assertion failed")) is False


def test_repository_classifier_distinguishes_remote_outages_from_local_errors():
    assert (
        is_repository_availability_error(RepositoryBrokerError("Repository provider returned 403.", "provider_error"))
        is True
    )
    assert (
        is_repository_availability_error(
            RepositoryBrokerError("Unable to access remote: connection refused.", "git_failed")
        )
        is True
    )
    for code in ["workspace_dirty", "review_blocked", "invalid_input", "branch_scope", "git_failed"]:
        message = "fatal: .git/index: Permission denied" if code == "git_failed" else f"ordinary {code} failure"
        assert is_repository_availability_error(RepositoryBrokerError(message, code)) is False, f"{code} must not pause every project"
