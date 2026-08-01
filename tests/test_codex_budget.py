"""Port of packages/shared/src/agent/codex-budget.test.js."""

from __future__ import annotations

from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage

from ai_fleet.config import CONFIG
from ai_fleet.agent.llm import (
    create_chat_model,
    resolve_llm,
    codex_max_tokens,
    codex_prompt_budget,
    clamp_stream_retries,
)


# ----------------------------- codex_max_tokens -------------------------- #

def test_codex_max_tokens_reserves_requested_output_floored_at_256():
    assert codex_max_tokens({"numTokens": 65536}) == 65536
    assert codex_max_tokens({"numTokens": 10}) == 256
    assert codex_max_tokens({}) == 4096


# --------------------------- codex_prompt_budget ------------------------- #

def test_codex_prompt_budget_reserves_output_cap_plus_margin():
    budget = codex_prompt_budget({"contextWindow": 272000, "numTokens": 65536})
    assert budget == 272000 - 65536 - CONFIG.OAUTH.promptMarginTokens


def test_codex_prompt_budget_returns_zero_when_no_window():
    assert codex_prompt_budget({"numTokens": 65536}) == 0


def test_codex_prompt_budget_never_negative_on_tiny_window():
    assert codex_prompt_budget({"contextWindow": 512, "numTokens": 65536}) == 0


# --------------------------- clamp_stream_retries ------------------------ #

def test_clamp_stream_retries_bounds_and_defaults():
    assert clamp_stream_retries(2) == 2
    assert clamp_stream_retries(-4) == 0
    assert clamp_stream_retries(999) == 5  # MAX_STREAM_RETRIES
    assert clamp_stream_retries(1.7) == 2  # rounded
    assert clamp_stream_retries("nope") == CONFIG.LLM_STREAM_RETRIES
    assert clamp_stream_retries(None) == CONFIG.LLM_STREAM_RETRIES


# ------------------------------ resolve_llm ------------------------------ #

async def test_resolve_llm_surfaces_stream_retry_knob_on_every_descriptor():
    d = await resolve_llm(
        {
            "llmProvider": "lmstudio",
            "lmstudioModel": "ornith-1.0-35b",
            "lmstudioContextWindow": 32768,
            "llmStreamRetries": 3,
        }
    )
    assert d["streamRetries"] == 3


async def test_resolve_llm_defaults_stream_retry_knob_to_configured_default():
    d = await resolve_llm({"llmProvider": "lmstudio", "lmstudioModel": "x", "lmstudioContextWindow": 8192})
    assert d["streamRetries"] == CONFIG.LLM_STREAM_RETRIES


# ---------------- Codex model prompt budget + rewrite -------------------- #

def _codex_descriptor(**overrides):
    d = {
        "provider": "codex",
        "backend": "chatgpt",
        "model": "gpt-5.6-sol",
        "baseUrl": "https://chatgpt.com/backend-api/codex",
        "accessToken": "test-access-token",
        "accountId": "acct_test",
        "numTokens": 256,
        "contextWindow": 0,
        "contextMode": "trim",
        "streamRetries": 1,
        "reasoningAdapter": "none",
        "reasoningEffort": None,
    }
    d.update(overrides)
    return d


def _long_convo():
    return [
        SystemMessage("S" * 400),
        HumanMessage("H" * 400),
        AIMessage(content="", tool_calls=[{"id": "1", "name": "read", "args": {"path": "a.js"}}]),
        ToolMessage(content="T" * 20000, tool_call_id="1"),
        AIMessage(content="", tool_calls=[{"id": "2", "name": "read", "args": {"path": "b.js"}}]),
        ToolMessage(content="T" * 20000, tool_call_id="2"),
        AIMessage("final summary of the work done"),
    ]


def test_create_chat_model_wires_codex_budget_and_stream_retry():
    llm = _codex_descriptor(contextWindow=272000, numTokens=65536, streamRetries=2)
    model = create_chat_model(llm)
    assert model.prompt_budget == codex_prompt_budget(llm)
    assert model.context_mode == "trim"
    assert model.stream_retries == 2
    assert model.retry_provider == "codex"


async def test_codex_prepare_messages_rewrites_system_but_keeps_fitting_history():
    # No context window → budget 0 → no trimming, only the system→developer rewrite.
    model = create_chat_model(_codex_descriptor())
    convo = _long_convo()
    out = await model._prepare_messages(convo)
    assert len(out) == len(convo)
    assert out[0].role == "developer"  # system rewritten
    assert out[0].type == "chat"  # ChatMessage (JS _getType() == 'generic')
    assert out[3] is convo[3]  # untouched messages keep their identity


async def test_codex_prepare_messages_trims_middle_on_overflow():
    # 4602 window, 256 output reserve, 4096 margin → 250-token budget: the two large
    # tool results cannot fit, so the middle is dropped (head + most recent turn kept).
    model = create_chat_model(_codex_descriptor(contextWindow=4602, numTokens=256, contextMode="trim"))
    convo = _long_convo()
    tool1, tool2, last_ai = convo[3], convo[5], convo[6]
    out = await model._prepare_messages(convo)
    assert out[0].role == "developer"  # system still rewritten
    assert out[-1] is last_ai
    assert tool1 not in out and tool2 not in out
    assert len(out) < len(convo)
