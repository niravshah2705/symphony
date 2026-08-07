"""Request-level auth dependencies."""
from __future__ import annotations

from fastapi import Depends, Request

from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.errors import UnauthorizedError
from app.models.user import User
from app.repositories.user_repo import UserRepository


def get_principal(request: Request) -> Principal:
    """Return the Principal populated by AuthContextMiddleware.

    Raises 401 if the route was reached without authentication (should not
    happen for routes behind the middleware's protected set).
    """
    principal = getattr(request.state, "principal", None)
    if principal is None:
        raise UnauthorizedError()
    return principal


async def get_current_user(
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
) -> User:
    """Load the authenticated user's record for the current request."""
    user = await UserRepository(session).get_by_id(principal.user_id)
    if user is None or not user.is_active:
        raise UnauthorizedError()
    return user
