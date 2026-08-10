"""Test fixtures: in-memory Firestore fake, app client, and a unit-of-work.

No emulator or GCP project is required — `InMemoryDb` gives the repositories a
real backing store so the cascade + authz/tenant-isolation matrix runs
in-process.
"""
from __future__ import annotations

import os

# Configure the environment BEFORE any app module imports/caches settings.
os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789")
os.environ.setdefault("IDP_ENABLED", "false")
os.environ.setdefault("AUTH_RATE_LIMIT", "100000/minute")  # don't throttle tests
# Known internal S2S token so the secret-resolve endpoint's X-Internal-Token
# guard can be exercised. No KMS_KEY_NAME -> the in-memory KMS fake is used.
os.environ.setdefault("INTERNAL_API_TOKEN", "test-internal-token-0123456789")
# No GCP_PROJECT_ID -> get_db() returns the in-memory fake.
os.environ.pop("GCP_PROJECT_ID", None)

import pytest_asyncio  # noqa: E402
from asgi_lifespan import LifespanManager  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.core.database import Uow, new_uow  # noqa: E402,F401
from app.core.firestore import InMemoryDb, set_db  # noqa: E402
from app.main import create_app  # noqa: E402


@pytest_asyncio.fixture
async def client() -> AsyncClient:
    set_db(InMemoryDb())  # fresh, isolated store per test
    app = create_app()
    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c
    set_db(None)


@pytest_asyncio.fixture
async def db_session() -> Uow:
    """A unit of work over a fresh in-memory store for direct service-layer tests."""
    set_db(InMemoryDb())
    yield new_uow()
    set_db(None)
