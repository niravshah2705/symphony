"""Project membership service (access control of a project).

Role grants are additive: adding an already-present user is a conflict (use the
update endpoint to change a role), so a re-add can never silently drop other
roles (authentication-failures.md — additive role semantics).
"""
from __future__ import annotations

import uuid

from app.core.database import Uow

from app.authz.principal import Principal
from app.errors import ConflictError, NotFoundError, ValidationAppError
from app.models.project import Project
from app.models.project_membership import ProjectMembership
from app.models.user import User
from app.repositories.membership_repo import MembershipRepository
from app.repositories.user_repo import UserRepository
from app.schemas.membership import MemberCreate, MemberUpdate


async def add_member(
    session: Uow, principal: Principal, project: Project, data: MemberCreate
) -> ProjectMembership:
    # The target user must belong to the SAME org as the project (isolation).
    target = await UserRepository(session).get_in_org(data.user_id, principal.org_id)
    if target is None:
        raise ValidationAppError("User is not a member of this organization")

    repo = MembershipRepository(session)
    if await repo.get(project.org_id, project.id, data.user_id) is not None:
        raise ConflictError("User is already a member of this project")

    return await repo.add(
        project.org_id,
        ProjectMembership(project_id=project.id, user_id=data.user_id, role=data.role),
    )


async def list_members(
    session: Uow, project: Project
) -> list[tuple[ProjectMembership, User]]:
    return await MembershipRepository(session).list_for_project(project.org_id, project.id)


async def update_member(
    session: Uow, project: Project, user_id: uuid.UUID, data: MemberUpdate
) -> ProjectMembership:
    repo = MembershipRepository(session)
    membership = await repo.get(project.org_id, project.id, user_id)
    if membership is None:
        raise NotFoundError("Membership not found")
    membership.role = data.role
    return membership


async def remove_member(
    session: Uow, project: Project, user_id: uuid.UUID
) -> None:
    repo = MembershipRepository(session)
    membership = await repo.get(project.org_id, project.id, user_id)
    if membership is None:
        raise NotFoundError("Membership not found")
    await repo.delete(project.org_id, membership)
