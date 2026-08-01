"""Port of packages/shared/src/agent/lmstudio-context.test.js."""

from __future__ import annotations

from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage

from ai_fleet.agent.lmstudio_context import (
    estimate_message_tokens,
    trim_messages_for_budget,
    split_for_budget,
    prepare_messages,
    SUMMARY_MARKER,
)

CPT = 4  # chars-per-token for deterministic test arithmetic


def est(m):
    return estimate_message_tokens(m, CPT)


def build_convo():
    """system + first human (the task) + two read tool-calls with large results +
    a final assistant turn — the shape of a long deep-agent coding run."""
    return [
        SystemMessage("S" * 400),
        HumanMessage("H" * 400),
        AIMessage(content="", tool_calls=[{"id": "1", "name": "read", "args": {"path": "a.js"}}]),
        ToolMessage(content="T" * 20000, tool_call_id="1"),
        AIMessage(content="", tool_calls=[{"id": "2", "name": "read", "args": {"path": "b.js"}}]),
        ToolMessage(content="T" * 20000, tool_call_id="2"),
        AIMessage("final summary of the work done"),
    ]


# ------------------------------ split_for_budget --------------------------

def test_split_for_budget_keeps_system_and_first_human_as_head():
    msgs = build_convo()
    sys, human = msgs[0], msgs[1]
    result = split_for_budget(msgs, budget=100_000, chars_per_token=CPT)
    assert result["head"] == [sys, human]


def test_split_for_budget_moves_orphaned_leading_tool_result_into_middle():
    msgs = build_convo()
    sys, human, tool2, last_ai = msgs[0], msgs[1], msgs[5], msgs[6]
    # Budget fits tool2 + last_ai in the tail but not the AI turn that requested
    # tool2, so a naive tail would start on tool2 (orphaned) — it must move.
    budget = est(sys) + est(human) + est(last_ai) + est(tool2) + 5
    result = split_for_budget(msgs, budget=budget, summary_reserve=0, chars_per_token=CPT)
    assert result["head"] == [sys, human]
    assert result["tail"][0] is last_ai
    assert tool2 not in result["tail"]
    assert tool2 in result["middle"]


# ------------------------------ prepare_messages --------------------------

async def test_prepare_messages_passes_through_when_history_fits():
    msgs = build_convo()

    async def summarize(_text):
        return "x"

    out = await prepare_messages(
        messages=msgs, mode="summarize", budget=1_000_000, chars_per_token=CPT, summarize=summarize
    )
    assert out is msgs


async def test_prepare_messages_mode_none_never_manages_history():
    msgs = build_convo()
    called = 0

    async def summarize(_text):
        nonlocal called
        called += 1
        return "x"

    out = await prepare_messages(messages=msgs, mode="none", budget=10, chars_per_token=CPT, summarize=summarize)
    assert out is msgs
    assert called == 0


async def test_prepare_messages_mode_trim_drops_the_middle():
    msgs = build_convo()
    sys, human, last_ai = msgs[0], msgs[1], msgs[6]
    budget = est(sys) + est(human) + est(last_ai) + 5

    async def summarize(_text):
        return "x"

    out = await prepare_messages(messages=msgs, mode="trim", budget=budget, chars_per_token=CPT, summarize=summarize)
    assert out == trim_messages_for_budget(msgs, budget, CPT)
    assert out == [sys, human, last_ai]


async def test_prepare_messages_summarize_injects_summary_keeps_recent_verbatim():
    msgs = build_convo()
    sys, human, last_ai = msgs[0], msgs[1], msgs[6]
    summary_max_tokens = 50
    budget = est(sys) + est(human) + summary_max_tokens + est(last_ai) + 5
    calls = 0

    async def summarize(_text):
        nonlocal calls
        calls += 1
        return "PROGRESS"

    out = await prepare_messages(
        messages=msgs,
        mode="summarize",
        budget=budget,
        chars_per_token=CPT,
        summary_max_tokens=summary_max_tokens,
        summarize=summarize,
    )
    # head + one injected summary message + the recent tail (verbatim).
    assert len(out) == 4
    assert out[0] is sys
    assert out[1] is human
    assert out[3] is last_ai
    assert out[2].type == "human"
    assert out[2].content.startswith(SUMMARY_MARKER)
    assert "PROGRESS" in out[2].content
    # The large middle exceeds one summarizer chunk → map-reduce makes several calls.
    assert calls > 1, f"expected multiple summarize calls, got {calls}"


async def test_prepare_messages_summarize_falls_back_to_trimming_on_failure():
    msgs = build_convo()
    summary_max_tokens = 50
    sys, human, last_ai = msgs[0], msgs[1], msgs[6]
    budget = est(sys) + est(human) + summary_max_tokens + est(last_ai) + 5

    async def summarize(_text):
        raise RuntimeError("LM Studio channel error")

    out = await prepare_messages(
        messages=msgs,
        mode="summarize",
        budget=budget,
        chars_per_token=CPT,
        summary_max_tokens=summary_max_tokens,
        summarize=summarize,
    )
    assert out == trim_messages_for_budget(msgs, budget, CPT)
    assert not any(isinstance(m.content, str) and m.content.startswith(SUMMARY_MARKER) for m in out)
