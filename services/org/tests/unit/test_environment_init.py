"""Stage D — login-triggered environment initialization.

The run document is the whole feature: its id is the idempotency key, its steps
are the progress the SPA reads, and its asynchronous step is only settled when the
provisioner writes back. These tests pin those three properties, plus the two
`/me` endpoints and the internal write-back guard.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from app.core.config import get_settings
from app.models.enums import EnvironmentRunStatus, EnvironmentStepStatus, OrgRole
from app.models.organization import Organization
from app.models.user import User
from app.repositories.base import environment_runs_col
from app.repositories.environment_run_repo import EnvironmentRunRepository
from app.repositories.org_repo import OrgRepository
from app.repositories.user_repo import UserRepository
from app.services import environment_service, provisioning_service
from tests.helpers import auth, login, register

TOKEN = "internal-secret-token"


def _enable(monkeypatch, *, init=True, provisioning=False):
    monkeypatch.setattr(get_settings(), "environment_init_enabled", init)
    monkeypatch.setattr(get_settings(), "provisioning_enabled", provisioning)
    monkeypatch.setattr(get_settings(), "gcp_project_id", "proj")
    monkeypatch.setattr(get_settings(), "provisioning_topic", "tenant-provision")
    published = []

    async def _fake(project_id, topic, message):
        published.append(message)

    monkeypatch.setattr(provisioning_service, "publish_provisioning_request", _fake)
    return published


async def _seed_org(uow) -> tuple[Organization, User]:
    org = Organization(name="Acme", slug="opaqueslug1")
    await OrgRepository(uow).add(org)
    user = User(email="admin@acme.com", org_id=org.id, org_role=OrgRole.ORG_ADMIN, email_verified=True)
    await UserRepository(uow).add(user)
    await uow.commit()
    return org, user


# ── the name and the revision ────────────────────────────────────────────────


def test_atespace_name_mirrors_the_provisioner():
    # Same literal as packages/shared-core/src/provisioning/provisioning.test.js.
    assert environment_service.atespace_for_slug("t3f9a1b2c4d5") == "tenant-t3f9a1b2c4d5"


@pytest.mark.parametrize("slug", ["", "acme", "T3F9A1B2C4D5", "t/too/many", "t" + "x" * 49])
def test_atespace_name_refuses_a_slug_that_is_not_one(slug):
    with pytest.raises(ValueError, match="invalid deployment slug"):
        environment_service.atespace_for_slug(slug)


@pytest.mark.asyncio
async def test_revision_is_stable_across_the_run_own_output(db_session, monkeypatch):
    _enable(monkeypatch)
    org, user = await _seed_org(db_session)
    revision = environment_service.desired_revision(org)

    run = await environment_service.open_run(db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN,
                                             requested_by=user.id)
    await environment_service.run_steps(db_session, run)
    await db_session.commit()

    # Writing the atespace binding and the deployments map must not move the
    # revision, or a successful run would open the next one forever.
    assert org.substrate_atespace == f"tenant-{org.deployment_slug}"
    assert environment_service.desired_revision(org) == revision
    assert run.desired_revision == revision
    assert run.attempted_revision == revision


# ── one document per revision, however many logins ───────────────────────────


@pytest.mark.asyncio
async def test_concurrent_logins_open_one_run(db_session, monkeypatch):
    """The stampede case: a page that fires several authenticated requests in one
    second must produce one run, not one per request."""
    _enable(monkeypatch)
    org, user = await _seed_org(db_session)

    runs = await asyncio.gather(*[
        environment_service.open_run(
            db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN, requested_by=user.id)
        for _ in range(4)
    ])

    assert {run.id for run in runs} == {runs[0].id}
    docs = await db_session.query(environment_runs_col(org.id), None)
    assert [doc["id"] for doc in docs] == [str(runs[0].id)]


@pytest.mark.asyncio
async def test_disabled_deployment_touches_nothing(db_session, monkeypatch):
    _enable(monkeypatch, init=False)
    org, user = await _seed_org(db_session)
    assert await environment_service.open_run(
        db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN, requested_by=user.id) is None


@pytest.mark.asyncio
async def test_completed_revision_is_never_republished(db_session, monkeypatch):
    published = _enable(monkeypatch)
    org, user = await _seed_org(db_session)
    run = await environment_service.open_run(
        db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN, requested_by=user.id)
    await environment_service.run_steps(db_session, run)
    await _settle_substrate_step(db_session, run)
    await db_session.commit()
    publishes = len(published)

    assert await environment_service.open_run(
        db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN, requested_by=user.id) is None
    assert len(published) == publishes, "a second login on a finished revision publishes nothing"


# ── step semantics ───────────────────────────────────────────────────────────


async def _settle_substrate_step(session, run):
    """What the provisioner's write-back does, called in-process."""
    return await environment_service.set_step_status(
        session, run.org_id, run.id,
        step_key="substrate.atespace", status=EnvironmentStepStatus.COMPLETED.value,
        detail={"atespace": run.step("substrate.atespace")["detail"]["requested"], "created": True},
    )


@pytest.mark.asyncio
async def test_substrate_step_stays_running_until_the_provisioner_answers(db_session, monkeypatch):
    published = _enable(monkeypatch)
    org, user = await _seed_org(db_session)
    run = await environment_service.open_run(
        db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN, requested_by=user.id)
    await environment_service.run_steps(db_session, run)

    assert published == [{
        "org_id": str(org.id), "slug": org.deployment_slug, "action": "substrate-atespace",
        "run_id": str(run.id), "step_key": "substrate.atespace",
        "atespace": f"tenant-{org.deployment_slug}",
    }]
    # Asked is not done: only the provisioner knows whether the namespace exists.
    assert run.step("substrate.atespace")["status"] == EnvironmentStepStatus.RUNNING.value
    assert run.status is EnvironmentRunStatus.RUNNING

    await _settle_substrate_step(db_session, run)
    await db_session.commit()
    assert run.step("substrate.atespace")["status"] == EnvironmentStepStatus.COMPLETED.value
    assert run.status is EnvironmentRunStatus.COMPLETED


@pytest.mark.asyncio
async def test_skipped_answer_completes_the_run(db_session, monkeypatch):
    _enable(monkeypatch)
    org, user = await _seed_org(db_session)
    run = await environment_service.open_run(
        db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN, requested_by=user.id)
    await environment_service.run_steps(db_session, run)

    await environment_service.set_step_status(
        db_session, org.id, run.id, step_key="substrate.atespace",
        status=EnvironmentStepStatus.SKIPPED.value,
        detail={"reason": "no substrate control plane configured"},
    )
    # SKIPPED is an answer, not an outstanding request.
    assert run.status is EnvironmentRunStatus.COMPLETED
    assert run.step("substrate.atespace")["detail"]["reason"].startswith("no substrate")


@pytest.mark.asyncio
async def test_a_failing_step_fails_the_run_without_losing_the_others(db_session, monkeypatch):
    _enable(monkeypatch)
    org, user = await _seed_org(db_session)

    async def _explode(*args, **kwargs):
        raise RuntimeError("CreateAtespace failed (14): unavailable")

    monkeypatch.setattr(provisioning_service, "publish_provisioning_request", _explode)
    run = await environment_service.open_run(
        db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN, requested_by=user.id)
    await environment_service.run_steps(db_session, run)

    assert run.status is EnvironmentRunStatus.FAILED
    assert run.step("substrate.atespace")["detail"]["error"].startswith("RuntimeError:")
    assert run.step("org.atespace.bind")["status"] == EnvironmentStepStatus.COMPLETED.value

    # The next login reopens it — an org must not need an explicit retry click.
    reopened = await environment_service.open_run(
        db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN, requested_by=user.id)
    assert reopened.id == run.id
    assert reopened.status is EnvironmentRunStatus.PENDING


@pytest.mark.asyncio
async def test_retry_of_one_step_leaves_its_siblings_alone(db_session, monkeypatch):
    published = _enable(monkeypatch)
    org, user = await _seed_org(db_session)
    run = await environment_service.open_run(
        db_session, org, trigger=environment_service.EnvironmentTrigger.LOGIN, requested_by=user.id)
    await environment_service.run_steps(db_session, run)
    before = {s["key"]: s["updated_at"] for s in run.steps}
    publishes = len(published)

    await environment_service.retry(db_session, org.id, "substrate.atespace")

    assert len(published) == publishes + 1, "only the substrate step re-published"
    assert published[-1]["step_key"] == "substrate.atespace"
    after = {s["key"]: s["updated_at"] for s in run.steps}
    assert after["org.seed"] == before["org.seed"], "a sibling was re-executed"
    assert run.step("deploy.stack")["status"] == EnvironmentStepStatus.COMPLETED.value
    assert run.trigger is environment_service.EnvironmentTrigger.RETRY


# ── the two /me endpoints, and the write-back guard ─────────────────────────


@pytest.mark.asyncio
async def test_me_environment_without_init_reports_the_deployment_only(client, monkeypatch):
    _enable(monkeypatch, init=False)
    token = (await register(client)).json()["access_token"]

    body = (await client.get("/api/v1/me/environment", headers=auth(token))).json()
    assert body["initialized"] is False
    assert body["steps"] == []
    assert body["deployment"]["status"] == "shared"
    assert body["run_id"] is None


@pytest.mark.asyncio
async def test_me_environment_walks_steps_after_login(client, monkeypatch):
    _enable(monkeypatch)
    await register(client)
    token = await login(client, "admin@acme.com")

    body = (await client.get("/api/v1/me/environment", headers=auth(token))).json()
    assert body["initialized"] is True
    assert body["status"] == "RUNNING"
    assert [s["key"] for s in body["steps"]] == [
        "org.seed", "org.atespace.bind", "substrate.atespace", "deploy.stack"]
    assert body["steps"][1]["detail"]["atespace"].startswith("tenant-t")
    assert body["deployment"]["status"] == "shared", "embedded, not re-derived"

    settled = await client.post(
        "/api/v1/me/environment/retry", headers=auth(token), json={"step": "deploy.stack"})
    assert settled.status_code == 200
    assert settled.json()["steps"][3]["status"] == "COMPLETED"

    unknown = await client.post("/api/v1/me/environment/retry", headers=auth(token), json={"step": "gw.backends"})
    assert unknown.status_code == 404, "a step this revision never had is not retryable"


@pytest.mark.asyncio
async def test_step_write_back_is_token_gated_and_only_settles(client, monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(get_settings(), "internal_api_token", TOKEN)
    token = (await register(client)).json()["access_token"]
    run_id = (await client.get("/api/v1/me/environment", headers=auth(token))).json()["run_id"]
    org_id = (await client.get("/api/v1/me/deployment", headers=auth(token))).json()["org_id"]
    path = f"/api/v1/internal/orgs/{org_id}/environment_runs/{run_id}/steps/substrate.atespace"
    headers = {"X-Internal-Token": TOKEN}

    assert (await client.patch(path, json={"status": "COMPLETED"})).status_code == 403, "no token"
    assert (await client.patch(path, json={"status": "RUNNING"}, headers=headers)).status_code == 422, \
        "a worker may not rewind work that is already done"
    assert (await client.patch(
        f"/api/v1/internal/orgs/{uuid.uuid4()}/environment_runs/{run_id}/steps/substrate.atespace",
        json={"status": "COMPLETED"}, headers=headers)).status_code == 404, "another org's run is not there"

    ok = await client.patch(path, json={"status": "COMPLETED", "detail": {"created": False, "existed": True}},
                            headers=headers)
    assert ok.status_code == 200
    assert ok.json()["run_status"] == "COMPLETED"
    body = (await client.get("/api/v1/me/environment", headers=auth(token))).json()
    assert body["steps"][2]["detail"] == {"created": False, "existed": True}
