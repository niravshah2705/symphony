"""Planner agent service — the isolated software-design planner (port of services/planner).

Owns the /api/agent surface (config, status, candidates, jobs, run-now, omnibox,
memory, business pipeline, conversations) and runs the enrichment scheduler
in-process. The gateway proxies browser requests here; this service is not exposed
to the browser directly. On boot it starts the scheduler (which also reconciles
jobs interrupted by a restart).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from ai_fleet import logger
from ai_fleet.config import CONFIG
from ai_fleet.services.common import register_exception_handlers
from .routes import agent as agent_routes


@asynccontextmanager
async def lifespan(app: FastAPI):
    from ai_fleet.agent import scheduler

    scheduler.start_scheduler()
    yield


app = FastAPI(title="AI Fleet planner", lifespan=lifespan)
register_exception_handlers(app)
app.include_router(agent_routes.router, prefix="/api/agent")


def main():
    import uvicorn

    port = CONFIG.SERVICES.plannerPort
    logger.info(f"AI Fleet planner service running at http://localhost:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
