"""Port of packages/shared/src/agent/trace-annotations.test.js."""

from ai_fleet.agent.trace_annotations import build_annotations, with_annotations


def test_build_annotations_stamps_all_three_fields():
    business = {"project": "OTA", "taskId": "ENG-123", "session": "run-abc"}

    result = build_annotations(business)

    assert result["metadata"] == {
        "project": "OTA",
        "task-id": "ENG-123",
        "session": "run-abc",
        "session_id": "run-abc",  # LangSmith Threads grouping key mirrors session
    }
    assert result["tags"] == ["project:OTA", "task:ENG-123", "session:run-abc"]


def test_build_annotations_omits_blank_null_and_undefined_fields():
    result = build_annotations({"project": "  ", "taskId": None, "session": None})

    assert result["metadata"] == {}
    assert result["tags"] == []


def test_build_annotations_trims_surrounding_whitespace():
    result = build_annotations({"project": "  OTA  ", "taskId": " ENG-1 "})
    assert result["metadata"]["project"] == "OTA"
    assert result["metadata"]["task-id"] == "ENG-1"
    assert result["tags"] == ["project:OTA", "task:ENG-1"]


def test_build_annotations_tolerates_no_argument():
    result = build_annotations()
    assert result["metadata"] == {}
    assert result["tags"] == []


def test_with_annotations_preserves_existing_metadata_and_tags():
    config = {
        "runId": "r1",
        "recursionLimit": 24,
        "tags": ["enrich", "linear-manager"],
        "metadata": {"projectId": "p1", "assumedRole": None},
    }

    merged = with_annotations(config, {"project": "OTA", "taskId": "ENG-9", "session": "r1"})

    assert merged["runId"] == "r1"
    assert merged["recursionLimit"] == 24
    assert merged["metadata"] == {
        "projectId": "p1",
        "assumedRole": None,
        "project": "OTA",
        "task-id": "ENG-9",
        "session": "r1",
        "session_id": "r1",
    }
    assert merged["tags"] == [
        "enrich",
        "linear-manager",
        "project:OTA",
        "task:ENG-9",
        "session:r1",
    ]


def test_with_annotations_does_not_mutate_the_input_config():
    config = {"tags": ["enrich"], "metadata": {"projectId": "p1"}}
    original_tags = list(config["tags"])
    original_meta = dict(config["metadata"])

    with_annotations(config, {"project": "OTA", "session": "r1"})

    assert config["tags"] == original_tags
    assert config["metadata"] == original_meta


def test_with_annotations_de_duplicates_tags_that_already_exist():
    config = {"tags": ["project:OTA"]}
    merged = with_annotations(config, {"project": "OTA", "session": "r1"})
    assert merged["tags"] == ["project:OTA", "session:r1"]


def test_with_annotations_works_with_empty_config_and_empty_business():
    merged = with_annotations()
    assert merged["metadata"] == {}
    assert merged["tags"] == []
