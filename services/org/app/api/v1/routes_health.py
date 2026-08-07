"""Liveness and readiness probes (public, unauthenticated)."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.database import Uow, get_session
from app.repositories.base import ORGS

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness: process is up."""
    return {"status": "ok"}


@router.get("/health/ready")
async def readiness(session: Uow = Depends(get_session)) -> dict[str, str]:
    """Readiness: process can reach Firestore (a bounded read)."""
    await session.db.query(ORGS, limit=1)
    return {"status": "ready"}
