"""Authentication flows: register, login, refresh (rotation + reuse detection),
logout, email verification and password change.

Refresh tokens are stored at `refresh_tokens/{token_hash}` (the hash is the doc
id, so lookup/rotation is a single-document read/write). Rotation runs in a
Firestore transaction so a token can be spent at most once even under
concurrency; replay of an already-rotated token revokes the whole family.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from app.auth.jwt_local import create_access_token
from app.core.config import get_settings
from app.core.database import Uow
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
from app.repositories.base import REFRESH_TOKENS, USERS
from app.repositories.org_repo import OrgRepository
from app.repositories.user_repo import UserRepository
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse
from app.services.common import allocate_org_slug, normalize_email

logger = get_logger("app.services.auth")


async def _issue_tokens(session: Uow, user: User, *, family_id: uuid.UUID | None = None) -> TokenResponse:
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
    await session.add(REFRESH_TOKENS, token, doc_id=token.token_hash)
    return TokenResponse(
        access_token=access,
        refresh_token=raw_refresh,
        expires_in=settings.access_token_ttl_minutes * 60,
    )


async def _revoke_family(session: Uow, family_id: uuid.UUID) -> None:
    for doc in await session.db.query(REFRESH_TOKENS, [("family_id", str(family_id)), ("revoked", False)]):
        doc["revoked"] = True
        await session.db.set(REFRESH_TOKENS, doc["token_hash"], doc)


async def revoke_all_user_tokens(session: Uow, user_id: uuid.UUID) -> None:
    for doc in await session.db.query(REFRESH_TOKENS, [("user_id", str(user_id)), ("revoked", False)]):
        doc["revoked"] = True
        await session.db.set(REFRESH_TOKENS, doc["token_hash"], doc)


async def issue_email_verification(session: Uow, user: User) -> str:
    """Set a single-use verification token on the (tracked) user; return the raw
    token (would be emailed — never returned via the API)."""
    settings = get_settings()
    raw = generate_verification_token()
    user.email_verification_token_hash = hash_token(raw)
    user.email_verification_expires_at = utcnow() + timedelta(
        minutes=settings.email_verification_ttl_minutes
    )
    return raw


async def register(session: Uow, data: RegisterRequest) -> TokenResponse:
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


async def login(session: Uow, data: LoginRequest) -> TokenResponse:
    user = await UserRepository(session).get_global_by_email(normalize_email(data.email))
    # Identical failure for every case — no user/tenant/status enumeration.
    if user is None or not user.is_active or not verify_password(data.password, user.password_hash):
        raise UnauthorizedError("Invalid credentials")
    return await _issue_tokens(session, user)


async def refresh(session: Uow, raw_refresh: str) -> TokenResponse:
    token_hash = hash_token(raw_refresh)

    async def _rotate(txn):  # type: ignore[no-untyped-def]
        doc = await txn.get(REFRESH_TOKENS, token_hash)
        if doc is None:
            return {"status": "invalid"}
        tok = RefreshToken.from_doc(doc)
        if tok.revoked:
            # Replay of a rotated/revoked token — signal a family revocation.
            return {"status": "reuse", "family_id": tok.family_id}
        if tok.expires_at is not None and ensure_aware(tok.expires_at) < utcnow():
            doc["revoked"] = True
            txn.set(REFRESH_TOKENS, token_hash, doc)
            return {"status": "invalid"}
        doc["revoked"] = True  # rotate — single use
        txn.set(REFRESH_TOKENS, token_hash, doc)
        return {"status": "ok", "user_id": tok.user_id, "family_id": tok.family_id}

    result = await session.db.run_transaction(_rotate)
    if result["status"] == "reuse":
        await _revoke_family(session, result["family_id"])
        raise UnauthorizedError("Invalid token")
    if result["status"] != "ok":
        raise UnauthorizedError("Invalid token")

    user = await UserRepository(session).get_by_id(result["user_id"])
    if user is None or not user.is_active:
        raise UnauthorizedError("Invalid token")
    return await _issue_tokens(session, user, family_id=result["family_id"])


async def logout(session: Uow, raw_refresh: str) -> None:
    doc = await session.db.get(REFRESH_TOKENS, hash_token(raw_refresh))
    if doc is not None:
        await _revoke_family(session, RefreshToken.from_doc(doc).family_id)


async def change_password(session: Uow, user: User, current_password: str, new_password: str) -> None:
    if not verify_password(current_password, user.password_hash):
        raise ValidationAppError("Current password is incorrect")
    user.password_hash = hash_password(new_password)
    user.password_changed_at = utcnow()
    await revoke_all_user_tokens(session, user.id)  # user is tracked; commit flushes


async def verify_email(session: Uow, raw_token: str) -> None:
    rows = await session.db.query(
        USERS, [("email_verification_token_hash", hash_token(raw_token))], limit=1
    )
    user = session.track(USERS, User.from_doc(rows[0])) if rows else None
    expires = ensure_aware(user.email_verification_expires_at) if user else None
    if user is None or expires is None or expires < utcnow():
        raise UnauthorizedError("Invalid or expired verification token")
    user.email_verified = True
    user.email_verification_token_hash = None
    user.email_verification_expires_at = None
