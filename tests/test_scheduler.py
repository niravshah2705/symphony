"""Port of packages/shared/src/agent/scheduler.test.js.

Dependencies (store, linear, generate_plan, apply_*, sweep) are injected as
fakes, mirroring the JS ``deps``/fake-store seams. The self-scheduling asyncio
timer is never started — ``run_job`` / ``verify_model_readiness`` /
``process_approval_deadlines`` are exercised directly.
"""

import json
import re
from types import SimpleNamespace

import pytest

from ai_fleet.agent import scheduler
from ai_fleet.agent.availability import AgentAvailabilityError
from ai_fleet.agent.plan import AgentError


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    scheduler._test.clear_model_pause()
    # get_status() reads the real store; stub the two reads so tests stay hermetic
    # (and independent of any on-disk data/store.json).
    monkeypatch.setattr(scheduler.store, "get_agent_config", lambda: {"intervalMinutes": 5, "scheduleEnabled": True})
    monkeypatch.setattr(scheduler.store, "list_jobs", lambda kind=None: [])
    yield
    scheduler._test.clear_model_pause()


async def test_model_outage_keeps_job_pending_and_preflight_clears_pause():
    job = {
        "id": "job-1",
        "projectId": "project-1",
        "projectName": "Project",
        "assumedRole": {"id": "role-1", "name": "Planner"},
        "status": "pending",
        "error": "old pause message",
        "pauseReason": {"code": "model-unavailable"},
        "steps": [],
    }
    added = {"n": 0}

    class FakeStore:
        def add_job(self, _job):
            added["n"] += 1

        def update_job(self, id, patch):
            assert id == job["id"]
            job.update(patch)
            return job

        def append_job_step(self, id, step):
            assert id == job["id"]
            job["steps"].append(step)

    fake_store = FakeStore()
    llm = {"provider": "codex", "model": "gpt-test"}

    async def get_milestones_empty(*_a, **_k):
        return {"project": {"id": "project-1"}, "milestones": []}

    async def generate_plan_unavailable(**_kwargs):
        raise AgentAvailabilityError("model", "raw provider 403 detail", 403)

    result = await scheduler._test.run_job(
        job,
        {"apiKey": "linear-key", "keys": {}, "llm": llm, "config": {"createIssues": True}},
        {
            "store": fake_store,
            "get_settings": lambda: {"llmProvider": "codex"},
            "linear": SimpleNamespace(get_milestones_with_issue_counts=get_milestones_empty),
            "generate_plan": generate_plan_unavailable,
        },
    )

    assert result["paused"] is True
    assert added["n"] == 0, "an unavailable retry must not enqueue a duplicate job"
    assert job["status"] == "pending", "the same job remains the sole active retry candidate"
    assert job["startedAt"] is None
    assert job["finishedAt"] is None
    assert job["pauseReason"]["resource"] == "model"
    assert re.search(r"model is unavailable", job["error"], re.IGNORECASE)
    assert "raw provider 403 detail" not in json.dumps(job)
    assert scheduler.get_status()["paused"] is True

    async def resolve_ok(*_a, **_k):
        return llm

    async def probe_ok(*_a, **_k):
        return {"available": True}

    ready = await scheduler._test.verify_model_readiness(
        {"llmProvider": "codex"},
        {"resolve_llm": resolve_ok, "probe_model_availability": probe_ok},
    )
    assert ready is llm
    assert scheduler.get_status()["paused"] is False
    assert scheduler.get_status()["pauseReason"] is None

    async def get_milestones_one(*_a, **_k):
        return {"project": {"id": "project-1"}, "milestones": [{"id": "milestone-1", "issueCount": 1}]}

    async def apply_aiplanned_ok(*_a, **_k):
        return {"applied": True}

    await scheduler._test.run_job(
        job,
        {"apiKey": "linear-key", "keys": {}, "llm": llm, "config": {"createIssues": True}},
        {
            "store": fake_store,
            "get_settings": lambda: {"llmProvider": "codex"},
            "linear": SimpleNamespace(get_milestones_with_issue_counts=get_milestones_one),
            "apply_aiplanned": apply_aiplanned_ok,
        },
    )
    assert added["n"] == 0
    assert job["id"] == "job-1"
    assert job["status"] == "done"
    assert job["error"] is None
    assert job["pauseReason"] is None


async def test_invalid_model_output_is_job_error_not_global_pause():
    job = {
        "id": "job-invalid-output",
        "projectId": "project-2",
        "projectName": "Project",
        "assumedRole": {"id": "role-1", "name": "Planner"},
        "status": "pending",
        "steps": [],
    }

    class FakeStore:
        def update_job(self, _id, patch):
            job.update(patch)
            return job

        def append_job_step(self, _id, step):
            job["steps"].append(step)

    async def get_milestones_empty(*_a, **_k):
        return {"project": {"id": "project-2"}, "milestones": []}

    async def generate_plan_invalid(**_kwargs):
        raise AgentError("Plan failed validation.", 502, code="model_output_invalid")

    result = await scheduler._test.run_job(
        job,
        {"apiKey": "linear-key", "keys": {}, "llm": {"provider": "codex", "model": "gpt-test"}, "config": {"createIssues": True}},
        {
            "store": FakeStore(),
            "get_settings": lambda: {"llmProvider": "codex"},
            "linear": SimpleNamespace(get_milestones_with_issue_counts=get_milestones_empty),
            "generate_plan": generate_plan_invalid,
        },
    )

    assert re.search(r"validation", result["error"], re.IGNORECASE)
    assert job["status"] == "error"
    assert scheduler.get_status()["paused"] is False
    assert scheduler.get_status()["pauseReason"] is None


async def test_process_approval_deadlines_delegates_and_swallows_errors():
    called = {"n": 0}

    async def sweep_ok(*_a, **_k):
        called["n"] += 1
        return []

    # runs with no Linear key/role — it is not gated by process_pending.
    await scheduler._test.process_approval_deadlines({"sweep_expired_gates": sweep_ok})
    assert called["n"] == 1

    async def sweep_boom(*_a, **_k):
        raise Exception("boom")

    # a failing sweep cannot break the scheduling loop.
    res = await scheduler._test.process_approval_deadlines({"sweep_expired_gates": sweep_boom})
    assert res == {"error": True}
