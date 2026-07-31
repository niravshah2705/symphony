"""Port of packages/shared/src/agent/memory.test.js."""

import re

import pytest

from ai_fleet.agent.memory import (
    MEMORY_SCOPES,
    MemoryError,
    normalize_memory,
    detect_memory_scope,
    detect_memory_write,
    search_memories,
)


def test_normalize_memory_validates_scope_bounds_and_strips_unknown_keys():
    record = normalize_memory({
        "scope": "business",
        "refId": "proj_123",
        "title": "Pricing decision",
        "text": "Charge $9/mo with a 14-day trial.",
        "tags": ["pricing", "pricing", "trial"],
        "source": "business-pipeline",
        "id": "attacker-supplied",  # must be ignored (no mass assignment)
        "createdAt": "attacker-supplied",
    })
    assert sorted(record.keys()) == sorted(["refId", "scope", "source", "tags", "text", "title"])
    assert record["scope"] == "business"
    assert record["refId"] == "proj_123"
    assert record["tags"] == ["pricing", "trial"]  # deduped
    assert record["source"] == "business-pipeline"


def test_normalize_memory_defaults_source_derives_title_and_requires_text():
    record = normalize_memory({"scope": "user", "text": "I prefer dark mode and concise summaries."})
    assert record["source"] == "omnibox"
    assert record["refId"] is None
    assert 0 < len(record["title"]) <= 60
    with pytest.raises(MemoryError):
        normalize_memory({"scope": "user", "text": "   "})


def test_normalize_memory_rejects_bad_scope_and_traversal_shaped_refid():
    with pytest.raises(MemoryError):
        normalize_memory({"scope": "wrong", "text": "x"})
    with pytest.raises(MemoryError):
        normalize_memory({"scope": "task", "refId": "../../etc/passwd", "text": "x"})
    with pytest.raises(MemoryError):
        normalize_memory({"scope": "task", "refId": "a/b", "text": "x"})


def test_normalize_memory_caps_text_length():
    record = normalize_memory({"scope": "workspace", "text": "y" * 5000})
    assert len(record["text"]) == 2000


def test_detect_memory_scope_reads_explicit_scope_memory_phrasing():
    assert detect_memory_scope("search project memory for the checkout plan") == "project"
    assert detect_memory_scope("what is in our business memory") == "business"
    assert detect_memory_scope("show my user memory") == "user"
    assert detect_memory_scope("list task memories") == "task"


def test_detect_memory_scope_falls_back_to_keyword_heuristics_else_all():
    assert detect_memory_scope("recall our pricing decision") == "business"
    assert detect_memory_scope("remember that I prefer dark mode") == "user"
    assert detect_memory_scope("open the checkout ticket") == "task"
    assert detect_memory_scope("find the thing we discussed") == "all"
    assert detect_memory_scope("") == "all"


def test_detect_memory_write_returns_scoped_draft_for_write_phrasing_null_otherwise():
    a = detect_memory_write("remember that I prefer dark mode")
    assert a["scope"] == "user"
    assert re.search(r"prefer dark mode", a["text"], re.IGNORECASE)
    assert len(a["title"]) > 0

    b = detect_memory_write("save to business memory: charge $9/mo with a trial")
    assert b["scope"] == "business"
    assert re.search(r"\$9/mo", b["text"])

    assert detect_memory_write("what is our current pricing?") is None
    assert detect_memory_write("") is None


def test_search_memories_ranks_by_term_overlap_and_filters_by_scope():
    memories = [
        {"id": "m1", "scope": "business", "title": "Pricing", "text": "Charge nine dollars monthly", "tags": ["pricing"]},
        {"id": "m2", "scope": "project", "title": "Checkout", "text": "Checkout flow milestones", "tags": []},
        {"id": "m3", "scope": "business", "title": "Growth", "text": "Retention cohorts", "tags": []},
    ]
    all_ = search_memories("pricing monthly", memories, {})
    assert all_[0]["id"] == "m1"
    assert all_[0]["scope"] == "business"

    scoped = search_memories("checkout", memories, {"scope": "project"})
    assert len(scoped) == 1
    assert scoped[0]["id"] == "m2"

    none = search_memories("pricing", memories, {"scope": "project"})
    assert len(none) == 0


def test_memory_scopes_lists_the_five_typed_scopes():
    assert sorted(MEMORY_SCOPES) == ["business", "project", "task", "user", "workspace"]
