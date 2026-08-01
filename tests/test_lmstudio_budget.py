"""Port of packages/shared/src/agent/lmstudio-budget.test.js."""

from __future__ import annotations

from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage

from ai_fleet.agent.llm import (
    lmstudio_max_tokens,
    resolve_llm,
    lmstudio_prompt_budget,
    clamp_context_window,
    trim_messages_for_budget,
    estimate_message_tokens,
)


# --------------------------- lmstudio_max_tokens ------------------------- #

def test_lmstudio_max_tokens_caps_output_at_half_the_window():
    # 16000 requested, 8192 window → half = 4096.
    assert lmstudio_max_tokens({"numTokens": 16000, "contextWindow": 8192}) == 4096


def test_lmstudio_max_tokens_keeps_requested_when_it_fits():
    # 16000 requested, 40960 window → half = 20480 ≥ 16000, keep 16000.
    assert lmstudio_max_tokens({"numTokens": 16000, "contextWindow": 40960}) == 16000


def test_lmstudio_max_tokens_never_returns_less_than_256():
    assert lmstudio_max_tokens({"numTokens": 16000, "contextWindow": 512}) == 256


def test_lmstudio_max_tokens_defaults_missing_window_to_8192():
    assert lmstudio_max_tokens({"numTokens": 16000}) == 4096


# ----------------------------- resolve_llm ------------------------------- #

async def test_resolve_llm_surfaces_lmstudio_context_window():
    llm = await resolve_llm(
        {
            "llmProvider": "lmstudio",
            "lmstudioHost": "http://localhost:1234",
            "lmstudioModel": "ornith-1.0-35b",
            "lmstudioContextWindow": 32768,
            "lmstudioNumTokens": 16000,
        }
    )
    assert llm["provider"] == "lmstudio"
    assert llm["contextWindow"] == 32768
    assert lmstudio_max_tokens(llm) == 16000  # half of 32768 = 16384 ≥ 16000


# -------------------------- lmstudio_prompt_budget ----------------------- #

def test_lmstudio_prompt_budget_reserves_output_cap_plus_margin():
    # 129536 window, output cap 16000 (half=64768 ≥ 16000), 1024 margin → 112512.
    assert lmstudio_prompt_budget({"contextWindow": 129536, "numTokens": 16000}) == 112512


def test_lmstudio_prompt_budget_returns_zero_when_no_window():
    assert lmstudio_prompt_budget({"numTokens": 16000}) == 0


def test_lmstudio_prompt_budget_never_negative_on_tiny_window():
    # 512 window, output cap 256, 1024 margin → clamped to 0.
    assert lmstudio_prompt_budget({"contextWindow": 512, "numTokens": 16000}) == 0


# ---------------------------- clamp_context_window ----------------------- #

def test_clamp_context_window_uses_loaded_when_smaller_than_configured():
    # The real bug: configured 129536 but model loaded at 8192.
    assert clamp_context_window(129536, 8192) == 8192


def test_clamp_context_window_respects_configured_smaller_than_loaded():
    assert clamp_context_window(4096, 8192) == 4096


def test_clamp_context_window_falls_back_to_configured_when_loaded_unknown():
    assert clamp_context_window(129536, None) == 129536


def test_clamp_context_window_uses_loaded_when_nothing_configured():
    assert clamp_context_window(0, 8192) == 8192


# ------------------------- trim_messages_for_budget ---------------------- #

CPT = 4  # chars-per-token for deterministic test arithmetic


def _build_convo():
    return [
        SystemMessage("S" * 400),
        HumanMessage("H" * 400),
        AIMessage(content="", tool_calls=[{"id": "1", "name": "read", "args": {"path": "a.js"}}]),
        ToolMessage(content="T" * 20000, tool_call_id="1"),
        AIMessage(content="", tool_calls=[{"id": "2", "name": "read", "args": {"path": "b.js"}}]),
        ToolMessage(content="T" * 20000, tool_call_id="2"),
        AIMessage("final summary of the work done"),
    ]


def test_trim_returns_history_unchanged_when_it_fits():
    msgs = _build_convo()
    assert trim_messages_for_budget(msgs, 1_000_000, CPT) is msgs


def test_trim_is_pass_through_when_disabled_budget_zero():
    msgs = _build_convo()
    assert trim_messages_for_budget(msgs, 0, CPT) is msgs


def test_trim_keeps_system_first_human_most_recent_drops_middle():
    msgs = _build_convo()
    sys, human, last_ai = msgs[0], msgs[1], msgs[6]
    budget = estimate_message_tokens(sys, CPT) + estimate_message_tokens(human, CPT) + estimate_message_tokens(last_ai, CPT) + 5
    out = trim_messages_for_budget(msgs, budget, CPT)
    assert out == [sys, human, last_ai]


def test_trim_never_leaves_orphaned_tool_result_leading_the_tail():
    msgs = _build_convo()
    sys, human, tool1, tool2, last_ai = msgs[0], msgs[1], msgs[3], msgs[5], msgs[6]
    budget = (
        estimate_message_tokens(sys, CPT)
        + estimate_message_tokens(human, CPT)
        + estimate_message_tokens(last_ai, CPT)
        + estimate_message_tokens(tool2, CPT)
        + 5
    )
    out = trim_messages_for_budget(msgs, budget, CPT)
    assert out == [sys, human, last_ai]
    assert tool1 not in out and tool2 not in out
    assert out[-1].type != "tool"
