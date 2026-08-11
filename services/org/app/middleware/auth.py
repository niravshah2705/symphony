"""Authentication middleware (hybrid: local JWT + external IdP).

Implemented as pure ASGI middleware (not BaseHTTPMiddleware) so it runs in the
same task/context as the app. Runs for every `/api/v1/*` route except a small
public allowlist, with a default-deny posture. On success it attaches an
immutable `Principal` (resolved from Firestore, not merely the token) to
`request.state`.
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
from app.authz.principal import Principal
from app.core.database import new_uow
from app.core.logging import get_logger
from app.core.timeutils import ensure_aware
from app.errors import ConflictError
from app.models.enums import AuthProvider, OrgRole
from app.models.user import User
from app.repositories.base import ORGS, projects_col
from app.repositories.membership_repo import MembershipRepository
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.user_repo import UserRepository

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


class _ContextFailure(Exception):
    """Invalid or inaccessible caller-supplied org/project context (mapped to 404)."""


def _requires_auth(path: str) -> bool:
    if not path.startswith(API_PREFIX):
        return False
    # The S2S internal surface (/api/v1/internal/*) carries no end-user token — it
    # is guarded in-route by a shared token + IAM + the gateway refusing to proxy
    # /internal/ (see routes_internal.py). Skip the user-principal requirement so
    # the provisioner's token-authenticated write-back is not 401'd here.
    if path.startswith(f"{API_PREFIX}/internal/"):
        return False
    return path.rstrip("/") not in {p.rstrip("/") for p in PUBLIC_PATHS}


def _unauthorized() -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"error": {"code": "unauthorized", "message": "Authentication required"}},
        headers={"WWW-Authenticate": "Bearer"},
    )


def _context_not_found() -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={"error": {"code": "not_found", "message": "Selected context not found"}},
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
                request.headers.get("X-AI-Fleet-Organization-Id"),
                request.headers.get("X-AI-Fleet-Project-Id"),
            )
        except (_AuthFailure, jwt.PyJWTError):
            await _unauthorized()(scope, receive, send)
            return
        except _ContextFailure:
            await _context_not_found()(scope, receive, send)
            return
        except Exception as exc:  # never leak internals from the auth path
            logger.exception("Authentication error: %s", exc)
            await _unauthorized()(scope, receive, send)
            return

        scope.setdefault("state", {})["principal"] = principal
        await self.app(scope, receive, send)

    async def _authenticate(
        self, token: str, selected_org_header: str | None, selected_project_header: str | None
    ) -> Principal:
        issuer = get_unverified_issuer(token)
        uow = new_uow()
        repo = UserRepository(uow)

        if is_idp_issuer(issuer):
            claims = decode_idp_token(token)
            # External (e.g. Firebase) users are matched by external_subject and,
            # if unknown, JIT-provisioned as an ORG-LESS user (org_id=None). An
            # org-less user is rejected by every tenant guard, so this grants
            # identity only — never tenant data access — which is what lets a
            # signed-in-but-org-less user reach `/me` (personal projects +
            # create-org). See docs/ACCESS_MODEL.md.
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

        org_id, org_role = await self._resolve_organization_context(
            uow, user, selected_org_header
        )
        project_id = await self._resolve_project_context(
            uow, user.id, org_id, org_role, selected_project_header
        )
        await uow.commit()

        return Principal(
            user_id=user.id,
            org_id=org_id,
            org_role=org_role,
            is_super_admin=user.is_super_admin,
            email=user.email,
            project_id=project_id,
        )

    async def _resolve_organization_context(
        self, uow, user: User, selected_header: str | None  # type: ignore[no-untyped-def]
    ) -> tuple[uuid.UUID | None, OrgRole]:
        memberships = OrganizationMembershipRepository(uow)
        await memberships.ensure_legacy(user)

        if selected_header:
            try:
                org_id = uuid.UUID(selected_header)
            except (TypeError, ValueError):
                raise _ContextFailure()
            membership = await memberships.get(org_id, user.id)
            if membership is None or await uow.get(ORGS, str(org_id)) is None:
                raise _ContextFailure()
            return org_id, membership.role

        # The scalar fields remain a migration-compatible default only. If they
        # are absent, choose the oldest accessible membership deterministically.
        if user.org_id is not None:
            membership = await memberships.get(user.org_id, user.id)
            if membership is not None and await uow.get(ORGS, str(user.org_id)) is not None:
                return user.org_id, membership.role
        accessible = await memberships.list_for_user(user.id, legacy_user=user)
        for membership in accessible:
            if await uow.get(ORGS, str(membership.org_id)) is not None:
                return membership.org_id, membership.role
        return None, OrgRole.MEMBER

    async def _resolve_project_context(
        self,
        uow,  # type: ignore[no-untyped-def]
        user_id: uuid.UUID,
        org_id: uuid.UUID | None,
        org_role: OrgRole,
        selected_header: str | None,
    ) -> uuid.UUID | None:
        if not selected_header:
            return None
        try:
            project_id = uuid.UUID(selected_header)
        except (TypeError, ValueError):
            raise _ContextFailure()
        if org_id is None or await uow.get(projects_col(org_id), str(project_id)) is None:
            raise _ContextFailure()
        if org_role != OrgRole.ORG_ADMIN:
            project_membership = await MembershipRepository(uow).get(org_id, project_id, user_id)
            if project_membership is None:
                raise _ContextFailure()
        return project_id

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
