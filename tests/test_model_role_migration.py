"""Port of packages/shared/src/agent/model-role-migration.test.js.

Verifies read_store seeds/preserves the purpose model roles. The JS points the
store at a scratch dir via an env var read at import time; in Python config is
already imported, so we monkeypatch CONFIG.STORE_FILE / CONFIG.DATA_DIR onto a
tmp dir instead (never touching the real data/store.json, which holds secrets).
"""

from __future__ import annotations

import json
import os

import pytest

from ai_fleet.config import CONFIG
from ai_fleet.store import read_store
from ai_fleet.agent.model_presets import MODEL_ROLES


@pytest.fixture()
def scratch_store(tmp_path, monkeypatch):
    store_file = tmp_path / "store.json"
    monkeypatch.setattr(CONFIG, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(CONFIG, "STORE_FILE", str(store_file))
    # Hard guard: refuse to run unless the store resolves inside the scratch dir.
    assert CONFIG.STORE_FILE.startswith(str(tmp_path)), "store must resolve inside the scratch dir"
    return store_file


def _write_legacy_store(store_file, settings):
    store_file.write_text(json.dumps({"settings": settings}), encoding="utf-8")


def test_read_store_seeds_purpose_model_roles_from_legacy_store(scratch_store):
    _write_legacy_store(
        scratch_store,
        {"llmProvider": "claude", "hostedLlmPresetId": "claude-opus-4-8", "claudeModel": "claude-opus-4-8"},
    )
    store = read_store()
    for role in MODEL_ROLES:
        assert store["settings"][f"{role}LlmProvider"] == "claude", f"{role} provider"
        assert store["settings"][f"{role}LlmPresetId"] == "claude-opus-4-8", f"{role} preset"


def test_read_store_preserves_explicitly_configured_purpose_roles(scratch_store):
    _write_legacy_store(
        scratch_store,
        {
            "llmProvider": "claude",
            "hostedLlmPresetId": "claude-opus-4-8",
            "thinkingLlmProvider": "codex",
            "thinkingLlmPresetId": "codex-gpt-5-6-sol",
            "executionLlmProvider": "ollama",
            "executionLlmPresetId": "ollama-qwen3-coder-30b",
            "testingLlmProvider": "lmstudio",
            "testingLlmPresetId": "custom",
        },
    )
    store = read_store()
    assert store["settings"]["thinkingLlmProvider"] == "codex"
    assert store["settings"]["thinkingLlmPresetId"] == "codex-gpt-5-6-sol"
    assert store["settings"]["executionLlmProvider"] == "ollama"
    assert store["settings"]["executionLlmPresetId"] == "ollama-qwen3-coder-30b"
    assert store["settings"]["testingLlmProvider"] == "lmstudio"
