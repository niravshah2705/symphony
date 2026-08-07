"""Platform super-admin bootstrap.

Seeds a super-admin from env-configured credentials at startup — never via a
hardcoded email check in request paths (authentication-failures.md: privileged
access must not be keyed on hardcoded identities). Idempotent: skips if a
super-admin already exists or if credentials are not configured.
"""
from __future__ import annotations

from sqlalchemy import select

from app.core.config import get_settings
from app.core.database import get_sessionmaker
from app.core.logging import get_logger
from app.core.security import hash_password
from app.models.enums import AuthProvider, OrgRole
from app.models.user import User

logger = get_logger("app.auth.bootstrap")


async def seed_super_admin() -> None:
    settings = get_settings()
    email = settings.superadmin_email.strip().lower()
    password = settings.superadmin_password
    if not (email and password):
        return

    async with get_sessionmaker()() as session:
        existing = await session.scalar(select(User).where(User.is_super_admin.is_(True)))
        if existing is not None:
            return
        if await session.scalar(select(User).where(User.email == email)) is not None:
            logger.warning("Super-admin email already used by a non-super-admin user; skipping seed")
            return

        session.add(
            User(
                email=email,
                password_hash=hash_password(password),
                auth_provider=AuthProvider.LOCAL,
                org_id=None,
                org_role=OrgRole.MEMBER,
                is_super_admin=True,
                is_active=True,
                email_verified=True,
            )
        )
        await session.commit()
        logger.info("Seeded platform super-admin: %s", email)
