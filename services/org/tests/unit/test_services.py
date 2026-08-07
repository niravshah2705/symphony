"""Service-layer unit tests (direct calls, no HTTP).

These complement the HTTP integration tests and exercise the business rules and
error branches of each service directly.
"""
from __future__ import annotations

import uuid

import pytest

from app.authz.principal import Principal
from app.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.models.enums import AuthProvider, OrgRole, ProjectRole, TaskStatus
from app.models.organization import Organization
from app.models.project import Project
from app.schemas.membership import MemberCreate, MemberUpdate
from app.schemas.org import OrgCreate, OrgUpdate
from app.schemas.tag import TagCreate, TagUpdate
from app.schemas.task import TaskCreate, TaskUpdate
from app.schemas.user import UserAdminUpdate, UserCreate
from app.services import (
    membership_service,
    org_service,
    tag_service,
    task_service,
    user_service,
)

pytestmark = pytest.mark.asyncio


async def _seed_org(session, name="Org", slug=None) -> Organization:
    from app.repositories.org_repo import OrgRepository

    org = Organization(name=name, slug=slug or uuid.uuid4().hex[:12])
    return await OrgRepository(session).add(org)


def _principal(org_id, *, role=OrgRole.ORG_ADMIN, user_id=None) -> Principal:
    return Principal(
        user_id=user_id or uuid.uuid4(),
        org_id=org_id,
        org_role=role,
        is_super_admin=False,
        email="p@example.com",
    )


async def _seed_project(session, org_id, name="P") -> Project:
    from app.repositories.project_repo import ProjectRepository

    project = Project(org_id=org_id, name=name)
    project.tags = []
    return await ProjectRepository(session).add(project)


# ---- user_service -----------------------------------------------------------

async def test_create_user_local_and_external(db_session):
    org = await _seed_org(db_session)
    admin = _principal(org.id)

    local = await user_service.create_user(
        db_session, admin, UserCreate(email="l@x.com", password="password123")
    )
    assert local.auth_provider == AuthProvider.LOCAL and local.password_hash

    ext = await user_service.create_user(
        db_session,
        admin,
        UserCreate(email="e@x.com", auth_provider=AuthProvider.EXTERNAL, external_subject="sub-1"),
    )
    assert ext.auth_provider == AuthProvider.EXTERNAL and ext.password_hash is None


async def test_create_user_validation_errors(db_session):
    org = await _seed_org(db_session)
    admin = _principal(org.id)
    await user_service.create_user(db_session, admin, UserCreate(email="dup@x.com", password="password123"))

    with pytest.raises(ConflictError):
        await user_service.create_user(db_session, admin, UserCreate(email="dup@x.com", password="password123"))
    with pytest.raises(ValidationAppError):
        await user_service.create_user(db_session, admin, UserCreate(email="np@x.com"))
    with pytest.raises(ValidationAppError):
        await user_service.create_user(
            db_session, admin, UserCreate(email="ne@x.com", auth_provider=AuthProvider.EXTERNAL)
        )


async def test_get_and_list_users(db_session):
    org = await _seed_org(db_session)
    admin = _principal(org.id)
    u = await user_service.create_user(db_session, admin, UserCreate(email="a@x.com", password="password123"))
    from app.schemas.common import PageParams

    got = await user_service.get_user(db_session, admin, u.id)
    assert got.id == u.id
    with pytest.raises(NotFoundError):
        await user_service.get_user(db_session, admin, uuid.uuid4())
    rows, total = await user_service.list_users(db_session, admin, PageParams())
    assert total == 1


async def test_update_user_field_authorization(db_session):
    org = await _seed_org(db_session)
    admin = _principal(org.id)
    member = await user_service.create_user(db_session, admin, UserCreate(email="m@x.com", password="password123"))
    other = await user_service.create_user(db_session, admin, UserCreate(email="o@x.com", password="password123"))

    # Admin can change role.
    updated = await user_service.update_user(
        db_session, admin, member.id, UserAdminUpdate(org_role=OrgRole.ORG_ADMIN)
    )
    assert updated.org_role == OrgRole.ORG_ADMIN

    # Self can update own profile but cannot self-promote / change status.
    self_p = _principal(org.id, role=OrgRole.MEMBER, user_id=other.id)
    ok = await user_service.update_user(db_session, self_p, other.id, UserAdminUpdate(full_name="Me"))
    assert ok.full_name == "Me"
    with pytest.raises(ForbiddenError):
        await user_service.update_user(db_session, self_p, other.id, UserAdminUpdate(org_role=OrgRole.ORG_ADMIN))
    # A non-admin cannot edit a different user.
    with pytest.raises(ForbiddenError):
        await user_service.update_user(db_session, self_p, member.id, UserAdminUpdate(full_name="X"))


async def test_change_and_deactivate(db_session):
    org = await _seed_org(db_session)
    admin = _principal(org.id)
    member = await user_service.create_user(db_session, admin, UserCreate(email="c@x.com", password="password123"))
    self_p = _principal(org.id, role=OrgRole.MEMBER, user_id=member.id)

    with pytest.raises(ValidationAppError):
        await user_service.change_own_password(db_session, self_p, member.id, "wrong", "newpassword123")
    await user_service.change_own_password(db_session, self_p, member.id, "password123", "newpassword123")
    assert member.password_changed_at is not None

    with pytest.raises(ForbiddenError):
        await user_service.change_own_password(db_session, self_p, uuid.uuid4(), "x", "newpassword123")

    await user_service.deactivate_user(db_session, admin, member.id)
    assert member.is_active is False


# ---- org_service ------------------------------------------------------------

async def test_org_service_crud(db_session):
    created = await org_service.create_org(
        db_session, OrgCreate(name="Acme", admin_email="admin@acme.com", admin_password="password123")
    )
    assert created.slug
    fetched = await org_service.get_org(db_session, created.id)
    assert fetched.id == created.id
    with pytest.raises(NotFoundError):
        await org_service.get_org(db_session, uuid.uuid4())

    updated = await org_service.update_org(db_session, created.id, OrgUpdate(name="Acme2", description="d"))
    assert updated.name == "Acme2" and updated.description == "d"

    admin = _principal(created.id)
    cur = await org_service.get_current_org(db_session, admin)
    assert cur.id == created.id
    await org_service.update_current_org(db_session, admin, OrgUpdate(description="x"))
    await org_service.delete_current_org(db_session, admin)
    with pytest.raises(NotFoundError):
        await org_service.get_org(db_session, created.id)


async def test_create_org_duplicate_admin_email(db_session):
    await org_service.create_org(
        db_session, OrgCreate(name="A", admin_email="dup@x.com", admin_password="password123")
    )
    with pytest.raises(ConflictError):
        await org_service.create_org(
            db_session, OrgCreate(name="B", admin_email="dup@x.com", admin_password="password123")
        )


# ---- membership_service -----------------------------------------------------

async def test_membership_service(db_session):
    org = await _seed_org(db_session)
    admin = _principal(org.id)
    project = await _seed_project(db_session, org.id)
    member = await user_service.create_user(db_session, admin, UserCreate(email="dev@x.com", password="password123"))

    added = await membership_service.add_member(
        db_session, admin, project, MemberCreate(user_id=member.id, role=ProjectRole.DEVELOPER)
    )
    assert added.role == ProjectRole.DEVELOPER

    # Duplicate is a conflict.
    with pytest.raises(ConflictError):
        await membership_service.add_member(
            db_session, admin, project, MemberCreate(user_id=member.id, role=ProjectRole.TEAM_LEAD)
        )
    # A user from another org cannot be added.
    with pytest.raises(ValidationAppError):
        await membership_service.add_member(
            db_session, admin, project, MemberCreate(user_id=uuid.uuid4(), role=ProjectRole.DEVELOPER)
        )

    updated = await membership_service.update_member(
        db_session, project, member.id, MemberUpdate(role=ProjectRole.PROJECT_ADMIN)
    )
    assert updated.role == ProjectRole.PROJECT_ADMIN
    rows = await membership_service.list_members(db_session, project)
    assert len(rows) == 1

    await membership_service.remove_member(db_session, project, member.id)
    with pytest.raises(NotFoundError):
        await membership_service.update_member(
            db_session, project, member.id, MemberUpdate(role=ProjectRole.DEVELOPER)
        )
    with pytest.raises(NotFoundError):
        await membership_service.remove_member(db_session, project, member.id)


# ---- tag_service & task_service ---------------------------------------------

async def test_tag_service_crud_and_attach(db_session):
    org = await _seed_org(db_session)
    admin = _principal(org.id)
    project = await _seed_project(db_session, org.id)

    tag = await tag_service.create_tag(db_session, admin, TagCreate(name="backend"))
    with pytest.raises(ConflictError):
        await tag_service.create_tag(db_session, admin, TagCreate(name="backend"))

    assert (await tag_service.get_tag(db_session, admin, tag.id)).name == "backend"
    with pytest.raises(NotFoundError):
        await tag_service.get_tag(db_session, admin, uuid.uuid4())

    renamed = await tag_service.update_tag(db_session, admin, tag.id, TagUpdate(name="be"))
    assert renamed.name == "be"

    # resolve_org_tags rejects unknown ids.
    with pytest.raises(ValidationAppError):
        await tag_service.resolve_org_tags(db_session, [uuid.uuid4()], org.id)

    # Attach/detach on org and project.
    org_obj = await org_service.get_current_org(db_session, admin)
    await tag_service.set_org_tags(db_session, admin, org_obj, [tag.id])
    assert len(org_obj.applied_tags) == 1
    await tag_service.detach_org_tag(db_session, org_obj, tag.id)
    assert org_obj.applied_tags == []

    await tag_service.attach_project_tag(db_session, admin, project, tag.id)
    assert len(project.tags) == 1
    await tag_service.detach_project_tag(db_session, project, tag.id)
    assert project.tags == []

    await tag_service.delete_tag(db_session, admin, tag.id)
    with pytest.raises(NotFoundError):
        await tag_service.get_tag(db_session, admin, tag.id)


async def test_task_service(db_session):
    org = await _seed_org(db_session)
    admin = _principal(org.id)
    project = await _seed_project(db_session, org.id)
    dev = await user_service.create_user(db_session, admin, UserCreate(email="d@x.com", password="password123"))
    await membership_service.add_member(
        db_session, admin, project, MemberCreate(user_id=dev.id, role=ProjectRole.DEVELOPER)
    )
    tag = await tag_service.create_tag(db_session, admin, TagCreate(name="auth"))
    from app.schemas.common import PageParams

    task = await task_service.create_task(
        db_session,
        admin,
        project,
        TaskCreate(title="T", assignee_id=dev.id, tag_ids=[tag.id]),
    )
    assert task.assignee_id == dev.id and len(task.tags) == 1

    # Assignee must be a project member.
    with pytest.raises(ValidationAppError):
        await task_service.create_task(
            db_session, admin, project, TaskCreate(title="X", assignee_id=uuid.uuid4())
        )

    fetched = await task_service.get_task(db_session, project, task.id)
    assert fetched.id == task.id
    with pytest.raises(NotFoundError):
        await task_service.get_task(db_session, project, uuid.uuid4())

    await task_service.update_task(
        db_session, project, task, TaskUpdate(status=TaskStatus.DONE, description="done")
    )
    assert task.status == TaskStatus.DONE

    rows, total = await task_service.list_tasks(db_session, project, PageParams(), status=TaskStatus.DONE)
    assert total == 1

    await task_service.set_task_tags(db_session, admin, task, [])
    assert task.tags == []
    await task_service.delete_task(db_session, project, task)
    with pytest.raises(NotFoundError):
        await task_service.get_task(db_session, project, task.id)
