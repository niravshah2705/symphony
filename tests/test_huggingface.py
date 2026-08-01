"""Port of the llm-relevant tests from packages/shared/src/agent/huggingface.test.js.

Scope note: the JS file also exercises ``model-presets`` (catalog) and
``availability`` (probe) modules — those cases belong to their own module ports
and are omitted here. The ``resolveLlm`` / ``llmReady`` / ``notReadyReason`` /
``createChatModel`` cases (llm.py) are ported faithfully.
"""

from __future__ import annotations

import re

from langchain_openai import ChatOpenAI

from ai_fleet.agent import llm

SETTINGS = {
    "thinkingLlmProvider": "huggingface",
    "huggingfaceHost": "https://router.huggingface.co",
    "huggingfaceApiKey": "hf_test_token",
    "huggingfaceModel": "meta-llama/Llama-3.3-70B-Instruct",
    "huggingfaceMaxTokens": 8192,
    "huggingfaceTemperature": 0.7,
    "huggingfaceReasoningEffort": "none",
    "huggingfaceReasoningAdapter": "none",
}


async def test_resolve_llm_builds_hosted_openai_compatible_descriptor():
    d = await llm.resolve_llm(SETTINGS, "thinking")
    assert d["provider"] == "huggingface"
    assert d["baseUrl"] == "https://router.huggingface.co/v1"  # apiPath appended
    assert d["apiKey"] == "hf_test_token"
    assert d["model"] == "meta-llama/Llama-3.3-70B-Instruct"
    assert d["numTokens"] == 8192


async def test_resolve_llm_strips_trailing_v1_before_reappending():
    d = await llm.resolve_llm({**SETTINGS, "huggingfaceHost": "https://router.huggingface.co/v1/"}, "thinking")
    assert d["baseUrl"] == "https://router.huggingface.co/v1"


def test_llm_ready_requires_token_and_model_and_reason_names_huggingface():
    assert llm.llm_ready(SETTINGS, "thinking") is True
    assert llm.llm_ready({**SETTINGS, "huggingfaceApiKey": ""}, "thinking") is False  # token mandatory
    assert llm.llm_ready({**SETTINGS, "huggingfaceModel": ""}, "thinking") is False
    assert re.search(r"Hugging Face", llm.not_ready_reason({"thinkingLlmProvider": "huggingface"}, "thinking"))


async def test_create_chat_model_returns_a_chatopenai_targeting_the_router():
    d = await llm.resolve_llm(SETTINGS, "thinking")
    model = llm.create_chat_model(d, json=True)
    # Wrapped in the shared managed base (adds stream retry) — still a ChatOpenAI.
    assert isinstance(model, ChatOpenAI)
    assert (getattr(model, "model", None) or getattr(model, "model_name", None)) == "meta-llama/Llama-3.3-70B-Instruct"
