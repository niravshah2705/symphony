"""Project-invitation endpoints.

Management (create/list/revoke) is gated by project-admin authority on the
target project. **Accept** lives on a separate, project-context-free path
(``/project-invitations/accept``) because the invitee is not yet a member — they
have no project context to resolve — so it is authenticated-only, then gated by
the single-use token and an email match inside the service.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status

from app.auth.dependencies import get_current_user, get_principal
from app.authz.guards import ProjectContext, require_project
from app.authz.policy import can_manage_project_collaborators
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.models.user import User
from app.schemas.project_invitation import (
    ProjectInvitationAccept,
    ProjectInvitationAcceptanceResponse,
    ProjectInvitationCreate,
    ProjectInvitationDeliveryResponse,
    ProjectInvitationResponse,
)
from app.services import project_invitation_service

router = APIRouter(prefix="/projects/{project_id}/invitations", tags=["project-invitations"])
# Accept is deliberately NOT nested under the project (the invitee has no
# project context yet); it is authenticated-only and token-gated in the service.
accept_router = APIRouter(prefix="/project-invitations", tags=["project-invitations"])


@router.post(
    "",
    response_model=ProjectInvitationDeliveryResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_project_invitation(
    body: ProjectInvitationCreate,
    ctx: ProjectContext = Depends(require_project(can_manage_project_collaborators)),
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
):
    return await project_invitation_service.create_project_invitation(
        session, principal, ctx.project, body
    )


@router.get("", response_model=list[ProjectInvitationResponse])
async def list_project_invitations(
    ctx: ProjectContext = Depends(require_project(can_manage_project_collaborators)),
    session: Uow = Depends(get_session),
):
    return await project_invitation_service.list_project_invitations(session, ctx.project)


@router.delete("/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_project_invitation(
    invitation_id: uuid.UUID,
    ctx: ProjectContext = Depends(require_project(can_manage_project_collaborators)),
    session: Uow = Depends(get_session),
) -> None:
    await project_invitation_service.revoke_project_invitation(
        session, ctx.project, invitation_id
    )


@accept_router.post("/accept", response_model=ProjectInvitationAcceptanceResponse)
async def accept_project_invitation(
    body: ProjectInvitationAccept,
    user: User = Depends(get_current_user),
    session: Uow = Depends(get_session),
):
    return await project_invitation_service.accept_project_invitation(
        session, user, body.token
    )
