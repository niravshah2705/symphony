"""User / member management endpoints (org-scoped)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from app.core.database import Uow

from app.api.deps import page_params
from app.auth.dependencies import get_current_user, get_principal
from app.authz.guards import require_org_admin, require_org_member
from app.authz.principal import Principal
from app.core.database import get_session
from app.core.config import get_settings
from app.errors import ForbiddenError
from app.models.user import User
from app.schemas.common import Page, PageParams
from app.schemas.user import (
    ChangePasswordRequest,
    UserAdminUpdate,
    UserCreate,
    UserResponse,
)
from app.services import user_service

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=Page[UserResponse])
async def list_users(
    principal: Principal = Depends(require_org_admin),
    params: PageParams = Depends(page_params),
    session: Uow = Depends(get_session),
):
    rows, total = await user_service.list_users(session, principal, params)
    return Page(data=rows, meta={"total": total, "page": params.page, "limit": params.limit})


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
):
    # Cloud deployments use the external identity provider. Membership must be
    # granted only through the explicit invitation/acceptance flow; retaining
    # this legacy creator solely supports self-contained local-auth installs.
    if get_settings().idp_enabled:
        raise ForbiddenError("Use an organization invitation to add members")
    return await user_service.create_user(session, principal, body)


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: uuid.UUID,
    principal: Principal = Depends(require_org_member),
    session: Uow = Depends(get_session),
):
    # Any org member may look up a user in their org; cross-org -> 404.
    return await user_service.get_user(session, principal, user_id)


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: uuid.UUID,
    body: UserAdminUpdate,
    principal: Principal = Depends(require_org_member),
    session: Uow = Depends(get_session),
):
    # Field-level authorization (self vs admin) is enforced in the service.
    return await user_service.update_user(session, principal, user_id, body)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def deactivate_user(
    user_id: uuid.UUID,
    principal: Principal = Depends(require_org_admin),
    session: Uow = Depends(get_session),
) -> None:
    await user_service.deactivate_user(session, principal, user_id)


@router.post("/{user_id}/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    user_id: uuid.UUID,
    body: ChangePasswordRequest,
    principal: Principal = Depends(get_principal),
    _user: User = Depends(get_current_user),
    session: Uow = Depends(get_session),
) -> None:
    await user_service.change_own_password(
        session, principal, user_id, body.current_password, body.new_password
    )
