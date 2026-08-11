"""Selected-organization invitation endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status

from app.auth.dependencies import get_current_user, get_principal
from app.authz.guards import require_org_admin
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.models.user import User
from app.schemas.invitation import (
    InvitationAccept,
    InvitationAcceptanceResponse,
    InvitationCreate,
    InvitationDeliveryResponse,
    InvitationResponse,
)
from app.services import invitation_service

router = APIRouter(prefix="/invitations", tags=["invitations"])


@router.post("", response_model=InvitationDeliveryResponse, status_code=status.HTTP_201_CREATED)
async def create_invitation(
    body: InvitationCreate,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await invitation_service.create_invitation(session, principal, body)


@router.get("", response_model=list[InvitationResponse])
async def list_invitations(
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await invitation_service.list_invitations(session, principal)


@router.post("/{invitation_id}/resend", response_model=InvitationDeliveryResponse)
async def resend_invitation(
    invitation_id: uuid.UUID,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    return await invitation_service.resend_invitation(session, principal, invitation_id)


@router.delete("/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invitation(
    invitation_id: uuid.UUID,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
) -> None:
    await invitation_service.revoke_invitation(session, principal, invitation_id)


@router.post("/accept", response_model=InvitationAcceptanceResponse)
async def accept_invitation(
    body: InvitationAccept,
    principal: Principal = Depends(get_principal),
    user: User = Depends(get_current_user),
    session: Uow = Depends(get_session),
):
    return await invitation_service.accept_invitation(
        session, principal, user, body.token
    )
