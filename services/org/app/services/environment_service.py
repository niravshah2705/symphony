"""Login-triggered environment initialization (org side).

A signed-in user should not have to know which infrastructure their organization
is missing. On login (and registration) this opens a durable run describing the
environment the org *should* have and walks the steps in the background, after
the token response has already gone out — the request never waits on a cluster.

Why a document and not a task queue: the run must survive the process that
started it. Its id is derived from the org plus a content hash of the desired
state (`desired_revision`), so a stampede of logins resolves to one document
(`create_if_absent`), a completed revision is never re-published, and a retry
re-executes steps inside the same record. Every step is an upsert, which is what
makes "per-step re-run" safe rather than merely possible.

Steps that touch infrastructure the org service cannot reach (the in-cluster
Substrate atespace) are published to the provisioner on the existing provisioning
topic and answered through `set_step_status` below, so this module holds no cloud
credential and the provisioner never owns the status machine.
"""
from __future__ import annotations

import hashlib
import re
import uuid

from app.core.config import get_settings
from app.core.database import Uow, new_uow
from app.models.base import utcnow
from app.models.enums import (
    EnvironmentRunStatus,
    EnvironmentStepStatus,
    EnvironmentTrigger,
)
from app.models.environment_run import EnvironmentRun, step
from app.models.organization import Organization
from app.repositories.environment_run_repo import EnvironmentRunRepository
from app.repositories.org_repo import OrgRepository
from app.repositories.user_repo import UserRepository
from app.services import provisioning_service

# Bumped when the step set or a step's meaning changes, so every org's next login
# opens a fresh run against the new definition instead of inheriting an old run's
# COMPLETED verdict.
STEP_VERSION = 1

# Order matters: the atespace binding is what the in-cluster step consumes, and
# the stack must exist before anything can be asked of it.
STEP_KEYS = ("org.seed", "org.atespace.bind", "substrate.atespace", "deploy.stack")

# Same shape the JS provisioner asserts (packages/shared-core/src/provisioning/
# naming.js:SLUG_RE). An atespace is a namespace boundary, so an unvalidated slug
# must never reach a name that is used to create one.
_SLUG_RE = re.compile(r"^t[a-z0-9]{1,48}$")


def atespace_for_slug(slug: str) -> str:
    """The atespace reserved for a tenant.

    Mirrors naming.js:atespace(slug); both sides assert the literal
    `tenant-t3f9a1b2c4d5` in their tests, so changing the formula in one language
    fails in the other instead of silently splitting a tenant across namespaces.
    """
    if not _SLUG_RE.match(slug or ""):
        raise ValueError(f"invalid deployment slug: {slug!r}")
    return f"tenant-{slug}"


def desired_revision(org: Organization) -> str:
    """Content hash of everything the environment is supposed to have.

    Deliberately excludes anything an init run *writes* (the atespace binding, the
    deployment status): including an output would flip the revision after a
    successful run and open a new run forever.
    """
    parts = [f"v{STEP_VERSION}", str(org.id), org.deployment_slug]
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:16]


def _new_run(org: Organization, revision: str, trigger: EnvironmentTrigger,
             requested_by: uuid.UUID | None) -> EnvironmentRun:
    return EnvironmentRun(
        org_id=org.id,
        desired_revision=revision,
        trigger=trigger,
        requested_by=requested_by,
        steps=[step(key) for key in STEP_KEYS],
    )


async def open_run(session: Uow, org: Organization, *, trigger: EnvironmentTrigger,
                   requested_by: uuid.UUID | None = None) -> EnvironmentRun | None:
    """Create (or find) the run for the org's current desired revision.

    None means there is nothing to do: initialization is switched off, or this
    revision is already finished or being worked on. A FAILED run is reopened — the
    next login should try again rather than leave the org waiting on an explicit
    retry click.
    """
    if not get_settings().environment_init_enabled:
        return None
    revision = desired_revision(org)
    repo = EnvironmentRunRepository(session)
    run = _new_run(org, revision, trigger, requested_by)
    if await repo.create_if_absent(run):
        return run
    existing = await repo.get_for_revision(org.id, revision)
    if existing is None:  # pragma: no cover — create says it exists, read says no
        return None
    if existing.status is EnvironmentRunStatus.COMPLETED:
        return None
    if existing.status is EnvironmentRunStatus.RUNNING:
        # An executor holds it. Re-publishing would run the same step twice; the
        # status endpoint shows the truth and retry is the escape hatch.
        return None
    existing.status = EnvironmentRunStatus.PENDING
    existing.trigger = trigger
    existing.requested_by = requested_by or existing.requested_by
    for record in existing.steps:
        if record.get("status") != EnvironmentStepStatus.COMPLETED.value:
            record["status"] = EnvironmentStepStatus.PENDING.value
            record["detail"] = None
            record["updated_at"] = utcnow()
    existing.updated_at = utcnow()
    return existing


def _reconcile(run: EnvironmentRun) -> None:
    """Derive the run's status from its steps — in one place, so the background
    executor and the provisioner write-back cannot disagree about what "done"
    means while an asynchronous step is still outstanding."""
    statuses = {record.get("status") for record in run.steps}
    if EnvironmentStepStatus.FAILED.value in statuses:
        run.status = EnvironmentRunStatus.FAILED
    elif statuses & {
        EnvironmentStepStatus.PENDING.value,
        EnvironmentStepStatus.RUNNING.value,
    }:
        # Something is still in flight — an async step the provisioner has not
        # answered, or a step this pass did not reach.
        run.status = EnvironmentRunStatus.RUNNING
    else:
        run.status = EnvironmentRunStatus.COMPLETED
    run.updated_at = utcnow()


async def run_steps(session: Uow, run: EnvironmentRun, *, force_step: str | None = None) -> EnvironmentRun:
    """Execute every step that has not already completed.

    Each step is an upsert, so a partial run resumes where it stopped, and
    `force_step` re-runs exactly one thing without disturbing its siblings.
    """
    org = await OrgRepository(session).get(run.org_id)
    if org is None:
        run.status = EnvironmentRunStatus.FAILED
        run.updated_at = utcnow()
        return run
    user = None
    if run.requested_by is not None:
        user = await UserRepository(session).get_by_id(run.requested_by)

    run.attempted_revision = run.desired_revision
    run.status = EnvironmentRunStatus.RUNNING
    for record in run.steps:
        key = record.get("key")
        if force_step is not None and key != force_step:
            continue
        if force_step is None and record.get("status") == EnvironmentStepStatus.COMPLETED.value:
            continue
        record["status"] = EnvironmentStepStatus.RUNNING.value
        record["updated_at"] = utcnow()
        try:
            status, detail = await _execute_step(key, session, org, run, user)
        except Exception as err:  # a step failing must not lose the others
            record["status"] = EnvironmentStepStatus.FAILED.value
            # Kept in a dict: `detail` is typed as structured progress everywhere
            # downstream (the SPA renders it), so a bare exception string would
            # be a different shape on exactly the records that matter most.
            record["detail"] = {"error": f"{type(err).__name__}: {err}"}
        else:
            record["status"] = status
            record["detail"] = detail
        _reconcile(run)
        # Flush after every step: a process that dies mid-run must leave the
        # completed steps visible, not a document that claims nothing happened.
        await session.flush()
    _reconcile(run)
    return run


async def _execute_step(key: str, session: Uow, org: Organization, run: EnvironmentRun,
                        user) -> tuple[str, dict | None]:
    """Run one step, returning (step status, detail)."""
    settings = get_settings()

    if key == "org.seed":
        if user is None:
            raise RuntimeError("environment init requires the requesting user")
        from app.services import onboarding_service

        project = await onboarding_service.ensure_default_project_for_org(session, org, user)
        return EnvironmentStepStatus.COMPLETED.value, {"project_id": str(project.id)}

    if key == "org.atespace.bind":
        bound = atespace_for_slug(org.deployment_slug)
        changed = org.substrate_atespace != bound
        org.substrate_atespace = bound
        return EnvironmentStepStatus.COMPLETED.value, {"atespace": bound, "changed": changed}

    if key == "substrate.atespace":
        atespace = org.substrate_atespace or atespace_for_slug(org.deployment_slug)
        await provisioning_service.publish_provisioning_request(
            settings.gcp_project_id,
            settings.provisioning_topic,
            {
                "org_id": str(org.id),
                "slug": org.deployment_slug,
                "action": "substrate-atespace",
                "run_id": str(run.id),
                "step_key": key,
                "atespace": atespace,
            },
        )
        # RUNNING, not COMPLETED: the cluster has only been *asked*. The
        # provisioner settles this step through the internal write-back, and a
        # deployment without a substrate answers it SKIPPED with its reason.
        return EnvironmentStepStatus.RUNNING.value, {"requested": atespace}

    if key == "deploy.stack":
        before = (org.deployments or {}).get("status")
        await provisioning_service.trigger_provisioning(session, org)
        return (
            EnvironmentStepStatus.COMPLETED.value,
            {"status_before": before, "status": (org.deployments or {}).get("status")},
        )

    raise RuntimeError(f"unknown environment step {key!r}")


async def set_step_status(session: Uow, org_id: uuid.UUID, run_id: uuid.UUID, *,
                          step_key: str, status: str, detail: dict | None = None) -> EnvironmentRun:
    """Apply an asynchronous step answer (provisioner write-back).

    Raises KeyError, which the route turns into a 404: a run address the caller
    named but does not own is indistinguishable from one that does not exist, and
    org isolation must not leak which ids are real.
    """
    repo = EnvironmentRunRepository(session)
    run = await repo.get(org_id, run_id)
    record = run.step(step_key) if run is not None else None
    if record is None:
        raise KeyError(f"{run_id}:{step_key}")
    record["status"] = EnvironmentStepStatus(status).value
    record["detail"] = detail
    record["updated_at"] = utcnow()
    _reconcile(run)
    return run


async def latest_run(session: Uow, org_id: uuid.UUID) -> EnvironmentRun | None:
    """The org's most recent run, whatever its state — what the status endpoint shows."""
    return await EnvironmentRunRepository(session).latest(org_id)


async def execute_detached(org_id: uuid.UUID, run_id: uuid.UUID) -> None:
    """Walk the steps on a standalone unit of work, outside the request.

    The request-scoped session is torn down before background tasks run, so this
    opens its own (`new_uow`) and commits explicitly.
    """
    session = new_uow()
    run = await EnvironmentRunRepository(session).get(org_id, run_id)
    if run is None:
        return
    await run_steps(session, run)
    await session.commit()


async def trigger_init(background, session: Uow, org: Organization, *,
                       trigger: EnvironmentTrigger, requested_by: uuid.UUID | None) -> None:
    """Open the run, make it durable, then queue its execution after the response.

    The explicit commit breaks the "services never commit" convention on purpose:
    FastAPI closes a yield-dependency before it runs background tasks, so a run
    that was only flushed at teardown would be invisible to its own executor.
    """
    run = await open_run(session, org, trigger=trigger, requested_by=requested_by)
    if run is None:
        return
    await session.commit()
    background.add_task(execute_detached, org.id, run.id)


async def init_for_user(background, session: Uow, user, *,
                        trigger: EnvironmentTrigger) -> None:
    """Open and queue the run for a signed-in user's own organization.

    Takes the *user*, never an org id: sign-in is the one moment the caller's
    identity is already verified, and a request-supplied org id would turn login
    into a way to poke another tenant's infrastructure. A user with no org has no
    environment to initialize — the shared stack needs none.
    """
    if not get_settings().environment_init_enabled or user.org_id is None:
        return
    org = await OrgRepository(session).get(user.org_id)
    if org is None:  # pragma: no cover — the membership outlived its org doc
        return
    await trigger_init(background, session, org, trigger=trigger, requested_by=user.id)


async def retry(session: Uow, org_id: uuid.UUID, step_key: str | None = None) -> EnvironmentRun | None:
    """Re-run one step (or every unfinished step) of the org's latest run,
    synchronously, in the caller's session."""
    repo = EnvironmentRunRepository(session)
    run = await repo.latest(org_id)
    if run is None:
        return None
    if step_key is not None:
        if run.step(step_key) is None:
            raise KeyError(step_key)
        record = run.step(step_key)
        record["status"] = EnvironmentStepStatus.PENDING.value
        record["detail"] = None
    run.trigger = EnvironmentTrigger.RETRY
    return await run_steps(session, run, force_step=step_key)
