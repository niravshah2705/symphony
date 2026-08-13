"""Direct operator-only surfaces that must never be routed through the gateway."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.authz.guards import require_org_admin
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.schemas.codex_tokens import CodexTokenImportRequest, CodexTokenStatus
from app.schemas.deployment_approval import (
    DeploymentApprovalCreateRequest,
    DeploymentApprovalResponse,
    validate_run_id,
)
from app.errors import ValidationAppError
from app.services import deployment_approval_service, secrets_service

router = APIRouter(prefix="/operator", tags=["operator"])


@router.put("/org/codex-tokens", response_model=CodexTokenStatus)
async def import_codex_tokens(
    body: CodexTokenImportRequest,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await secrets_service.import_codex_tokens(session, principal, body)


@router.delete("/org/codex-tokens", response_model=CodexTokenStatus)
async def delete_codex_tokens(
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await secrets_service.delete_codex_tokens(session, principal)


@router.put(
    "/deployment-approvals/{run_id}",
    response_model=DeploymentApprovalResponse,
)
async def approve_deployment(
    run_id: str,
    body: DeploymentApprovalCreateRequest,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    """Grant or replace an unconsumed, short-lived approval for one run.

    This direct org-admin surface is intentionally blocked by the browser
    gateway. The orchestrator consumes it only after a successful test result.
    """
    try:
        normalized_run_id = validate_run_id(run_id)
    except ValueError as exc:
        raise ValidationAppError(str(exc)) from exc
    return await deployment_approval_service.approve(
        session, principal, normalized_run_id, body
    )
