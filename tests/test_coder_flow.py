"""Port of packages/shared/src/agent/coder-flow.test.js (pytest / pytest-asyncio)."""

from __future__ import annotations

import json

import pytest

from ai_fleet.agent import coder_orchestrator as orchestrator
from ai_fleet.agent.coder_orchestrator import (
    parse_verdict,
    preflight_task,
    preflight_and_pause,
    pause_for_runtime_error,
    dispatch_ready_task,
    dispatch,
)
from ai_fleet.agent.coder import active_repository_branch, assert_openswe_repository_provider
from ai_fleet.agent.availability import AgentAvailabilityError
from ai_fleet.agent.repository_broker import RepositoryBrokerError
from ai_fleet.agent.runtimes import AgentRuntimeError
from ai_fleet.linear import pick_state_by_type


# ------------------------------ parse_verdict ---------------------------- #


def test_parse_verdict_reads_fenced_verdict_json_completed():
    text = 'Implemented and validated.\n\n```verdict\n{"status": "completed", "reason": "All acceptance criteria met."}\n```'
    v = parse_verdict(text)
    assert v["status"] == "completed"
    assert v["reason"] == "All acceptance criteria met."


def test_parse_verdict_reads_insufficient_json_with_reason():
    v = parse_verdict('{"status":"insufficient","reason":"No repository configured for this project."}')
    assert v["status"] == "insufficient"
    assert v["reason"] == "No repository configured for this project."


def test_parse_verdict_extracts_merged_pr_url_when_completed():
    text = '```verdict\n{"status":"completed","reason":"Merged.","pr":"https://github.com/acme/app/pull/42"}\n```'
    v = parse_verdict(text)
    assert v["status"] == "completed"
    assert v["pr"] == "https://github.com/acme/app/pull/42"


def test_parse_verdict_leaves_pr_null_when_absent():
    assert parse_verdict('{"status":"completed","reason":"done"}')["pr"] is None
    assert parse_verdict("VERDICT: completed — done")["pr"] is None


def test_parse_verdict_accepts_plain_verdict_line():
    v = parse_verdict("Work done.\nVERDICT: completed — shipped and green.")
    assert v["status"] == "completed"
    assert v["reason"] == "shipped and green."


def test_parse_verdict_normalizes_case_in_status():
    v = parse_verdict('{"status":"Completed","reason":"done"}')
    assert v["status"] == "completed"


def test_parse_verdict_defaults_insufficient_when_no_verdict():
    v = parse_verdict("I finished the task and it looks great.")
    assert v["status"] == "insufficient"
    assert "did not emit" in v["reason"].lower()


def test_parse_verdict_defaults_insufficient_on_empty_or_none():
    assert parse_verdict("")["status"] == "insufficient"
    assert parse_verdict(None)["status"] == "insufficient"


def test_openswe_fails_closed_for_gitlab_repository_selection():
    assert_openswe_repository_provider("github")  # does not raise
    with pytest.raises(Exception, match="GitHub-only"):
        assert_openswe_repository_provider("gitlab")


class _FakeBroker:
    def public_info(self):
        return {"branch": "task-123-retry-17"}


def test_coder_results_report_broker_branch_after_retry_rotation():
    broker = _FakeBroker()
    assert active_repository_branch("task-123", broker) == "task-123-retry-17"
    assert active_repository_branch("task-123", None) == "task-123"


# ------------------------------ preflight -------------------------------- #


async def test_git_403_preflight_stops_before_model_or_job_or_transition():
    task = {"id": "issue-1", "identifier": "ENG-1", "labels": [], "project": {"id": "project-1", "name": "Project"}}
    state = {"model_resolved": False, "model_probed": False, "dispatches": 0}

    async def resolve_role(role):
        state["model_resolved"] = True
        return {"provider": "ollama", "host": "http://localhost:11434", "model": "coder"}

    async def probe_repository_availability(_selection):
        raise AgentAvailabilityError("git", "friendly", 403)

    async def probe_model_availability(_llm):
        state["model_probed"] = True

    with pytest.raises(AgentAvailabilityError) as exc:
        await dispatch_ready_task(
            task,
            resolve_role,
            {"apiKey": "linear-key"},
            {
                "repository_selection_for_task": lambda _t: {"provider": "github", "repoRef": "acme/app", "token": "secret"},
                "cached_readiness_probe": lambda _key, probe: probe(),
                "probe_repository_availability": probe_repository_availability,
                "probe_model_availability": probe_model_availability,
                "dispatch": lambda *a, **k: state.__setitem__("dispatches", state["dispatches"] + 1),
            },
        )
    assert exc.value.resource == "git" and exc.value.status == 403
    # createCodingJob/startIssue live exclusively in dispatch(), reached only after
    # preflightTask succeeds.
    assert state["model_resolved"] is False
    assert state["model_probed"] is False
    assert state["dispatches"] == 0


async def test_model_preflight_stops_before_job_or_transition():
    task = {"id": "issue-model", "identifier": "ENG-MODEL", "labels": [], "project": {"id": "project-model", "name": "Project"}}
    state = {"dispatches": 0, "repository_probes": 0}

    async def resolve_role(role):
        return {"provider": "ollama", "host": "http://localhost:11434", "model": "missing"}

    async def probe_repository_availability(_selection):
        state["repository_probes"] += 1

    async def probe_model_availability(_llm):
        raise AgentAvailabilityError("model", "friendly", 404, "model_not_found")

    with pytest.raises(AgentAvailabilityError) as exc:
        await dispatch_ready_task(
            task,
            resolve_role,
            {"apiKey": "linear-key"},
            {
                "repository_selection_for_task": lambda _t: {"provider": "github", "repoRef": "acme/app", "token": "secret"},
                "cached_readiness_probe": lambda _key, probe: probe(),
                "probe_repository_availability": probe_repository_availability,
                "probe_model_availability": probe_model_availability,
                "dispatch": lambda *a, **k: state.__setitem__("dispatches", state["dispatches"] + 1),
            },
        )
    assert exc.value.resource == "model" and exc.value.status == 404
    assert state["repository_probes"] == 1
    assert state["dispatches"] == 0


async def test_successful_readiness_is_probed_again_for_every_later_dispatch():
    task = {"id": "issue-freshness", "identifier": "ENG-FRESH", "labels": [], "project": {"id": "project-freshness", "name": "Project"}}
    counters = {"repository_probes": 0, "model_probes": 0}

    async def probe_repository_availability(_selection):
        counters["repository_probes"] += 1

    async def probe_model_availability(_llm):
        counters["model_probes"] += 1

    dependencies = {
        "repository_selection_for_task": lambda _t: {"provider": "github", "repoRef": "acme/app", "token": "secret"},
        "probe_repository_availability": probe_repository_availability,
        "probe_model_availability": probe_model_availability,
    }

    async def resolve_role(role):
        return {"provider": "ollama", "host": "http://localhost:11434", "model": "coder"}

    await preflight_task(task, resolve_role, dependencies)
    await preflight_task(task, resolve_role, dependencies)

    assert counters["repository_probes"] == 2
    assert counters["model_probes"] == 2


async def test_manual_readiness_guard_establishes_sanitized_global_pause():
    orchestrator._test.clear_pause("test setup")
    try:
        task = {"id": "issue-manual", "identifier": "ENG-MANUAL", "labels": [], "project": {"id": "project-manual", "name": "Project"}}

        async def resolve_role(role):
            return {"provider": "codex", "model": "gpt-test"}

        async def probe_repository_availability(_selection):
            raise AgentAvailabilityError("git", "raw provider 403 secret", 403)

        with pytest.raises(Exception) as exc:
            await preflight_and_pause(
                task,
                resolve_role,
                {
                    "repository_selection_for_task": lambda _t: {"provider": "github", "repoRef": "acme/app", "token": "secret"},
                    "cached_readiness_probe": lambda _key, probe: probe(),
                    "probe_repository_availability": probe_repository_availability,
                },
            )
        assert getattr(exc.value, "pause_reason", None) and exc.value.pause_reason["resource"] == "git"

        assert orchestrator.status()["paused"] is True
        assert "repository access is unavailable" in orchestrator.status()["pauseReason"]["message"].lower()
        serialized = json.dumps(orchestrator.status())
        assert "raw provider" not in serialized.lower()
        assert "secret" not in serialized.lower()
        assert "403" not in serialized
    finally:
        orchestrator._test.clear_pause("test cleanup")


async def test_runtime_outage_helper_pauses_on_execution_role_regardless_of_legacy_label():
    orchestrator._test.clear_pause("test setup")
    try:
        # The legacy "local" model label no longer influences model selection — the
        # coder always resolves the purpose-based `execution` role.
        task = {"id": "issue-direct-local", "identifier": "ENG-DIRECT", "labels": ["local"], "project": {"id": "project-direct", "name": "Project"}}
        resolved = {"role": None}

        async def resolve_role(role):
            resolved["role"] = role
            return {"provider": "ollama", "host": "http://localhost:11434", "model": "local-coder"}

        async def probe_repository_availability(_selection):
            return {"available": True}

        async def probe_model_availability(_llm):
            return {"available": True}

        readiness = await preflight_and_pause(
            task,
            resolve_role,
            {
                "repository_selection_for_task": lambda _t: {"provider": "github", "repoRef": "acme/app", "token": "secret"},
                "cached_readiness_probe": lambda _key, probe: probe(),
                "probe_repository_availability": probe_repository_availability,
                "probe_model_availability": probe_model_availability,
            },
        )
        assert resolved["role"] == "execution"
        assert readiness["role"] == "execution"

        reason = pause_for_runtime_error(
            AgentRuntimeError("Local runtime failed.", "runtime_execution_failed", 502, cause=Exception("Request failed with HTTP 403")),
            {"task": task, "role": readiness["role"], "llm": readiness["llm"], "repositoryProvider": readiness["selection"]["provider"]},
        )
        assert reason["resource"] == "model"
        assert reason["role"] == "execution"
        assert orchestrator.status()["paused"] is True
    finally:
        orchestrator._test.clear_pause("test cleanup")


async def test_coder_pause_recovery_waits_reschedules_and_clears_after_ready_change():
    orchestrator._test.clear_pause("test setup")
    try:
        task = {"id": "issue-recovery", "identifier": "ENG-RECOVERY", "project": {"id": "project-recovery", "name": "Project"}}
        orchestrator._test.pause("git", Exception("unavailable"), {"task": task, "taskIdentifier": task["identifier"], "provider": "github"})
        original_fingerprint = orchestrator._test.readiness_fingerprint()
        now_holder = {"value": _now_ms()}
        probes = {"count": 0}

        async def passing_probe(_selection):
            probes["count"] += 1

        common = {
            "now": lambda: now_holder["value"],
            "readiness_fingerprint": lambda: original_fingerprint,
            "repository_selection_for_task": lambda _t: {"provider": "github", "repoRef": "acme/app", "token": "secret"},
            "probe_repository_availability": passing_probe,
        }

        assert await orchestrator._test.recover_pause({}, common) is False
        assert probes["count"] == 0  # an early recovery check must not hammer the provider

        now_holder["value"] += 61_000

        async def failing_probe(_selection):
            probes["count"] += 1
            raise AgentAvailabilityError("git", "still unavailable", 403)

        failing = {**common, "probe_repository_availability": failing_probe}
        assert await orchestrator._test.recover_pause({}, failing) is False
        assert probes["count"] == 1
        assert await orchestrator._test.recover_pause({}, failing) is False
        assert probes["count"] == 1  # a failed periodic probe must schedule the next retry

        changed_and_ready = {**common, "readiness_fingerprint": lambda: "settings-changed"}
        assert await orchestrator._test.recover_pause({}, changed_and_ready) is True
        assert probes["count"] == 2
        assert orchestrator.status()["paused"] is False
        assert orchestrator.status()["pauseReason"] is None
    finally:
        orchestrator._test.clear_pause("test cleanup")


# ------------------------------ dispatch --------------------------------- #


class _FakeStore:
    def __init__(self):
        self.jobs = []

    def add_job(self, job):
        self.jobs.append({**job})
        return job

    def append_job_step(self, id, step):
        job = next(j for j in self.jobs if j["id"] == id)
        job["steps"] = [*(job.get("steps") or []), step]

    def update_job(self, id, patch):
        job = next(j for j in self.jobs if j["id"] == id)
        job.update(patch)
        return job


async def test_runtime_repository_unavailability_pauses_without_finishing_issue():
    orchestrator._test.clear_pause("test setup")
    try:
        fake_store = _FakeStore()
        counters = {"starts": 0, "finishes": 0}

        async def start_issue(api_key, *, issue_id, on_step=None):
            counters["starts"] += 1
            return {"name": "In Progress"}

        async def run_planned_coder(**kwargs):
            raise RepositoryBrokerError("git push failed: HTTP 403 token=raw-secret", "provider_error")

        async def finish_issue(api_key, *, issue_id, outcome, reason=None, on_step=None):
            counters["finishes"] += 1

        task = {"id": "issue-2", "identifier": "ENG-2", "title": "Change code", "labels": [], "project": {"id": "project-2", "name": "Project"}}

        await dispatch(
            task,
            {
                "apiKey": "linear-key",
                "keys": {},
                "role": "global",
                "llm": {"provider": "codex", "model": "gpt-test"},
                "repositoryProvider": "github",
                "repositoryToken": "secret",
                "repositoryUrl": "acme/app",
            },
            {"store": fake_store, "start_issue": start_issue, "run_planned_coder": run_planned_coder, "finish_issue": finish_issue},
        )

        assert counters["starts"] == 1
        assert counters["finishes"] == 0  # availability failures must never be posted as a task verdict
        assert len(fake_store.jobs) == 1
        assert fake_store.jobs[0]["status"] == "error"
        assert "repository access is unavailable" in fake_store.jobs[0]["error"].lower()
        serialized = json.dumps(fake_store.jobs[0])
        assert "raw-secret" not in serialized
        assert "git push failed" not in serialized
        assert orchestrator.status()["paused"] is True
        assert orchestrator.status()["pauseReason"]["resource"] == "git"
    finally:
        orchestrator._test.clear_pause("test cleanup")


async def test_ordinary_repository_workflow_errors_finish_insufficient_without_pausing():
    orchestrator._test.clear_pause("test setup")
    try:
        fake_store = _FakeStore()
        result = {"finishes": 0, "outcome": None}

        async def start_issue(api_key, *, issue_id, on_step=None):
            return {"name": "In Progress"}

        async def run_planned_coder(**kwargs):
            raise RepositoryBrokerError("Workspace has uncommitted changes.", "workspace_dirty")

        async def finish_issue(api_key, *, issue_id, outcome, reason=None, on_step=None):
            result["finishes"] += 1
            result["outcome"] = outcome

        task = {"id": "issue-workspace", "identifier": "ENG-WORKSPACE", "title": "Change code", "labels": [], "project": {"id": "project-workspace", "name": "Project"}}

        await dispatch(
            task,
            {
                "apiKey": "linear-key",
                "keys": {},
                "role": "global",
                "llm": {"provider": "codex", "model": "gpt-test"},
                "repositoryProvider": "github",
                "repositoryToken": "secret",
                "repositoryUrl": "acme/app",
            },
            {"store": fake_store, "start_issue": start_issue, "run_planned_coder": run_planned_coder, "finish_issue": finish_issue},
        )

        assert result["finishes"] == 1
        assert result["outcome"] == "insufficient"
        assert fake_store.jobs[0]["status"] == "done"
        assert fake_store.jobs[0]["summary"]["outcome"] == "insufficient"
        assert orchestrator.status()["paused"] is False
    finally:
        orchestrator._test.clear_pause("test cleanup")


# ----------------------------- pick_state_by_type -------------------------- #

STATES = [
    {"id": "s-backlog", "name": "Backlog", "type": "backlog", "position": 0},
    {"id": "s-todo", "name": "Todo", "type": "unstarted", "position": 1},
    {"id": "s-prog", "name": "In Progress", "type": "started", "position": 2},
    {"id": "s-review", "name": "In Review", "type": "started", "position": 3},
    {"id": "s-done", "name": "Done", "type": "completed", "position": 4},
]


def test_pick_state_by_type_prefers_name_match():
    assert pick_state_by_type(STATES, "started", "In Progress")["id"] == "s-prog"


def test_pick_state_by_type_falls_back_to_lowest_position():
    # No "Working" name match → lowest-position started state (In Progress @2).
    assert pick_state_by_type(STATES, "started", "Working")["id"] == "s-prog"


def test_pick_state_by_type_resolves_completed_done():
    assert pick_state_by_type(STATES, "completed", "Done")["id"] == "s-done"


def test_pick_state_by_type_returns_none_when_absent():
    assert pick_state_by_type(STATES, "canceled", "Canceled") is None


def test_resolve_max_concurrent_reflects_agent_config():
    from ai_fleet.store import get_agent_config

    try:
        configured = float(get_agent_config().get("maxConcurrentCoders"))
    except (TypeError, ValueError):
        configured = float("nan")
    resolved = orchestrator._test.resolve_max_concurrent()
    assert isinstance(resolved, int) and resolved >= 1
    import math as _math

    if _math.isfinite(configured) and configured >= 1:
        assert resolved == _math.floor(configured)


def _now_ms():
    import time

    return int(time.time() * 1000)
