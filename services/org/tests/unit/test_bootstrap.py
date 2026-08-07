"""Super-admin bootstrap seeding."""
from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.auth.bootstrap import seed_super_admin
from app.core.config import get_settings
from app.core.database import get_sessionmaker
from app.models.user import User

pytestmark = pytest.mark.asyncio


async def test_seed_creates_super_admin_and_is_idempotent(client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "superadmin_email", "seed@platform.com")
    monkeypatch.setattr(settings, "superadmin_password", "password123")

    await seed_super_admin()
    await seed_super_admin()  # idempotent — must not create a duplicate

    async with get_sessionmaker()() as session:
        count = await session.scalar(
            select(func.count()).select_from(User).where(User.is_super_admin.is_(True))
        )
    assert count == 1

    # The seeded super-admin can authenticate.
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": "seed@platform.com", "password": "password123"},
    )
    assert r.status_code == 200


async def test_seed_noop_without_credentials(client):
    # No SUPERADMIN_* configured in the test settings -> nothing seeded.
    await seed_super_admin()
    async with get_sessionmaker()() as session:
        count = await session.scalar(
            select(func.count()).select_from(User).where(User.is_super_admin.is_(True))
        )
    assert count == 0
