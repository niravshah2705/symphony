"""Shared helpers for the Firestore-backed dataclass models.

Models keep native ``uuid.UUID`` / ``datetime`` / enum fields; persistence
converts to/from Firestore document dicts (uuid -> str, enum -> value, datetime
stored natively).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone


def new_uuid() -> uuid.UUID:
    return uuid.uuid4()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def to_uuid(value) -> uuid.UUID | None:  # type: ignore[no-untyped-def]
    if value is None or isinstance(value, uuid.UUID):
        return value
    return uuid.UUID(str(value))


def uuid_str(value) -> str | None:  # type: ignore[no-untyped-def]
    return None if value is None else str(value)
