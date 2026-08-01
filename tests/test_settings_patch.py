"""Port of packages/shared/src/agent/settings-patch.test.js."""

import pytest

from ai_fleet.agent.settings_patch import (
    EDITABLE_KEYS,
    apply_settings_patch,
    describe_editable_settings,
    sanitize_settings_patch,
    snapshot_editable,
)


def test_sanitize_accepts_valid_keys_and_coerces_values():
    result = sanitize_settings_patch(
        {
            "agentRuntime": "codex-sdk",
            "workflowPattern": "supervisor",
            "langsmithTracing": False,
            "llmProvider": "ollama",
            "ollamaTemperature": 5,  # clamped to 2
            "langsmithEndpoint": "https://api.smith.langchain.com/",  # trailing slash trimmed
        }
    )
    patch = result["patch"]
    assert patch["agentRuntime"] == "codex-sdk"
    assert patch["workflowPattern"] == "supervisor"
    assert patch["langsmithTracing"] is False
    assert patch["ollamaTemperature"] == 2
    assert patch["langsmithEndpoint"] == "https://api.smith.langchain.com"
    assert "agentRuntime" in result["applied"]


def test_sanitize_rejects_invalid_enum_provider_values_with_reasons():
    result = sanitize_settings_patch(
        {
            "agentRuntime": "not-a-runtime",
            "workflowPattern": "nope",
            "localLlmProvider": "codex",  # not a local provider
        }
    )
    keys = sorted(r["key"] for r in result["rejected"])
    assert keys == ["agentRuntime", "localLlmProvider", "workflowPattern"]
    for r in result["rejected"]:
        assert isinstance(r["reason"], str)


def test_sanitize_ignores_unknown_derived_and_secret_keys():
    result = sanitize_settings_patch(
        {
            "hasKey": True,
            "maskedKey": "****",
            "planningConfigured": True,
            "linearApiKey": "lin_live_secret",
            "langsmithApiKey": "lsv2_secret",
            "githubToken": "ghp_secret",
            "totallyUnknown": 1,
        }
    )
    assert result["patch"] == {}
    for key in ["hasKey", "linearApiKey", "langsmithApiKey", "githubToken", "totallyUnknown"]:
        assert key in result["ignored"], f"{key} should be ignored"


def test_editable_keys_never_exposes_secret_material():
    secrets = [
        "linearApiKey",
        "githubToken",
        "gitlabToken",
        "langsmithApiKey",
        "jiraApiToken",
        "asanaAccessToken",
        "omlxApiKey",
        "codexTokens",
        "claudeTokens",
    ]
    for secret in secrets:
        assert secret not in EDITABLE_KEYS, f"{secret} must not be editable via JSON/tool"


def test_snapshot_editable_keeps_only_editable_keys():
    snapshot = snapshot_editable(
        {
            "agentRuntime": "deepagent",
            "langsmithProject": "demo",
            "linearApiKey": "secret",
            "unknownKey": "x",
        }
    )
    assert snapshot == {"agentRuntime": "deepagent", "langsmithProject": "demo"}


def test_describe_editable_settings_lists_keys_and_harness_enum_mapping():
    text = describe_editable_settings()
    assert "agentRuntime" in text
    assert "claude-agent-sdk=ClaudeCode" in text
    assert "langsmithTracing: true | false" in text


def test_apply_persists_valid_keys_and_skips_empty_patches(tmp_path, monkeypatch):
    # Isolate any store writes to a throwaway data dir. The real data/store.json
    # holds live secrets and must never be touched by tests.
    from ai_fleet.config import CONFIG
    from ai_fleet import store

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(CONFIG, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(CONFIG, "STORE_FILE", str(data_dir / "store.json"))

    outcome = apply_settings_patch({"agentRuntime": "codex-sdk", "langsmithTracing": False, "hasKey": True})
    assert sorted(outcome["applied"]) == ["agentRuntime", "langsmithTracing"]
    assert store.get_settings()["agentRuntime"] == "codex-sdk"
    assert store.get_settings()["langsmithTracing"] is False

    # A patch with no valid keys writes nothing and does not throw.
    noop = apply_settings_patch({"linearApiKey": "x", "unknownKey": 1})
    assert len(noop["applied"]) == 0
    assert store.get_settings()["agentRuntime"] == "codex-sdk"
