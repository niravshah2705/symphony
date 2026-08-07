"""Shared helpers for the Firestore-backed dataclass models.

Models keep native ``uuid.UUID`` / ``datetime`` / enum fields (so the service,
guard, and route layers are unchanged); persistence converts to/from Firestore
document dicts (uuid -> str, enum -> value, datetime stored natively).
Relationship fields (e.g. ``tags``) are TRANSIENT — populated by repositories
from stored id arrays, never serialized directly.
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


def id_list(values) -> list[uuid.UUID]:  # type: ignore[no-untyped-def]
    return [to_uuid(v) for v in (values or [])]  # type: ignore[misc]
