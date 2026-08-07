"""Shared service-layer helpers."""
from __future__ import annotations

from app.core.database import Uow

from app.core.security import generate_org_slug
from app.errors import ConflictError
from app.repositories.org_repo import OrgRepository


def normalize_email(email: str) -> str:
    """Canonicalize an email for storage/lookup (case-insensitive uniqueness)."""
    return email.strip().lower()


async def allocate_org_slug(session: Uow) -> str:
    """Allocate an unused opaque org slug (retries on the rare collision)."""
    repo = OrgRepository(session)
    for _ in range(5):
        slug = generate_org_slug()
        if await repo.get_by_slug(slug) is None:
            return slug
    raise ConflictError("Could not allocate organization slug")
