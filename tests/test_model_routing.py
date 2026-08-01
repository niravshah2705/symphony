"""Port of packages/shared/src/agent/model-routing.test.js.

Scope note: the JS file also tests ``modelRoleForTask`` from ``coder-orchestrator``,
which has not been ported to Python yet — those cases are omitted here. The
``providerForRole`` (llm) and ``PlanSchema`` / ``normalizeTshirtSize`` (schema)
cases are ported faithfully.
"""

from __future__ import annotations

from ai_fleet.agent.llm import provider_for_role
from ai_fleet.agent.schema import PlanSchema, normalize_tshirt_size


# ----------------------------- provider_for_role ------------------------- #

def test_provider_for_role_global_uses_hosted_slot():
    assert provider_for_role({"llmProvider": "claude", "localLlmProvider": "lmstudio"}, "global") == "claude"


def test_provider_for_role_local_uses_local_slot():
    assert provider_for_role({"llmProvider": "claude", "localLlmProvider": "lmstudio"}, "local") == "lmstudio"


def test_provider_for_role_default_role_is_global():
    assert provider_for_role({"llmProvider": "codex", "localLlmProvider": "ollama"}) == "codex"


def test_provider_for_role_local_falls_back_to_global_then_ollama():
    assert provider_for_role({"llmProvider": "codex"}, "local") == "codex"
    assert provider_for_role({}, "local") == "ollama"


def test_provider_for_role_purpose_roles_read_own_slot():
    settings = {
        "llmProvider": "claude",
        "thinkingLlmProvider": "codex",
        "executionLlmProvider": "ollama",
        "testingLlmProvider": "lmstudio",
    }
    assert provider_for_role(settings, "thinking") == "codex"
    assert provider_for_role(settings, "execution") == "ollama"
    assert provider_for_role(settings, "testing") == "lmstudio"


def test_provider_for_role_purpose_roles_fall_back_to_hosted_then_ollama():
    assert provider_for_role({"llmProvider": "claude"}, "thinking") == "claude"
    assert provider_for_role({"llmProvider": "codex"}, "execution") == "codex"
    assert provider_for_role({}, "testing") == "ollama"


# --------------------------- schema: tshirtSize -------------------------- #

def _plan_with(issue):
    return PlanSchema.model_validate(
        {
            "description": "a valid design overview",
            "milestones": [
                {"name": "M1", "startDate": "2026-01-01", "targetDate": "2026-02-01", "issues": [issue]}
            ],
        }
    )


def test_plan_schema_missing_tshirt_defaults_to_m():
    plan = _plan_with({"title": "Build the thing"})
    assert plan.milestones[0].issues[0].tshirtSize == "M"


def test_plan_schema_keeps_a_messy_tshirt_size():
    plan = _plan_with({"title": "Build the thing", "tshirtSize": " xs "})
    assert plan.milestones[0].issues[0].tshirtSize == " xs "


def test_normalize_tshirt_size_trims_uppercases_and_defaults_unknown_to_m():
    assert normalize_tshirt_size(" xs ") == "XS"
    assert normalize_tshirt_size("L") == "L"
    assert normalize_tshirt_size("HUGE") == "M"
    assert normalize_tshirt_size("") == "M"
    assert normalize_tshirt_size(None) == "M"
