"""Port of packages/shared/src/agent/conversations.test.js."""

import pytest

from ai_fleet.agent.conversations import (
    MAX_MESSAGES_PER_REQUEST,
    ConversationError,
    normalize_messages,
    derive_title,
    normalize_title,
    summarize_conversation,
)


def test_normalize_messages_keeps_only_allowlisted_fields_per_role():
    out = normalize_messages([
        {"role": "user", "text": "assess a saas idea", "id": "x", "extra": 1},
        {
            "role": "assistant",
            "intent": "business",
            "title": "Business workflow",
            "copy": "I ran the pipeline",
            "label": "Business",
            "warning": "",
            "input": "assess a saas idea",
            "payload": {"huge": True},
        },
    ])
    assert sorted(out[0].keys()) == ["role", "text"]
    assert out[0]["text"] == "assess a saas idea"
    assert sorted(out[1].keys()) == ["copy", "input", "intent", "label", "role", "title", "warning"]
    assert "payload" not in out[1]
    assert out[1]["intent"] == "business"


def test_normalize_messages_validates_array_shape_and_size():
    with pytest.raises(ConversationError):
        normalize_messages([])
    with pytest.raises(ConversationError):
        normalize_messages("nope")
    with pytest.raises(ConversationError, match="per request"):
        normalize_messages([{"role": "user", "text": "x"}] * (MAX_MESSAGES_PER_REQUEST + 1))


def test_normalize_messages_enforces_role_and_required_content():
    with pytest.raises(ConversationError, match="role"):
        normalize_messages([{"role": "system", "text": "x"}])
    with pytest.raises(ConversationError, match="requires text"):
        normalize_messages([{"role": "user", "text": "   "}])
    with pytest.raises(ConversationError, match="copy or title"):
        normalize_messages([{"role": "assistant", "copy": "", "title": ""}])


def test_normalize_messages_bounds_long_fields():
    (msg,) = normalize_messages([{"role": "user", "text": "y" * 9000}])
    assert len(msg["text"]) == 8000


def test_derive_title_collapses_to_a_single_bounded_line_with_a_fallback():
    assert derive_title("  Pressure-test my   revenue model  ") == "Pressure-test my revenue model"
    assert len(derive_title("z" * 200)) <= 60
    assert derive_title("   ") == "New conversation"


def test_normalize_title_trims_bounds_and_rejects_empty():
    assert normalize_title("  My thread  ") == "My thread"
    with pytest.raises(ConversationError):
        normalize_title("   ")


def test_summarize_conversation_omits_messages_and_counts_them():
    summary = summarize_conversation(
        {"id": "conv_1", "title": "T", "createdAt": "a", "updatedAt": "b", "messages": [{}, {}]})
    assert summary == {"id": "conv_1", "title": "T", "createdAt": "a", "updatedAt": "b", "messageCount": 2}
    assert "messages" not in summary
