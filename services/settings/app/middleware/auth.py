"""Authentication middleware (hybrid: local JWT + external IdP).

Implemented as pure ASGI middleware (not BaseHTTPMiddleware) so it runs in the
same task/context as the app. Runs for every `/api/v1/*` route except a small
public allowlist (health only — there are no auth endpoints here), with a
default-deny posture. On success it attaches an immutable `Principal` (resolved
from Firestore, not merely the token) to `request.state`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import jwt
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.auth.idp import decode_idp_token, is_idp_issuer
from app.auth.jwt_local import decode_access_token, get_unverified_issuer
from app.auth.org_context import OrgContextError, resolve_org_context
from app.authz.principal import Principal
from app.core.database import new_uow
from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.timeutils import ensure_aware
from app.errors import ConflictError
from app.models.enums import AuthProvider, OrgRole
from app.models.user import User
from app.repositories.user_repo import UserRepository

logger = get_logger("app.auth.middleware")

API_PREFIX = "/api/v1"
PUBLIC_PATHS = frozenset(
    {
        f"{API_PREFIX}/health",
        f"{API_PREFIX}/health/ready",
    }
)
# The S2S secret-resolve surface carries NO end-user token (the egress proxy acts
# for an org); it is guarded instead by a constant-time X-Internal-Token compare
# in the route (fail closed when unset) + Cloud Run IAM. So it is exempt from the
# user-token requirement here. NOTE: only this sub-prefix is exempt —
# /internal/effective-config still requires the forwarded principal.
INTERNAL_S2S_PREFIX = f"{API_PREFIX}/internal/s2s"


class _AuthFailure(Exception):
    """Internal marker for any authentication failure (mapped to 401)."""


def _requires_auth(path: str) -> bool:
    if not path.startswith(API_PREFIX):
        return False
    # Token-gated S2S surface: no user principal, so skip user authn here.
    if path.startswith(INTERNAL_S2S_PREFIX):
        return False
    return path.rstrip("/") not in {p.rstrip("/") for p in PUBLIC_PATHS}


def _unauthorized() -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"error": {"code": "unauthorized", "message": "Authentication required"}},
        headers={"WWW-Authenticate": "Bearer"},
    )


def _context_error(exc: OrgContextError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": "invalid_context" if exc.status_code != 503 else "context_unavailable",
                "message": str(exc),
            }
        },
    )


class AuthContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not _requires_auth(scope["path"]):
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive=receive)
        # Behind the gateway, the end-user's Firebase bearer is forwarded in
        # X-Forwarded-Authorization (the Authorization header carries the
        # gateway's S2S OIDC token for Cloud Run IAM). Direct callers use
        # Authorization. This header is only trustworthy because the service is
        # IAM-gated (only the gateway SA can invoke it).
        header = request.headers.get("X-Forwarded-Authorization") or request.headers.get("Authorization", "")
        if not header.lower().startswith("bearer "):
            await _unauthorized()(scope, receive, send)
            return
        token = header[7:].strip()

        try:
            principal = await self._authenticate(
                token,
                organization_id=request.headers.get("X-AI-Fleet-Organization-Id", ""),
                project_id=request.headers.get("X-AI-Fleet-Project-Id", ""),
            )
        except OrgContextError as exc:
            await _context_error(exc)(scope, receive, send)
            return
        except (_AuthFailure, jwt.PyJWTError):
            await _unauthorized()(scope, receive, send)
            return
        except Exception as exc:  # never leak internals from the auth path
            logger.exception("Authentication error: %s", exc)
            await _unauthorized()(scope, receive, send)
            return

        scope.setdefault("state", {})["principal"] = principal
        await self.app(scope, receive, send)

    async def _authenticate(
        self, token: str, *, organization_id: str = "", project_id: str = ""
    ) -> Principal:
        issuer = get_unverified_issuer(token)
        repo = UserRepository(new_uow())

        if is_idp_issuer(issuer):
            claims = decode_idp_token(token)
            if get_settings().org_url:
                context = await resolve_org_context(
                    token,
                    organization_id=organization_id.strip(),
                    project_id=project_id.strip(),
                )
                return Principal(
                    user_id=context.user_id,
                    org_id=context.org_id,
                    org_role=context.org_role,
                    project_id=context.project_id,
                    project_role=context.project_role,
                    context_authoritative=True,
                    is_super_admin=False,
                    email=context.email or str(claims.get("email") or "").strip().lower(),
                )
            # External (e.g. Firebase) users are matched by external_subject and,
            # if unknown, JIT-provisioned as an ORG-LESS user (org_id=None). An
            # org-less user is rejected by every tenant guard, so this grants
            # identity only — never tenant data access.
            subject = claims.get("sub")
            user = await repo.get_by_external_subject(str(subject)) if subject else None
            if user is None and subject is not None:
                user = await self._provision_external_user(repo, claims, str(subject))
        else:
            claims = decode_access_token(token)
            user = await self._load_local_user(repo, claims.get("sub"))

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
            project_id=None,
            project_role=None,
            context_authoritative=False,
            is_super_admin=user.is_super_admin,
            email=user.email,
        )

    async def _load_local_user(self, repo: UserRepository, subject) -> User | None:  # type: ignore[no-untyped-def]
        try:
            user_id = uuid.UUID(str(subject))
        except (ValueError, TypeError):
            raise _AuthFailure()
        return await repo.get_by_id(user_id)

    async def _provision_external_user(  # type: ignore[no-untyped-def]
        self, repo: UserRepository, claims: dict, subject: str
    ) -> User | None:
        """Create an org-less user from a verified external-IdP identity.

        Requires ``email_verified`` (authentication-failures.md). Idempotent under
        concurrency: the external-subject uniqueness guard makes a losing racer's
        create raise ConflictError, after which we return the winner's record.
        Returns None (→ 401) if the identity is unverified or has no email.
        """
        if claims.get("email_verified") is not True:
            return None
        email = str(claims.get("email") or "").strip().lower()
        if not email:
            return None
        user = User(
            email=email,
            org_id=None,
            full_name=(claims.get("name") or None),
            auth_provider=AuthProvider.EXTERNAL,
            external_subject=subject,
            org_role=OrgRole.MEMBER,  # unused while org_id is None
            is_super_admin=False,
            is_active=True,
            email_verified=True,
        )
        try:
            await repo.add(user)
        except ConflictError:
            # Concurrent first-request, or the email is already taken by another
            # identity — fail closed unless the external subject now resolves.
            return await repo.get_by_external_subject(subject)
        return user
