"""Cascade resolver semantics.

Rule under test: exclude at org blocks project AND user; exclude at project
blocks user; a lower scope can only NARROW, never re-include what a higher scope
excluded; exclude always wins downward.
"""
from __future__ import annotations

from app.domain.resolver import apply_scope, resolve_domain, resolve_effective
from app.models.policy import DomainPolicy, SettingsPolicy

HARNESS = ["deepagent", "codex-sdk", "claude-agent-sdk"]


def dp(include=None, exclude=None) -> DomainPolicy:
    return DomainPolicy(include=list(include or []), exclude=list(exclude or []))


# ---- apply_scope ------------------------------------------------------------

def test_empty_scope_keeps_all_candidates():
    assert apply_scope(HARNESS, dp()) == HARNESS


def test_include_narrows_to_matching_items():
    assert apply_scope(HARNESS, dp(include=["deepagent"])) == ["deepagent"]


def test_exclude_removes_and_wins_over_include():
    result = apply_scope(HARNESS, dp(include=["deepagent", "codex-sdk"], exclude=["codex-sdk"]))
    assert result == ["deepagent"]


def test_glob_pattern_matches():
    universe = ["security:raven", "security:fix", "web-research"]
    assert apply_scope(universe, dp(exclude=["security:*"])) == ["web-research"]


# ---- resolve_domain (the cascade) ------------------------------------------

def test_empty_cascade_returns_full_universe_at_every_level():
    res = resolve_domain(HARNESS, dp(), dp(), dp())
    assert res.org == HARNESS
    assert res.project == HARNESS
    assert res.user == HARNESS
    assert res.effective == HARNESS


def test_exclude_at_org_blocks_project_and_user():
    # org excludes codex-sdk; project AND user try to include it back.
    res = resolve_domain(
        HARNESS,
        dp(exclude=["codex-sdk"]),
        dp(include=["codex-sdk"]),
        dp(include=["codex-sdk", "deepagent"]),
    )
    assert "codex-sdk" not in res.org
    assert "codex-sdk" not in res.project
    assert "codex-sdk" not in res.user  # a lower scope cannot re-include


def test_exclude_at_project_blocks_user():
    res = resolve_domain(
        HARNESS,
        dp(),
        dp(exclude=["deepagent"]),
        dp(include=["deepagent"]),  # user tries to re-include
    )
    assert "deepagent" in res.org
    assert "deepagent" not in res.project
    assert "deepagent" not in res.user


def test_project_narrows_within_org_allowed():
    # org allows only deepagent+codex-sdk; project.include of a third item is a
    # no-op because it is not in the org-allowed candidate set.
    res = resolve_domain(
        HARNESS,
        dp(include=["deepagent", "codex-sdk"]),
        dp(include=["claude-agent-sdk"]),
        dp(),
    )
    assert set(res.org) == {"deepagent", "codex-sdk"}
    assert res.project == []  # narrowed to nothing (include matched no candidate)
    assert res.user == []


def test_user_narrows_only_its_own_level():
    res = resolve_domain(HARNESS, dp(), dp(), dp(exclude=["deepagent"]))
    assert "deepagent" in res.org
    assert "deepagent" in res.project
    assert "deepagent" not in res.user


# ---- resolve_effective (all domains) ---------------------------------------

def test_resolve_effective_covers_all_domains():
    universe = {
        "harness": HARNESS,
        "tools": ["docker", "security", "build"],
        "skills": ["security:raven", "linear", "commit"],
        "plugins": ["security", "ecc"],
    }
    org = SettingsPolicy(
        scope_type="org",
        scope_id="o1",
        domains={
            "tools": dp(exclude=["security"]),
            "skills": dp(exclude=["security:*"]),
        },
    )
    user = SettingsPolicy(
        scope_type="user",
        scope_id="u1",
        domains={"tools": dp(include=["security", "docker"])},  # cannot re-add security
    )
    resolution = resolve_effective(universe, org, None, user)

    # harness untouched -> full universe
    assert resolution["harness"].effective == HARNESS
    # tools: org excluded security; user include cannot re-add it -> only docker
    assert resolution["tools"].effective == ["docker"]
    # skills: security:* excluded at org
    assert resolution["skills"].effective == ["linear", "commit"]
    # plugins: no policy -> full
    assert resolution["plugins"].effective == ["security", "ecc"]


def test_missing_policies_are_treated_as_empty():
    universe = {"harness": HARNESS, "tools": [], "skills": [], "plugins": []}
    resolution = resolve_effective(universe, None, None, None)
    assert resolution["harness"].effective == HARNESS
