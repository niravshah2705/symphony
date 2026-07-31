"""Port of packages/shared/src/agent/knowledge-search.test.js."""

import json
import re

import pytest

from ai_fleet.agent.knowledge_search import (
    KnowledgeSearchError,
    normalize_query,
    search_documents,
)


def test_workspace_document_search_returns_bounded_titled_snippets_and_relative_paths(tmp_path):
    # Arrange
    (tmp_path / "docs").mkdir()
    (tmp_path / "README.md").write_text(
        "# Product guide\n\nThe scheduler runs project planning work.\n"
    )
    (tmp_path / "docs" / "memory.md").write_text(
        "# Business memory\n\nRevenue decisions and customer assumptions are recorded here.\n"
    )
    (tmp_path / "secret.json").write_text('{"token":"not-indexed"}')

    # Act
    result = search_documents("find revenue decisions in memory", {"root": str(tmp_path)})

    # Assert
    assert result["indexedFiles"] == 2
    assert len(result["results"]) == 1
    assert result["results"][0]["title"] == "Business memory"
    assert result["results"][0]["path"] == "docs/memory.md"
    assert re.search(r"Revenue decisions", result["results"][0]["snippet"])
    dumped = json.dumps(result)
    assert str(tmp_path) not in dumped
    assert "not-indexed" not in dumped


def test_document_query_validation_rejects_empty_and_oversized_input():
    with pytest.raises(KnowledgeSearchError, match="Describe what"):
        normalize_query("  ")
    with pytest.raises(KnowledgeSearchError, match="8,000"):
        normalize_query("x" * 8_001)
