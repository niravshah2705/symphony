"""User service: org-admin user management and self-service profile/password.

Enforces field-level authorization: only org-admins may change org_role /
is_active; a user may only edit their own profile and cannot self-promote
(authentication-failures.md — PATCH/PUT field escalation).
"""
from __future__ import annotations

import uuid

from app.core.database import Uow

from app.authz.policy import is_org_admin
from app.authz.principal import Principal
from app.core.security import hash_password
from app.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.models.enums import AuthProvider
from app.models.user import User
from app.repositories.user_repo import UserRepository
from app.schemas.common import PageParams
from app.schemas.user import UserAdminUpdate, UserCreate
from app.services import auth_service
from app.services.common import normalize_email


async def create_user(session: Uow, principal: Principal, data: UserCreate) -> User:
    repo = UserRepository(session)
    email = normalize_email(data.email)
    if await repo.get_global_by_email(email) is not None:
        raise ConflictError("Email already registered")

    is_local = data.auth_provider == AuthProvider.LOCAL
    if is_local and not data.password:
        raise ValidationAppError("Password is required for local users")
    if not is_local and not data.external_subject:
        raise ValidationAppError("external_subject is required for external users")

    user = User(
        org_id=principal.org_id,
        email=email,
        full_name=data.full_name,
        password_hash=hash_password(data.password) if is_local else None,
        auth_provider=data.auth_provider,
        external_subject=None if is_local else data.external_subject,
        org_role=data.org_role,
        is_super_admin=False,
        is_active=True,
        email_verified=False,
    )
    await repo.add(user)
    if is_local:
        await auth_service.issue_email_verification(session, user)
    return user


async def list_users(
    session: Uow, principal: Principal, params: PageParams
) -> tuple[list[User], int]:
    return await UserRepository(session).list_in_org(principal.org_id, params)


async def get_user(session: Uow, principal: Principal, user_id: uuid.UUID) -> User:
    user = await UserRepository(session).get_in_org(user_id, principal.org_id)
    if user is None:
        raise NotFoundError("User not found")
    return user


async def update_user(
    session: Uow,
    principal: Principal,
    user_id: uuid.UUID,
    data: UserAdminUpdate,
) -> User:
    target = await get_user(session, principal, user_id)
    admin = is_org_admin(principal)
    is_self = principal.user_id == target.id
    if not (admin or is_self):
        raise ForbiddenError("You may only modify your own profile")

    # Only admins may change role/status; a self-editing non-admin cannot escalate.
    if (data.org_role is not None or data.is_active is not None) and not admin:
        raise ForbiddenError("Only organization admins can change role or status")

    if data.full_name is not None:
        target.full_name = data.full_name
    if admin and data.org_role is not None:
        target.org_role = data.org_role
    if admin and data.is_active is not None:
        target.is_active = data.is_active
        if not data.is_active:
            await auth_service.revoke_all_user_tokens(session, target.id)
    return target


async def deactivate_user(
    session: Uow, principal: Principal, user_id: uuid.UUID
) -> None:
    target = await get_user(session, principal, user_id)
    target.is_active = False
    await auth_service.revoke_all_user_tokens(session, target.id)


async def change_own_password(
    session: Uow,
    principal: Principal,
    user_id: uuid.UUID,
    current_password: str,
    new_password: str,
) -> None:
    if principal.user_id != user_id:
        raise ForbiddenError("You may only change your own password")
    user = await UserRepository(session).get_by_id(user_id)
    if user is None:
        raise NotFoundError("User not found")
    await auth_service.change_password(session, user, current_password, new_password)
