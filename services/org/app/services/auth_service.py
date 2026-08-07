"""Authentication flows: register, login, refresh (rotation + reuse detection),
logout, email verification and password change.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.jwt_local import create_access_token
from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.security import (
    generate_opaque_token,
    generate_verification_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.core.timeutils import ensure_aware, utcnow
from app.errors import ConflictError, UnauthorizedError, ValidationAppError
from app.models.enums import AuthProvider, OrgRole
from app.models.organization import Organization
from app.models.refresh_token import RefreshToken
from app.models.user import User
from app.repositories.org_repo import OrgRepository
from app.repositories.user_repo import UserRepository
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse
from app.services.common import allocate_org_slug, normalize_email

logger = get_logger("app.services.auth")


async def _issue_tokens(
    session: AsyncSession, user: User, *, family_id: uuid.UUID | None = None
) -> TokenResponse:
    settings = get_settings()
    access = create_access_token(
        user_id=user.id,
        org_id=user.org_id,
        org_role=user.org_role.value,
        is_super_admin=user.is_super_admin,
        email=user.email,
    )
    raw_refresh = generate_opaque_token()
    token = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(raw_refresh),
        family_id=family_id or uuid.uuid4(),
        expires_at=utcnow() + timedelta(days=settings.refresh_token_ttl_days),
        revoked=False,
    )
    session.add(token)
    await session.flush()
    return TokenResponse(
        access_token=access,
        refresh_token=raw_refresh,
        expires_in=settings.access_token_ttl_minutes * 60,
    )


async def _revoke_family(session: AsyncSession, family_id: uuid.UUID) -> None:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked.is_(False))
        .values(revoked=True)
    )


async def revoke_all_user_tokens(session: AsyncSession, user_id: uuid.UUID) -> None:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked.is_(False))
        .values(revoked=True)
    )


async def issue_email_verification(session: AsyncSession, user: User) -> str:
    """Set a single-use verification token on the user; return the raw token
    (would be emailed — never returned via the API)."""
    settings = get_settings()
    raw = generate_verification_token()
    user.email_verification_token_hash = hash_token(raw)
    user.email_verification_expires_at = utcnow() + timedelta(
        minutes=settings.email_verification_ttl_minutes
    )
    await session.flush()
    return raw


async def register(session: AsyncSession, data: RegisterRequest) -> TokenResponse:
    org_repo = OrgRepository(session)
    user_repo = UserRepository(session)
    email = normalize_email(data.email)

    if await user_repo.get_global_by_email(email) is not None:
        raise ConflictError("Email already registered")

    org = Organization(
        name=data.org_name,
        description=data.org_description,
        slug=await allocate_org_slug(session),
    )
    await org_repo.add(org)

    user = User(
        org_id=org.id,
        email=email,
        full_name=data.full_name,
        password_hash=hash_password(data.password),
        auth_provider=AuthProvider.LOCAL,
        org_role=OrgRole.ORG_ADMIN,
        is_super_admin=False,
        is_active=True,
        email_verified=False,
    )
    await user_repo.add(user)

    raw = await issue_email_verification(session, user)
    logger.info("Email verification token for %s: %s", email, raw)  # would be emailed
    return await _issue_tokens(session, user)


async def login(session: AsyncSession, data: LoginRequest) -> TokenResponse:
    user = await UserRepository(session).get_global_by_email(normalize_email(data.email))
    # Identical failure for every case — no user/tenant/status enumeration.
    if (
        user is None
        or not user.is_active
        or not verify_password(data.password, user.password_hash)
    ):
        raise UnauthorizedError("Invalid credentials")
    return await _issue_tokens(session, user)


async def refresh(session: AsyncSession, raw_refresh: str) -> TokenResponse:
    token = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_refresh))
    )
    if token is None:
        raise UnauthorizedError("Invalid token")

    if token.revoked:
        # A rotated/revoked token was replayed — revoke the whole family.
        # Commit the revocation explicitly: raising would otherwise trigger the
        # session dependency's rollback and undo this security-critical change.
        await _revoke_family(session, token.family_id)
        await session.commit()
        raise UnauthorizedError("Invalid token")

    if ensure_aware(token.expires_at) < utcnow():
        token.revoked = True
        raise UnauthorizedError("Invalid token")

    user = await session.get(User, token.user_id)
    if user is None or not user.is_active:
        raise UnauthorizedError("Invalid token")

    token.revoked = True  # rotate
    return await _issue_tokens(session, user, family_id=token.family_id)


async def logout(session: AsyncSession, raw_refresh: str) -> None:
    token = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_refresh))
    )
    if token is not None:
        await _revoke_family(session, token.family_id)


async def change_password(
    session: AsyncSession, user: User, current_password: str, new_password: str
) -> None:
    if not verify_password(current_password, user.password_hash):
        raise ValidationAppError("Current password is incorrect")
    user.password_hash = hash_password(new_password)
    user.password_changed_at = utcnow()
    await revoke_all_user_tokens(session, user.id)


async def verify_email(session: AsyncSession, raw_token: str) -> None:
    user = await session.scalar(
        select(User).where(User.email_verification_token_hash == hash_token(raw_token))
    )
    expires = ensure_aware(user.email_verification_expires_at) if user else None
    if user is None or expires is None or expires < utcnow():
        raise UnauthorizedError("Invalid or expired verification token")
    user.email_verified = True
    user.email_verification_token_hash = None
    user.email_verification_expires_at = None
