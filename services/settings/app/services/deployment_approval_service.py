"""Issue and atomically consume post-test deployment approvals."""
from __future__ import annotations

import uuid
from datetime import timedelta

from app.authz.principal import Principal
from app.core.database import Uow
from app.core.timeutils import ensure_aware, utcnow
from app.errors import ConflictError, NotFoundError
from app.repositories.base import org_deployment_approvals_col
from app.schemas.deployment_approval import (
    DeploymentApprovalConsumeRequest,
    DeploymentApprovalCreateRequest,
    DeploymentApprovalResponse,
)


def _response(doc: dict) -> DeploymentApprovalResponse:
    return DeploymentApprovalResponse(
        approval_id=doc["approval_id"],
        run_id=doc["run_id"],
        project_id=doc["project_id"],
        repository=doc["repository"],
        environment=doc["environment"],
        test_command_id=doc["test_command_id"],
        commit_sha=doc["commit_sha"],
        tree_sha=doc["tree_sha"],
        preflight_decision_digest=doc["preflight_decision_digest"],
        approved=True,
        approved_by=doc["approved_by"],
        approved_at=doc["approved_at"],
        expires_at=doc["expires_at"],
        consumed_at=doc.get("consumed_at"),
    )


async def approve(
    session: Uow,
    principal: Principal,
    run_id: str,
    body: DeploymentApprovalCreateRequest,
) -> DeploymentApprovalResponse:
    if principal.org_id is None:  # require_org_admin normally makes this unreachable
        raise NotFoundError("Organization not found")
    collection = org_deployment_approvals_col(principal.org_id)
    now = utcnow()
    if not body.test_command_id.startswith(f"{run_id}:test:"):
        raise ConflictError(
            "The test command does not belong to this pipeline run",
            code="deployment_not_approved",
        )

    async def write(txn):  # type: ignore[no-untyped-def]
        existing = await txn.get(collection, run_id)
        if existing and existing.get("consumed_at") is not None:
            raise ConflictError("A consumed deployment approval cannot be replaced")
        doc = {
            "approval_id": run_id,
            "run_id": run_id,
            "org_id": str(principal.org_id),
            "project_id": str(body.project_id),
            "repository": body.repository,
            "environment": body.environment,
            "test_command_id": body.test_command_id,
            "commit_sha": body.commit_sha,
            "tree_sha": body.tree_sha,
            "preflight_decision_digest": body.preflight_decision_digest,
            "approved_by": principal.email or str(principal.user_id),
            "approved_at": now,
            "expires_at": now + timedelta(minutes=body.expires_in_minutes),
            "consumed_at": None,
        }
        txn.set(collection, run_id, doc)
        return doc

    return _response(await session.db.run_transaction(write))


async def consume(
    session: Uow,
    org_id: uuid.UUID,
    run_id: str,
    body: DeploymentApprovalConsumeRequest,
) -> DeploymentApprovalResponse:
    collection = org_deployment_approvals_col(org_id)
    now = utcnow()
    if not body.test_command_id.startswith(f"{run_id}:test:"):
        raise NotFoundError("Deployment approval not found", code="deployment_not_approved")

    async def update(txn):  # type: ignore[no-untyped-def]
        doc = await txn.get(collection, run_id)
        if not doc:
            raise NotFoundError("Deployment approval not found", code="deployment_not_approved")
        if (
            str(doc.get("project_id")) != str(body.project_id)
            or doc.get("repository") != body.repository
            or doc.get("environment") != body.environment
            or doc.get("test_command_id") != body.test_command_id
            or doc.get("commit_sha") != body.commit_sha
            or doc.get("tree_sha") != body.tree_sha
            or doc.get("preflight_decision_digest")
            != body.preflight_decision_digest
        ):
            raise NotFoundError("Deployment approval not found", code="deployment_not_approved")
        expires_at = ensure_aware(doc.get("expires_at"))
        approved_at = ensure_aware(doc.get("approved_at"))
        test_completed_at = ensure_aware(body.test_completed_at)
        if doc.get("consumed_at") is not None:
            consumed_test_completed_at = ensure_aware(
                doc.get("consumed_test_completed_at")
            )
            if (
                consumed_test_completed_at is None
                or test_completed_at is None
                or consumed_test_completed_at != test_completed_at
            ):
                raise NotFoundError(
                    "Deployment approval not found",
                    code="deployment_not_approved",
                )
            # The exact consumption may be replayed after expiry so an
            # orchestrator crash between settings consumption and durable claim
            # persistence cannot permanently brick the run. Scope, lineage and
            # the original test completion timestamp all matched above.
            return doc
        if expires_at is None or expires_at < now:
            raise ConflictError("Deployment approval expired", code="deployment_not_approved")
        if approved_at is None or test_completed_at is None or approved_at < test_completed_at:
            raise ConflictError(
                "Deployment approval must be granted after the successful test stage",
                code="deployment_not_approved",
            )
        if doc.get("consumed_at") is None:
            doc = {
                **doc,
                "consumed_at": now,
                "consumed_test_completed_at": test_completed_at,
            }
            txn.set(collection, run_id, doc)
        return doc

    return _response(await session.db.run_transaction(update))
