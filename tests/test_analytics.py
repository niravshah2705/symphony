"""Port of packages/shared/src/agent/analytics.test.js."""

import json
from datetime import datetime, timezone

from ai_fleet.agent import analytics


def test_analytics_query_options_are_bounded():
    now = datetime(2026, 7, 16, 12, 0, 0, tzinfo=timezone.utc)
    options = analytics.normalize_options({"hours": 99999, "limit": 99999, "now": now})
    assert options["hours"] == analytics.MAX_WINDOW_HOURS
    assert options["limit"] == analytics.MAX_TRACE_LIMIT
    assert analytics._iso_ms(options["startTime"]) == "2026-06-16T12:00:00.000Z"


def test_root_runs_aggregate_cost_tokens_latency_errors_runtime_model_identity():
    result = analytics.aggregate_runs(
        [
            {
                "id": "run-1",
                "trace_id": "trace-1",
                "app_path": "/o/workspace/projects/p/project/r/run-1",
                "name": "Implement checkout",
                "run_type": "chain",
                "status": "success",
                "start_time": "2026-07-16T10:00:00.000Z",
                "end_time": "2026-07-16T10:00:02.000Z",
                "prompt_tokens": 100,
                "completion_tokens": 25,
                "total_tokens": 125,
                "prompt_cost": "0.01",
                "completion_cost": 0.02,
                "total_cost": 0.03,
                "extra": {
                    "metadata": {"project": "Storefront", "task-id": "ENG-7", "runtime": "codex-sdk", "ls_model_name": "gpt-5"},
                },
            },
            {
                "id": "run-2",
                "name": "Review checkout",
                "run_type": "chain",
                "status": "error",
                "error": "private provider error must not be copied",
                "start_time": "2026-07-16T09:00:00.000Z",
                "end_time": "2026-07-16T09:00:04.000Z",
            },
        ],
        {"hostUrl": "https://smith.langchain.com"},
    )

    assert result["summary"]["traceCount"] == 2
    assert result["summary"]["errorCount"] == 1
    assert result["summary"]["errorRate"] == 0.5
    assert result["summary"]["totalCostUsd"] == 0.03
    assert result["summary"]["inputTokens"] == 100
    assert result["summary"]["outputTokens"] == 25
    assert result["summary"]["totalTokens"] == 125
    assert result["summary"]["averageLatencyMs"] == 3000
    assert result["traces"][0]["change"]["label"] == "ENG-7 · Implement checkout"
    assert result["traces"][0]["runtime"] == "codex-sdk"
    assert result["traces"][0]["model"] == "gpt-5"
    assert result["traces"][0]["traceUrl"].startswith("https://smith.langchain.com/")
    assert "private provider error" not in json.dumps(result)
    assert result["summary"]["costCoverage"] == {"reported": 1, "total": 2}


def test_missing_cost_and_token_telemetry_stays_null_instead_of_zero():
    result = analytics.aggregate_runs([{"id": "run-1", "name": "No usage fields"}])
    assert result["summary"]["totalCostUsd"] is None
    assert result["summary"]["totalTokens"] is None
    assert result["traces"][0]["cost"]["totalUsd"] is None
    assert result["traces"][0]["tokens"]["total"] is None


def test_trace_links_stay_on_the_trusted_langsmith_origin():
    result = analytics.aggregate_runs(
        [
            {"id": "valid", "app_path": "/o/workspace/projects/p/project/r/valid"},
            {"id": "protocol-relative", "app_path": "//evil.example/steal"},
            {"id": "backslash-relative", "app_path": "/\\evil.example/steal"},
        ],
        {"hostUrl": "https://user:password@smith.langchain.com"},
    )

    assert (
        next(t for t in result["traces"] if t["id"] == "valid")["traceUrl"]
        == "https://smith.langchain.com/o/workspace/projects/p/project/r/valid"
    )
    assert next(t for t in result["traces"] if t["id"] == "protocol-relative")["traceUrl"] is None
    assert next(t for t in result["traces"] if t["id"] == "backslash-relative")["traceUrl"] is None


def test_sdk_trace_metadata_supplies_usage_and_cost_when_run_totals_absent():
    result = analytics.aggregate_runs(
        [
            {
                "id": "sdk-run",
                "name": "agent-runtime:claude-agent-sdk",
                "extra": {
                    "metadata": {
                        "agent_runtime": "claude-agent-sdk",
                        "model_name": "claude-opus-4-8",
                        "usage_input_tokens": 300,
                        "usage_output_tokens": 70,
                        "usage_total_tokens": 370,
                        "cost_usd": 0.19,
                    },
                },
            }
        ]
    )
    trace = result["traces"][0]
    assert trace["runtime"] == "claude-agent-sdk"
    assert trace["model"] == "claude-opus-4-8"
    assert trace["tokens"] == {"total": 370, "prompt": 300, "completion": 70, "source": "trace-metadata"}
    assert trace["cost"]["totalUsd"] == 0.19
    assert trace["cost"]["source"] == "trace-metadata"
    assert result["summary"]["totalCostUsd"] == 0.19


async def test_langsmith_query_uses_bounded_root_run_window_and_limit():
    captured = {}

    class FakeClient:
        def get_host_url(self):
            return "https://smith.langchain.com"

        def list_runs(self, **query):
            captured.update(query)

            def gen():
                yield {"id": "a", "name": "A"}
                yield {"id": "b", "name": "B"}

            return gen()

    result = await analytics.load_analytics(
        {"langsmithTracing": True, "langsmithApiKey": "secret", "langsmithProject": "project"},
        {"hours": 12, "limit": 1, "now": datetime(2026, 7, 16, 12, 0, 0, tzinfo=timezone.utc)},
        {"client": FakeClient()},
    )
    assert captured["is_root"] is True
    assert captured["limit"] == 1
    assert analytics._iso_ms(captured["start_time"]) == "2026-07-16T00:00:00.000Z"
    assert len(result["traces"]) == 1
    assert "secret" not in json.dumps(result)


async def test_langsmith_client_construction_has_bounded_timeout_and_retry_count():
    captured = {}

    class StubClient:
        def __init__(self, **configuration):
            captured.update(configuration)

        def list_runs(self, **_query):
            return []

    await analytics.load_analytics(
        {"langsmithTracing": True, "langsmithApiKey": "secret", "langsmithProject": "project"},
        {"now": "2026-07-16T12:00:00.000Z"},
        {"Client": StubClient},
    )
    assert captured["timeout_ms"] == analytics.LANGSMITH_TIMEOUT_MS
    assert captured["caller_options"] == {"max_retries": 1}


async def test_analytics_degrades_honestly_when_tracing_or_langsmith_unavailable():
    disabled = await analytics.load_analytics({"langsmithTracing": False}, {"now": "2026-07-16T12:00:00.000Z"})
    assert disabled["availability"] == "unavailable"
    assert disabled["reason"] == "tracing-disabled"

    class ThrowClient:
        def list_runs(self, **_query):
            raise RuntimeError("upstream returned do-not-leak")

    failed = await analytics.load_analytics(
        {"langsmithTracing": True, "langsmithApiKey": "do-not-leak", "langsmithProject": "project"},
        {"now": "2026-07-16T12:00:00.000Z"},
        {"client": ThrowClient()},
    )
    assert failed["reason"] == "provider-unavailable"
    assert "do-not-leak" not in json.dumps(failed)
