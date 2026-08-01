"""Port of services/gateway/src/routes/observability.test.js.

Exercises the analytics UI-contract mapper (pure function); the route wiring is
thin and covered by the shared gateway integration surface.
"""

from ai_fleet.services.gateway.routes.observability import to_analytics_payload


def test_analytics_mapper_exposes_the_stable_ui_contract():
    payload = to_analytics_payload(
        {
            "availability": "available",
            "reason": None,
            "message": None,
            "window": {"hours": 24, "limit": 10},
            "summary": {
                "traceCount": 1,
                "totalCostUsd": 0.42,
                "inputTokens": 100,
                "outputTokens": 20,
                "totalTokens": 120,
                "averageLatencyMs": 1500,
                "errorRate": 0,
                "costCoverage": {"reported": 1, "total": 1},
                "tokenCoverage": {"reported": 1, "total": 1},
                "latencyCoverage": {"reported": 1, "total": 1},
            },
            "traces": [
                {
                    "id": "run-1",
                    "name": "Change",
                    "change": {"label": "ENG-1 · Change"},
                    "runtime": "claude-sdk",
                    "model": "claude-opus",
                    "status": "success",
                    "startedAt": "2026-07-16T12:00:00.000Z",
                    "latencyMs": 1500,
                    "tokens": {"total": 120},
                    "cost": {"totalUsd": 0.42},
                    "traceUrl": "https://smith.langchain.com/run-1",
                }
            ],
        }
    )

    assert payload["configured"] is True
    assert payload["summary"] == {
        "traces": 1,
        "totalCost": 0.42,
        "inputTokens": 100,
        "outputTokens": 20,
        "totalTokens": 120,
        "avgLatencyMs": 1500,
        "errorRate": 0,
    }
    assert payload["changes"][0] == {
        "id": "run-1",
        "name": "ENG-1 · Change",
        "runtime": "claude-sdk",
        "model": "claude-opus",
        "status": "success",
        "startTime": "2026-07-16T12:00:00.000Z",
        "latencyMs": 1500,
        "totalTokens": 120,
        "totalCost": 0.42,
        "traceUrl": "https://smith.langchain.com/run-1",
    }


def test_analytics_mapper_distinguishes_missing_configuration_from_provider_outage():
    missing = to_analytics_payload(
        {
            "availability": "unavailable",
            "reason": "api-key-missing",
            "message": "Configure it.",
            "window": {},
            "summary": None,
            "traces": [],
        }
    )
    outage = to_analytics_payload(
        {
            "availability": "unavailable",
            "reason": "provider-unavailable",
            "message": "Try again.",
            "window": {},
            "summary": None,
            "traces": [],
        }
    )
    assert missing["configured"] is False
    assert outage["configured"] is True
    assert outage["summary"]["totalCost"] is None
