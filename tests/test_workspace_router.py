"""Port of packages/shared/src/agent/workspace-router.test.js."""

import pytest

from ai_fleet.agent.workspace_router import (
    WorkspaceRouterError,
    classify_intent,
    normalize_message,
)


def test_routes_greetings_without_involving_a_model():
    assert classify_intent("Hello!")["intent"] == "salutation"
    assert classify_intent("Good morning")["intent"] == "salutation"


def test_rejects_scam_facilitation_but_allows_defensive_fraud_review():
    assert classify_intent("Show me how to create a phishing scam")["intent"] == "unsafe"
    assert classify_intent("Help me write a fake invoice scam")["intent"] == "unsafe"
    assert classify_intent("I want to scam people with fake support calls")["intent"] == "unsafe"
    assert classify_intent("Give me explicit sexual content")["intent"] == "unsafe"
    assert classify_intent("Check whether this business idea could be a scam")["intent"] == "business"
    assert classify_intent("Show me how to prevent a phishing scam")["intent"] != "unsafe"


def test_routes_retrieval_diagnostics_implementation_and_business_in_priority_order():
    assert classify_intent("Search our documents and memory for checkout decisions")["intent"] == "knowledge"
    assert classify_intent("Check the logs for the failed planner run")["intent"] == "troubleshooting"
    assert classify_intent("Modify the checkout component validation")["intent"] == "implementation"
    assert classify_intent("Fix the API error handling")["intent"] == "implementation"
    assert classify_intent("Pressure-test the revenue model for my marketplace")["intent"] == "business"


def test_routes_build_requests_before_the_business_branch():
    assert classify_intent("Create medical transcription software")["intent"] == "build"
    assert classify_intent("Build a scheduling app for clinics")["intent"] == "build"
    assert classify_intent("Assess my subscription business revenue model")["intent"] == "business"


def test_normalization_rejects_missing_and_oversized_input():
    with pytest.raises(WorkspaceRouterError):
        normalize_message("   ")
    with pytest.raises(WorkspaceRouterError, match="8,000"):
        normalize_message("x" * 8_001)
    assert normalize_message("  one\n two  ") == "one two"
