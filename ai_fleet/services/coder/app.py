"""Coder agent service — the isolated code-writer (port of services/coder).

Owns the /api/coder surface (monitor status, run one ticket, start/stop the board
monitor) and runs the board monitor in-process. The gateway proxies browser
requests here; this service is not exposed to the browser directly. On boot it
starts the board monitor so that once the planner marks a project `aiplanned`, its
coding tasks are picked up automatically (idempotent; each poll self-guards).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from ai_fleet import logger
from ai_fleet.config import CONFIG
from ai_fleet.services.common import register_exception_handlers
from .routes import coder as coder_routes


@asynccontextmanager
async def lifespan(app: FastAPI):
    from ai_fleet.agent import coder_orchestrator

    coder_orchestrator.start()
    yield


app = FastAPI(title="AI Fleet coder", lifespan=lifespan)
register_exception_handlers(app)
app.include_router(coder_routes.router, prefix="/api/coder")


def main():
    import uvicorn

    port = CONFIG.SERVICES.coderPort
    logger.info(f"AI Fleet coder service running at http://localhost:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
