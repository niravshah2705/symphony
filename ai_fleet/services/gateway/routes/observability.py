"""Observability routes (port of services/gateway/src/routes/observability.js).

Mounted by the gateway at /api/observability. Exposes the analytics summary,
troubleshooting diagnostics, and the workflow-pattern catalog + validator.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ai_fleet import store
from ai_fleet.agent import analytics, diagnostics, workflow_patterns
from ai_fleet.services.common import json_body

router = APIRouter()

# Analytics availability reasons that mean "not configured" (vs a transient outage).
_UNCONFIGURED_REASONS = ("tracing-disabled", "api-key-missing", "project-missing")


def analytics_configured(result: dict) -> bool:
    return result.get("reason") not in _UNCONFIGURED_REASONS


def to_analytics_payload(result: dict) -> dict:
    source_summary = result.get("summary") or {}
    traces = result.get("traces") if isinstance(result.get("traces"), list) else []
    return {
        "configured": analytics_configured(result),
        "availability": result.get("availability"),
        "reason": result.get("reason"),
        "message": result.get("message"),
        "window": result.get("window"),
        "summary": {
            "traces": source_summary.get("traceCount") or 0,
            "totalCost": source_summary.get("totalCostUsd"),
            "inputTokens": source_summary.get("inputTokens"),
            "outputTokens": source_summary.get("outputTokens"),
            "totalTokens": source_summary.get("totalTokens"),
            "avgLatencyMs": source_summary.get("averageLatencyMs"),
            "errorRate": source_summary.get("errorRate"),
        },
        "changes": [
            {
                "id": trace.get("id"),
                "name": (
                    trace["change"]["label"]
                    if trace.get("change") and trace["change"].get("label")
                    else trace.get("name")
                ),
                "runtime": trace.get("runtime"),
                "model": trace.get("model"),
                "status": trace.get("status"),
                "startTime": trace.get("startedAt"),
                "latencyMs": trace.get("latencyMs"),
                "totalTokens": trace["tokens"]["total"],
                "totalCost": trace["cost"]["totalUsd"],
                "traceUrl": trace.get("traceUrl"),
            }
            for trace in traces
        ],
        "coverage": (
            {
                "cost": source_summary.get("costCoverage"),
                "tokens": source_summary.get("tokenCoverage"),
                "latency": source_summary.get("latencyCoverage"),
            }
            if result.get("summary")
            else None
        ),
    }


@router.get("/analytics")
async def get_analytics(request: Request):
    result = await analytics.load_analytics(
        store.get_settings(),
        {"hours": request.query_params.get("hours"), "limit": request.query_params.get("limit")},
    )
    return to_analytics_payload(result)


@router.get("/troubleshooting")
async def get_troubleshooting():
    return await diagnostics.run_diagnostics(store.get_settings())


@router.get("/workflows")
async def get_workflows():
    return {"patterns": workflow_patterns.catalog()}


@router.post("/workflows/validate")
async def post_workflows_validate(request: Request):
    body = await json_body(request)
    result = workflow_patterns.validate_workflow_pattern(body)
    return JSONResponse(status_code=200 if result["valid"] else 400, content=result)
