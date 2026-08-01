"""Port of packages/shared/src/agent/diagnostics.test.js."""

import json
from types import SimpleNamespace

from ai_fleet.agent import diagnostics


def _response(status=200):
    return SimpleNamespace(ok=200 <= status < 300, status=status, body=None)


configured_settings = {
    "planningProvider": "jira",
    "jiraBaseUrl": "https://jira.example.com",
    "jiraEmail": "person@example.com",
    "jiraApiToken": "jira-secret",
    "repositoryProvider": "gitlab",
    "repositoryUrl": "group/project",
    "gitlabToken": "gitlab-secret",
    "langsmithTracing": True,
    "langsmithApiKey": "langsmith-secret",
    "langsmithProject": "project",
    "localLlmProvider": "ollama",
    "ollamaHost": "http://127.0.0.1:11434",
    "ollamaModel": "local-model",
    "codexTokens": {"accessToken": "codex-secret"},
    "claudeTokens": {"refreshToken": "claude-secret"},
}


def test_endpoint_builder_removes_credentials_and_replaces_path():
    assert (
        diagnostics.endpoint("https://user:password@example.com/internal?token=secret", "/health")
        == "https://example.com/health"
    )
    assert diagnostics.endpoint("file:///tmp/socket", "/health") is None


def test_package_detection_uses_find_spec_and_injected_resolver():
    # Default resolver (importlib.util.find_spec): an installed stdlib module
    # resolves; a bogus name does not.
    assert diagnostics.package_available("json") is True
    assert diagnostics.package_available("definitely_not_a_real_pkg_xyz") is False
    # Injected resolver seam: a returned path == installed; a raise == missing.
    assert diagnostics.package_available("@scope/esm-sdk", lambda n: "/workspace/node_modules/pkg") is True

    def boom(_name):
        raise RuntimeError("missing")

    assert diagnostics.package_available("@scope/missing-sdk", boom) is False


async def test_diagnostics_report_without_secrets():
    requested = []

    async def fake_fetch(url, options=None):
        requested.append(url)
        return _response(200)

    async def fake_log_tail(_file, _max_bytes):
        return {"text": "[2026-07-16T11:59:00.000Z] INFO  Ready\n", "bytesRead": 42, "exists": True}

    report = await diagnostics.run_diagnostics(
        configured_settings,
        {
            "services": {"plannerUrl": "http://planner.internal:4010", "coderUrl": "http://coder.internal:4020"},
            "fetch": fake_fetch,
            "resolvePackage": lambda _n: "/installed/package.js",
            "readLogTail": fake_log_tail,
            "now": "2026-07-16T12:00:00.000Z",
        },
    )

    assert report["status"] == "healthy"
    assert report["generatedAt"] == "2026-07-16T12:00:00.000Z"
    assert sorted(requested) == [
        "http://127.0.0.1:11434/api/tags",
        "http://coder.internal:4020/api/coder",
        "http://planner.internal:4010/api/agent/status",
    ]
    ids = {item["id"] for item in report["checks"]}
    for id in [
        "planner-service", "coder-service", "local-model", "planning-integration", "repository-integration",
        "service-log", "langsmith-integration", "deepagents-sdk", "codex-sdk", "claude-sdk",
    ]:
        assert id in ids, id

    serialized = json.dumps(report)
    for secret in ["jira-secret", "gitlab-secret", "langsmith-secret", "codex-secret", "claude-secret"]:
        assert secret not in serialized
    assert "planner.internal" not in serialized


async def test_diagnostics_distinguish_unavailable_endpoints_and_missing_sdk():
    async def fake_fetch(_url, _options=None):
        raise RuntimeError("connection refused with private detail")

    async def fake_log_tail(_file, _max_bytes):
        return {"text": "[2026-07-16T11:59:00.000Z] ERROR secret detail omitted\n", "bytesRead": 60, "exists": True}

    def resolve_raises(_name):
        raise RuntimeError("missing")

    report = await diagnostics.run_diagnostics(
        {
            "localLlmProvider": "lmstudio",
            "lmstudioHost": "http://localhost:1234",
            "lmstudioModel": "model",
            "planningProvider": "linear",
            "repositoryProvider": "github",
        },
        {
            "services": {"plannerUrl": "http://localhost:4010", "coderUrl": "http://localhost:4020"},
            "fetch": fake_fetch,
            "resolvePackage": resolve_raises,
            "readLogTail": fake_log_tail,
        },
    )

    assert report["status"] == "degraded"
    assert next(item for item in report["checks"] if item["id"] == "planner-service")["status"] == "unavailable"
    assert next(item for item in report["checks"] if item["id"] == "codex-sdk")["details"]["installed"] is False
    assert "private detail" not in json.dumps(report)
