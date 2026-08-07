"""Authentication middleware (hybrid: local JWT + external IdP).

Implemented as pure ASGI middleware (not BaseHTTPMiddleware) so it runs in the
same task/context as the app — avoiding BaseHTTPMiddleware's ContextVar and
streaming pitfalls.

Runs for every `/api/v1/*` route except a small public allowlist. Uses a
default-deny posture: anything not explicitly public must authenticate, so
case/format variations of protected paths cannot bypass auth.

On success, attaches an immutable `Principal` (resolved from the DB, not just
the token) to `request.state`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import jwt
from sqlalchemy import select
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.auth.idp import decode_idp_token, is_idp_issuer
from app.auth.jwt_local import decode_access_token, get_unverified_issuer
from app.authz.principal import Principal
from app.core.database import get_sessionmaker
from app.core.logging import get_logger
from app.core.timeutils import ensure_aware
from app.models.enums import AuthProvider
from app.models.user import User

logger = get_logger("app.auth.middleware")

API_PREFIX = "/api/v1"
PUBLIC_PATHS = frozenset(
    {
        f"{API_PREFIX}/auth/register",
        f"{API_PREFIX}/auth/login",
        f"{API_PREFIX}/auth/refresh",
        f"{API_PREFIX}/auth/verify-email",
        f"{API_PREFIX}/health",
        f"{API_PREFIX}/health/ready",
    }
)


class _AuthFailure(Exception):
    """Internal marker for any authentication failure (mapped to 401)."""


def _requires_auth(path: str) -> bool:
    if not path.startswith(API_PREFIX):
        return False
    return path.rstrip("/") not in {p.rstrip("/") for p in PUBLIC_PATHS}


def _unauthorized() -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"error": {"code": "unauthorized", "message": "Authentication required"}},
        headers={"WWW-Authenticate": "Bearer"},
    )


class AuthContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not _requires_auth(scope["path"]):
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive=receive)
        header = request.headers.get("Authorization", "")
        if not header.lower().startswith("bearer "):
            await _unauthorized()(scope, receive, send)
            return
        token = header[7:].strip()

        try:
            principal = await self._authenticate(token)
        except (_AuthFailure, jwt.PyJWTError):
            await _unauthorized()(scope, receive, send)
            return
        except Exception as exc:  # never leak internals from the auth path
            logger.exception("Authentication error: %s", exc)
            await _unauthorized()(scope, receive, send)
            return

        scope.setdefault("state", {})["principal"] = principal
        await self.app(scope, receive, send)

    async def _authenticate(self, token: str) -> Principal:
        issuer = get_unverified_issuer(token)
        async with get_sessionmaker()() as session:
            if is_idp_issuer(issuer):
                claims = decode_idp_token(token)
                user = await self._load_external_user(session, claims.get("sub"))
            else:
                claims = decode_access_token(token)
                user = await self._load_local_user(session, claims.get("sub"))

            if user is None or not user.is_active:
                raise _AuthFailure()

            # Tokens issued before the last password change are rejected.
            iat = claims.get("iat")
            changed = ensure_aware(user.password_changed_at)
            if changed is not None and iat is not None:
                issued = datetime.fromtimestamp(int(iat), tz=timezone.utc)
                if issued < changed:
                    raise _AuthFailure()

            return Principal(
                user_id=user.id,
                org_id=user.org_id,
                org_role=user.org_role,
                is_super_admin=user.is_super_admin,
                email=user.email,
            )

    async def _load_local_user(self, session, subject) -> User | None:  # type: ignore[no-untyped-def]
        try:
            user_id = uuid.UUID(str(subject))
        except (ValueError, TypeError):
            raise _AuthFailure()
        return await session.scalar(select(User).where(User.id == user_id))

    async def _load_external_user(self, session, subject) -> User | None:  # type: ignore[no-untyped-def]
        if not subject:
            raise _AuthFailure()
        # Map to a PRE-PROVISIONED external user only — no silent JIT creation.
        return await session.scalar(
            select(User).where(
                User.external_subject == str(subject),
                User.auth_provider == AuthProvider.EXTERNAL,
            )
        )
