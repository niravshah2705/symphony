"""Tag service: org-scoped vocabulary CRUD plus attach/detach to org & projects.

Every tag attach validates that the tag belongs to the same org as the target
entity (cross-tenant-isolation.md — a tag from another org can never be
attached).
"""
from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.authz.principal import Principal
from app.errors import ConflictError, NotFoundError, ValidationAppError
from app.models.organization import Organization
from app.models.project import Project
from app.models.tag import Tag
from app.repositories.tag_repo import TagRepository
from app.schemas.common import PageParams
from app.schemas.tag import TagCreate, TagUpdate


async def resolve_org_tags(
    session: AsyncSession, tag_ids: Sequence[uuid.UUID], org_id: uuid.UUID
) -> list[Tag]:
    """Load tags by id, requiring every one to belong to the org."""
    unique_ids = list(dict.fromkeys(tag_ids))
    tags = await TagRepository(session).get_many_in_org(unique_ids, org_id)
    if len(tags) != len(unique_ids):
        raise ValidationAppError("One or more tags do not exist in this organization")
    return tags


async def create_tag(session: AsyncSession, principal: Principal, data: TagCreate) -> Tag:
    repo = TagRepository(session)
    if await repo.get_by_name(data.name, principal.org_id) is not None:
        raise ConflictError("A tag with this name already exists")
    return await repo.add(Tag(org_id=principal.org_id, name=data.name))


async def list_tags(
    session: AsyncSession, principal: Principal, params: PageParams
) -> tuple[list[Tag], int]:
    return await TagRepository(session).list_in_org(principal.org_id, params)


async def get_tag(session: AsyncSession, principal: Principal, tag_id: uuid.UUID) -> Tag:
    tag = await TagRepository(session).get_in_org(tag_id, principal.org_id)
    if tag is None:
        raise NotFoundError("Tag not found")
    return tag


async def update_tag(
    session: AsyncSession, principal: Principal, tag_id: uuid.UUID, data: TagUpdate
) -> Tag:
    repo = TagRepository(session)
    tag = await get_tag(session, principal, tag_id)
    existing = await repo.get_by_name(data.name, principal.org_id)
    if existing is not None and existing.id != tag.id:
        raise ConflictError("A tag with this name already exists")
    tag.name = data.name
    return tag


async def delete_tag(
    session: AsyncSession, principal: Principal, tag_id: uuid.UUID
) -> None:
    tag = await get_tag(session, principal, tag_id)
    await TagRepository(session).delete(tag)


# ---- Attach / detach on org and projects ------------------------------------

async def set_org_tags(
    session: AsyncSession, principal: Principal, org: Organization, tag_ids: Sequence[uuid.UUID]
) -> list[Tag]:
    tags = await resolve_org_tags(session, tag_ids, principal.org_id)
    org.applied_tags = tags
    return tags


async def detach_org_tag(
    session: AsyncSession, org: Organization, tag_id: uuid.UUID
) -> None:
    org.applied_tags = [t for t in org.applied_tags if t.id != tag_id]


async def attach_project_tag(
    session: AsyncSession, principal: Principal, project: Project, tag_id: uuid.UUID
) -> list[Tag]:
    tag = await TagRepository(session).get_in_org(tag_id, principal.org_id)
    if tag is None:
        raise ValidationAppError("Tag does not exist in this organization")
    if all(t.id != tag.id for t in project.tags):
        project.tags.append(tag)
    return project.tags


async def detach_project_tag(
    session: AsyncSession, project: Project, tag_id: uuid.UUID
) -> None:
    project.tags = [t for t in project.tags if t.id != tag_id]
