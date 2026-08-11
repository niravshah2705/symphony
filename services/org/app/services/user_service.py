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
from app.models.enums import AuthProvider, OrgRole
from app.models.organization_membership import OrganizationMembership
from app.models.user import User
from app.repositories.user_repo import UserRepository
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.base import memberships_col
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
        managed_by_org_id=principal.org_id,
        org_role=data.org_role,
        is_super_admin=False,
        is_active=True,
        email_verified=False,
    )
    await repo.add(user)
    await OrganizationMembershipRepository(session).add(
        OrganizationMembership(
            org_id=principal.org_id, user_id=user.id, role=data.org_role
        )
    )
    if is_local:
        await auth_service.issue_email_verification(session, user)
    return user


async def list_users(
    session: Uow, principal: Principal, params: PageParams
) -> tuple[list[User], int]:
    users, total = await UserRepository(session).list_in_org(principal.org_id, params)
    membership_repo = OrganizationMembershipRepository(session)
    rows: list[User] = []
    for user in users:
        membership = await membership_repo.get(principal.org_id, user.id)
        if membership is not None:
            rows.append(_response(user, principal.org_id, membership.role))
    return rows, total


async def _get_user_and_membership(session: Uow, principal: Principal, user_id: uuid.UUID):
    user = await UserRepository(session).get_in_org(user_id, principal.org_id)
    if user is None:
        raise NotFoundError("User not found")
    membership = await OrganizationMembershipRepository(session).get(principal.org_id, user_id)
    if membership is None:
        raise NotFoundError("User not found")
    return user, membership


async def get_user(session: Uow, principal: Principal, user_id: uuid.UUID) -> User:
    user, membership = await _get_user_and_membership(session, principal, user_id)
    return _response(user, principal.org_id, membership.role)


async def update_user(
    session: Uow,
    principal: Principal,
    user_id: uuid.UUID,
    data: UserAdminUpdate,
) -> User:
    target, membership = await _get_user_and_membership(session, principal, user_id)
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
        membership_repo = OrganizationMembershipRepository(session)
        if (
            membership.role == OrgRole.ORG_ADMIN
            and data.org_role != OrgRole.ORG_ADMIN
            and await membership_repo.count_admins(principal.org_id) <= 1
        ):
            raise ConflictError("An organization must retain at least one administrator")
        await membership_repo.update_role(membership, data.org_role)
        if target.org_id == principal.org_id:
            target.org_role = data.org_role
    if admin and data.is_active is not None:
        membership_repo = OrganizationMembershipRepository(session)
        memberships = await membership_repo.list_for_user(target.id)
        belongs_elsewhere = any(m.org_id != principal.org_id for m in memberships)
        if belongs_elsewhere or target.managed_by_org_id != principal.org_id:
            raise ForbiddenError(
                "Organization administrators cannot change this user's global account status"
            )
        if (
            data.is_active is False
            and membership.role == OrgRole.ORG_ADMIN
            and await membership_repo.count_admins(principal.org_id) <= 1
        ):
            raise ConflictError("An organization must retain at least one administrator")
        target.is_active = data.is_active
        if not data.is_active:
            await auth_service.revoke_all_user_tokens(session, target.id)
    return _response(target, principal.org_id, membership.role)


async def deactivate_user(
    session: Uow, principal: Principal, user_id: uuid.UUID
) -> None:
    target, membership = await _get_user_and_membership(session, principal, user_id)
    membership_repo = OrganizationMembershipRepository(session)
    if (
        membership.role == OrgRole.ORG_ADMIN
        and await membership_repo.count_admins(principal.org_id) <= 1
    ):
        raise ConflictError("An organization must retain at least one administrator")

    # Remove every native-project grant inside this organization, then remove
    # only this organization membership. Other organizations remain untouched.
    project_memberships = memberships_col(principal.org_id)
    for project_membership in await session.query(
        project_memberships, [("user_id", str(target.id))]
    ):
        await session.db.delete(
            project_memberships, project_membership["id"]
        )
    await membership_repo.remove(membership)
    if target.org_id == principal.org_id:
        await membership_repo.rebase_legacy_scalar(target)

    remaining = await membership_repo.list_for_user(target.id)
    if not remaining and target.managed_by_org_id == principal.org_id:
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


def _response(user: User, org_id: uuid.UUID, role: OrgRole) -> User:
    """Serialize global identity with the role of the selected membership."""
    view = User.from_doc(user.to_doc())
    view.org_id = org_id
    view.org_role = role
    return view
