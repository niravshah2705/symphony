"""Project external-org grant endpoints (outsourcing a project to a partner org).

Gated by project-admin authority on the target project. The grant records that
every member of ``collaborator_org_id`` may access this project; enforcement
happens in ``resolve_project_access``.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status

from app.auth.dependencies import get_principal
from app.authz.guards import ProjectContext, require_project
from app.authz.policy import can_manage_project_collaborators
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.schemas.project_grant import ExternalGrantCreate, ExternalGrantResponse
from app.services import project_external_grant_service

router = APIRouter(
    prefix="/projects/{project_id}/external-grants", tags=["project-external-grants"]
)


@router.post("", response_model=ExternalGrantResponse, status_code=status.HTTP_201_CREATED)
async def create_external_grant(
    body: ExternalGrantCreate,
    ctx: ProjectContext = Depends(require_project(can_manage_project_collaborators)),
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    return await project_external_grant_service.create_external_grant(
        session, principal, ctx.project, body
    )


@router.get("", response_model=list[ExternalGrantResponse])
async def list_external_grants(
    ctx: ProjectContext = Depends(require_project(can_manage_project_collaborators)),
    session: Uow = Depends(get_session),
):
    return await project_external_grant_service.list_external_grants(session, ctx.project)


@router.delete("/{collaborator_org_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_external_grant(
    collaborator_org_id: uuid.UUID,
    ctx: ProjectContext = Depends(require_project(can_manage_project_collaborators)),
    session: Uow = Depends(get_session),
) -> None:
    await project_external_grant_service.revoke_external_grant(
        session, ctx.project, collaborator_org_id
    )
