"""Port of the llm-relevant test from packages/shared/src/agent/omlx.test.js.

Scope note: the JS file mostly exercises ``model-presets``, ``availability``,
``diagnostics`` and ``local-intelligence`` — those cases belong to their own
module ports. Only the llm.py routing/resolution/factory case is ported here.
"""

from __future__ import annotations

import re

from ai_fleet.agent import llm


def settings(**overrides):
    base = {
        "llmProvider": "codex",
        "localLlmProvider": "omlx",
        "omlxHost": "http://127.0.0.1:8000",
        "omlxModel": "gpt-oss-20b",
        "omlxApiKey": "local-secret",
        "omlxContextWindow": 65536,
        "omlxNumTokens": 16384,
        "omlxTemperature": 1,
        "omlxTopP": 1,
        "omlxTopK": None,
        "omlxRepeatPenalty": None,
        "omlxReasoningEffort": "medium",
        "omlxReasoningAdapter": "omlx-template-effort",
        "omlxJsonMode": "json_schema",
        "omlxContextMode": "summarize",
    }
    base.update(overrides)
    return base


async def test_omlx_routes_through_local_slot_and_resolves_as_ready_openai_compatible_local_model():
    configured = settings(omlxHost="http://127.0.0.1:8000/")
    assert llm.provider_for_role(configured, "local") == "omlx"
    assert llm.provider_for_role(configured, "global") == "codex"

    d = await llm.resolve_llm(configured, "local")
    assert d["provider"] == "omlx"
    assert d["host"] == "http://127.0.0.1:8000"
    assert d["baseUrl"] == "http://127.0.0.1:8000/v1"
    assert d["model"] == "gpt-oss-20b"
    assert d["apiKey"] == "local-secret"
    assert d["contextWindow"] == 65536
    assert d["numTokens"] == 16384

    client = llm.create_chat_model(d, json=True)
    assert client.openai_api_key.get_secret_value() == "local-secret"
    assert client.openai_api_base == "http://127.0.0.1:8000/v1"
    assert client.model_kwargs["chat_template_kwargs"] == {"reasoning_effort": "medium"}
    assert client.model_kwargs["response_format"]["type"] == "json_schema"

    assert llm.llm_ready(settings(llmProvider="omlx")) is True
    assert llm.llm_ready(settings(llmProvider="omlx", omlxModel="")) is False
    assert re.search(r"OMLX.*host and model", llm.not_ready_reason({"llmProvider": "omlx"}), re.IGNORECASE)
