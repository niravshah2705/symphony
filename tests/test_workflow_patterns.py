"""Port of packages/shared/src/agent/workflow-patterns.test.js.

Note: the JS test also cross-checks catalog ids against
``runtimes.workflowPatternCatalog()``. That runtime module pulls in heavy LLM
dependencies (langsmith, repository-broker) that are not installed here, and its
catalog is derived from the very same PATTERNS list. The cross-check is
reproduced locally against PATTERNS to keep the intent without the heavy import.
"""

from ai_fleet.agent.workflow_patterns import (
    PATTERNS,
    catalog,
    pattern_id,
    validate_workflow_pattern,
)


def _runtime_workflow_pattern_catalog():
    # Mirror runtimes.workflowPatternCatalog(): PATTERNS.map(({id,label}) => ({id,label})).
    return [{"id": p["id"], "label": p["label"]} for p in PATTERNS]


def test_catalog_exposes_the_four_supported_bounded_patterns():
    assert [pattern["id"] for pattern in catalog()] == [
        "sequential",
        "parallel",
        "evaluator",
        "supervisor",
    ]
    assert pattern_id("parallel/fan-out") == "parallel"
    assert pattern_id("evaluator/retry") == "evaluator"
    assert pattern_id("supervisor/handoff") == "supervisor"
    assert all(pattern["description"] and len(pattern["steps"]) == 3 for pattern in catalog())
    assert [pattern["id"] for pattern in catalog()] == [
        pattern["id"] for pattern in _runtime_workflow_pattern_catalog()
    ]


def test_valid_workflow_definitions_are_normalized_with_bounded_defaults():
    assert validate_workflow_pattern(
        {"pattern": "sequential", "config": {"steps": ["Understand request", "Implement", "Verify"]}}
    ) == {
        "valid": True,
        "errors": [],
        "workflow": {
            "patternId": "sequential",
            "config": {"steps": ["Understand request", "Implement", "Verify"]},
        },
    }

    evaluator = validate_workflow_pattern(
        {"patternId": "evaluator", "config": {"worker": "Builder", "evaluator": "Reviewer"}}
    )
    assert evaluator["valid"] is True
    assert evaluator["workflow"]["config"]["maxAttempts"] == 3

    supervisor = validate_workflow_pattern(
        {"patternId": "supervisor", "config": {"supervisor": "Lead", "specialists": ["Researcher", "Engineer"]}}
    )
    assert supervisor["valid"] is True
    assert supervisor["workflow"]["config"]["maxHandoffs"] == 6


def test_validation_rejects_unknown_duplicate_unbounded_and_conflicting_definitions():
    assert validate_workflow_pattern({"pattern": "arbitrary-code"})["valid"] is False

    parallel = validate_workflow_pattern(
        {"pattern": "parallel/fan-out", "branches": ["Research", "research"]}
    )
    assert parallel["valid"] is False
    assert "unique" in " ".join(parallel["errors"])

    evaluator = validate_workflow_pattern(
        {
            "pattern": "evaluator/retry",
            "worker": "Same agent",
            "evaluator": "Same agent",
            "maxAttempts": 99,
        }
    )
    assert evaluator["valid"] is False
    assert "different agents" in " ".join(evaluator["errors"])
    assert "1 to 5" in " ".join(evaluator["errors"])

    supervisor = validate_workflow_pattern(
        {"pattern": "supervisor/handoff", "supervisor": "Lead", "specialists": ["Lead", "Engineer"]}
    )
    assert supervisor["valid"] is False
    assert "must not also appear" in " ".join(supervisor["errors"])
