"""Authentication endpoints (register / login / refresh / logout / verify / me).

Auth endpoints are rate-limited to blunt brute-force and credential stuffing
(api-security.md). Register/login/refresh are public; logout and /me require a
valid access token.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status
from app.core.database import Uow

from app.auth.dependencies import get_current_user
from app.core.config import get_settings
from app.core.database import get_session
from app.middleware.rate_limit import limiter
from app.models.user import User
from app.schemas.auth import LoginRequest, RefreshRequest, RegisterRequest, TokenResponse
from app.schemas.user import UserResponse
from app.services import auth_service

router = APIRouter(prefix="/auth", tags=["auth"])


def _rate() -> str:
    return get_settings().auth_rate_limit


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit(_rate)
async def register(
    request: Request,
    body: RegisterRequest,
    session: Uow = Depends(get_session),
) -> TokenResponse:
    return await auth_service.register(session, body)


@router.post("/login", response_model=TokenResponse)
@limiter.limit(_rate)
async def login(
    request: Request,
    body: LoginRequest,
    session: Uow = Depends(get_session),
) -> TokenResponse:
    return await auth_service.login(session, body)


@router.post("/refresh", response_model=TokenResponse)
@limiter.limit(_rate)
async def refresh(
    request: Request,
    body: RefreshRequest,
    session: Uow = Depends(get_session),
) -> TokenResponse:
    return await auth_service.refresh(session, body.refresh_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    body: RefreshRequest,
    _user: User = Depends(get_current_user),
    session: Uow = Depends(get_session),
) -> None:
    await auth_service.logout(session, body.refresh_token)


@router.get("/verify-email")
async def verify_email(
    token: str = Query(min_length=1, max_length=512),
    session: Uow = Depends(get_session),
) -> dict[str, str]:
    await auth_service.verify_email(session, token)
    return {"status": "verified"}


@router.get("/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_user)) -> User:
    return user
