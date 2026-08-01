"""LangSmith trace analytics (port of agent/analytics.js).

Queries a bounded window of root traces via the langsmith SDK and aggregates
cost, tokens, latency, error-rate, runtime, and model into a secret-free
summary. Provider failures degrade to an ``unavailable`` shape rather than
taking down the gateway or leaking an upstream response.

Port notes:
- langsmith is imported lazily inside the loader (it may not be installed); the
  ``Client`` class and a constructed ``client`` are both injectable via
  ``dependencies["Client"]`` / ``dependencies["client"]`` so tests use a fake.
- The langsmith *Python* SDK method is ``list_runs`` (a synchronous generator),
  so runs are iterated with a plain ``for`` loop inside the async loader.
- Output dict keys stay camelCase (``totalUsd``, ``traceUrl``, ``startAt`` …)
  because they cross the HTTP boundary to the SPA.
- ``safe_trace_url`` reproduces the SSRF / open-redirect guard with
  ``urllib.parse`` (reject protocol-relative and backslash paths, pin to the
  trusted LangSmith origin, strip userinfo).
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit, urlunsplit

HOUR_MS = 60 * 60 * 1000
DEFAULT_WINDOW_HOURS = 24 * 7
MAX_WINDOW_HOURS = 24 * 30
DEFAULT_TRACE_LIMIT = 100
MAX_TRACE_LIMIT = 250
LANGSMITH_TIMEOUT_MS = 8000

_RUN_SELECT = [
    "id", "trace_id", "session_id", "app_path", "name", "run_type", "start_time", "end_time",
    "status", "error", "extra",
    "prompt_tokens", "completion_tokens", "total_tokens", "prompt_cost", "completion_cost", "total_cost",
]


# --- date helpers ----------------------------------------------------------
def _to_datetime(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _iso_ms(dt):
    """JS ``Date#toISOString`` — millisecond precision + ``Z``."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _parse_ms(value):
    dt = _to_datetime(value)
    return dt.timestamp() * 1000 if dt is not None else None


def _iso_or_none(value):
    dt = _to_datetime(value)
    return _iso_ms(dt) if dt is not None else None


def _coalesce(*values):
    """First non-None value, mirroring JS ``a ?? b`` (0 is kept)."""
    for value in values:
        if value is not None:
            return value
    return None


def bounded_integer(value, minimum, maximum, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(number):
        return fallback
    return min(maximum, max(minimum, round(number)))


def finite_metric(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return number


def clean_text(value, maximum=120):
    if value is None:
        return ""
    text = re.sub(r"[\r\n\t]+", " ", str(value))
    text = re.sub(r"\s+", " ", text)
    return text.strip()[:maximum]


def metadata_for(run):
    extra = run.get("extra") if isinstance(run, dict) and isinstance(run.get("extra"), dict) else {}
    metadata = extra.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def invocation_for(run):
    extra = run.get("extra") if isinstance(run, dict) and isinstance(run.get("extra"), dict) else {}
    invocation = extra.get("invocation_params") or extra.get("invocationParams")
    return invocation if isinstance(invocation, dict) else {}


def first_text(values, maximum=120):
    for value in values:
        text = clean_text(value, maximum)
        if text:
            return text
    return None


def _library(value):
    return value.get("library") if isinstance(value, dict) else None


def runtime_and_model(run):
    metadata = metadata_for(run)
    invocation = invocation_for(run)
    extra = run.get("extra") if isinstance(run.get("extra"), dict) else {}
    return {
        "runtime": first_text(
            [
                metadata.get("runtime"),
                metadata.get("sdk"),
                metadata.get("framework"),
                metadata.get("agent_runtime"),
                _library(extra.get("runtime")),
                run.get("run_type"),
            ],
            80,
        ),
        "model": first_text(
            [
                metadata.get("ls_model_name"),
                metadata.get("model_name"),
                metadata.get("model"),
                invocation.get("model"),
                invocation.get("model_name"),
                extra.get("model"),
            ],
            120,
        ),
    }


def metric_from_parts(total, first, second):
    explicit = finite_metric(total)
    if explicit is not None:
        return {"value": explicit, "source": "reported-total"}
    left = finite_metric(first)
    right = finite_metric(second)
    if left is None and right is None:
        return {"value": None, "source": "unavailable"}
    return {"value": (left or 0) + (right or 0), "source": "reported-parts"}


def latency_ms(run):
    start = _parse_ms(run.get("start_time"))
    end = _parse_ms(run.get("end_time"))
    if start is None or end is None or end < start:
        return None
    return end - start


def is_error_run(run):
    if run.get("error"):
        return True
    return bool(re.match(r"^(error|failed|failure)$", clean_text(run.get("status"), 30), flags=re.IGNORECASE))


def safe_trace_url(run, host_url=None):
    """Turn a LangSmith application-relative ``app_path`` into an absolute URL
    pinned to the trusted host origin. Rejects protocol-relative and backslash
    variants so a trace cannot become an off-site link in the Analytics UI.
    """
    trace_path = clean_text((run or {}).get("app_path"), 1000)
    if not trace_path or not re.match(r"^/(?![/\\])", trace_path) or "\\" in trace_path:
        return None
    try:
        base = urlsplit(host_url or "https://smith.langchain.com")
        if base.scheme not in ("http", "https") or not base.hostname:
            return None
        netloc = base.hostname + (f":{base.port}" if base.port else "")
        base_origin = f"{base.scheme}://{netloc}"
        joined = urlsplit(urljoin(f"{base_origin}/", trace_path))
        if f"{joined.scheme}://{joined.netloc}" != base_origin:
            return None
        return urlunsplit((joined.scheme, netloc, joined.path, joined.query, joined.fragment))
    except ValueError:
        return None


def normalize_run(run, options=None):
    options = options or {}
    run = run if isinstance(run, dict) else {}
    metadata = metadata_for(run)
    prompt_tokens = _coalesce(finite_metric(run.get("prompt_tokens")), finite_metric(metadata.get("usage_input_tokens")))
    completion_tokens = _coalesce(finite_metric(run.get("completion_tokens")), finite_metric(metadata.get("usage_output_tokens")))
    reported_tokens = _coalesce(finite_metric(run.get("total_tokens")), finite_metric(metadata.get("usage_total_tokens")))
    prompt_cost = finite_metric(run.get("prompt_cost"))
    completion_cost = finite_metric(run.get("completion_cost"))
    cost = metric_from_parts(run.get("total_cost"), prompt_cost, completion_cost)
    if cost["value"] is None and finite_metric(metadata.get("cost_usd")) is not None:
        cost = {"value": finite_metric(metadata.get("cost_usd")), "source": "trace-metadata"}
    tokens = metric_from_parts(reported_tokens, prompt_tokens, completion_tokens)
    if (
        tokens["value"] is not None
        and finite_metric(run.get("total_tokens")) is None
        and finite_metric(metadata.get("usage_total_tokens")) is not None
    ):
        tokens = {"value": tokens["value"], "source": "trace-metadata"}
    runtime = runtime_and_model(run)
    project = first_text([metadata.get("project"), metadata.get("business")], 100)
    task_id = first_text([metadata.get("task-id"), metadata.get("task_id"), metadata.get("taskId")], 80)
    session_id = first_text([metadata.get("session"), metadata.get("session_id"), run.get("session_id")], 120)
    name = clean_text(run.get("name"), 160) or "Agent change"

    return {
        "id": clean_text(run.get("id") or run.get("trace_id"), 120) or None,
        "traceId": clean_text(run.get("trace_id") or run.get("id"), 120) or None,
        "name": name,
        "change": {
            "label": " · ".join([part for part in [task_id, name] if part]),
            "project": project,
            "taskId": task_id,
            "sessionId": session_id,
        },
        "startedAt": _iso_or_none(run.get("start_time")),
        "finishedAt": _iso_or_none(run.get("end_time")),
        "latencyMs": latency_ms(run),
        "status": clean_text(run.get("status"), 30) or ("error" if is_error_run(run) else "unknown"),
        "hasError": is_error_run(run),
        "runtime": runtime["runtime"],
        "model": runtime["model"],
        "traceUrl": safe_trace_url(run, options.get("hostUrl")),
        "tokens": {
            "total": tokens["value"],
            "prompt": prompt_tokens,
            "completion": completion_tokens,
            "source": tokens["source"],
        },
        "cost": {
            "totalUsd": cost["value"],
            "promptUsd": prompt_cost,
            "completionUsd": completion_cost,
            "source": cost["source"],
        },
    }


def sum_available(items, selector):
    total = 0
    coverage = 0
    for item in items:
        value = selector(item)
        if value is None or not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            continue
        total += value
        coverage += 1
    return {"value": total if coverage else None, "coverage": coverage}


def percentile(values, fraction):
    sorted_values = sorted(v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v))
    if not sorted_values:
        return None
    index = min(len(sorted_values) - 1, max(0, math.ceil(len(sorted_values) * fraction) - 1))
    return sorted_values[index]


def aggregate_runs(runs, options=None):
    options = options or {}
    traces = [normalize_run(run, options) for run in runs]
    traces.sort(key=lambda trace: -(_parse_ms(trace["startedAt"]) or 0))
    costs = sum_available(traces, lambda trace: trace["cost"]["totalUsd"])
    tokens = sum_available(traces, lambda trace: trace["tokens"]["total"])
    input_tokens = sum_available(traces, lambda trace: trace["tokens"]["prompt"])
    output_tokens = sum_available(traces, lambda trace: trace["tokens"]["completion"])
    latencies = [
        trace["latencyMs"]
        for trace in traces
        if isinstance(trace["latencyMs"], (int, float)) and not isinstance(trace["latencyMs"], bool) and math.isfinite(trace["latencyMs"])
    ]
    latency_total = sum(latencies)
    error_count = sum(1 for trace in traces if trace["hasError"])

    return {
        "summary": {
            "traceCount": len(traces),
            "errorCount": error_count,
            "errorRate": (error_count / len(traces)) if traces else 0,
            "inputTokens": input_tokens["value"],
            "outputTokens": output_tokens["value"],
            "totalTokens": tokens["value"],
            "tokenCoverage": {"reported": tokens["coverage"], "total": len(traces)},
            "totalCostUsd": costs["value"],
            "costCoverage": {"reported": costs["coverage"], "total": len(traces)},
            "averageLatencyMs": (latency_total / len(latencies)) if latencies else None,
            "p95LatencyMs": percentile(latencies, 0.95),
            "latencyCoverage": {"reported": len(latencies), "total": len(traces)},
        },
        "traces": traces,
    }


def unavailable(reason, options, message):
    return {
        "availability": "unavailable",
        "source": "langsmith",
        "reason": reason,
        "message": message,
        "window": {
            "startAt": _iso_ms(options["startTime"]),
            "endAt": _iso_ms(options["now"]),
            "hours": options["hours"],
            "limit": options["limit"],
        },
        "summary": None,
        "traces": [],
    }


def normalize_options(input_options=None):
    input_options = input_options or {}
    raw_now = input_options.get("now")
    now = _to_datetime(raw_now) if raw_now is not None else datetime.now(timezone.utc)
    if now is None:
        now = datetime.now(timezone.utc)
    hours = bounded_integer(input_options.get("hours"), 1, MAX_WINDOW_HOURS, DEFAULT_WINDOW_HOURS)
    limit = bounded_integer(input_options.get("limit"), 1, MAX_TRACE_LIMIT, DEFAULT_TRACE_LIMIT)
    start_time = now - timedelta(milliseconds=hours * HOUR_MS)
    return {"now": now, "hours": hours, "limit": limit, "startTime": start_time}


def _default_client_class():
    from langsmith import Client  # lazy: langsmith may not be installed

    return Client


async def load_analytics(settings=None, input_options=None, dependencies=None):
    """Query a bounded window of root traces. Provider failures are deliberately
    returned as an ``unavailable`` state: analytics must not take down the
    gateway or expose an upstream response (which can contain workspace details).
    """
    settings = settings or {}
    input_options = input_options or {}
    dependencies = dependencies or {}
    options = normalize_options(input_options)
    if not settings.get("langsmithTracing"):
        return unavailable("tracing-disabled", options, "Enable LangSmith tracing to collect change costs and analytics.")
    if not clean_text(settings.get("langsmithApiKey"), 4096):
        return unavailable("api-key-missing", options, "Add a LangSmith API key to load traced change costs.")
    project_name = clean_text(settings.get("langsmithProject"), 160)
    if not project_name:
        return unavailable("project-missing", options, "Choose a LangSmith project to load analytics.")

    try:
        client = dependencies.get("client")
        if client is None:
            client_class = dependencies.get("Client") or _default_client_class()
            client = client_class(
                api_key=settings.get("langsmithApiKey"),
                api_url=settings.get("langsmithEndpoint") or None,
                timeout_ms=LANGSMITH_TIMEOUT_MS,
                caller_options={"max_retries": 1},
            )
        runs = []
        iterable = client.list_runs(
            project_name=project_name,
            start_time=options["startTime"],
            is_root=True,
            limit=options["limit"],
            select=list(_RUN_SELECT),
        )
        for run in iterable:
            runs.append(run or {})
            if len(runs) >= options["limit"]:
                break
        host_url = None
        try:
            getter = getattr(client, "get_host_url", None)
            if callable(getter):
                host_url = getter()
        except Exception:
            host_url = None
        aggregate = aggregate_runs(runs, {"hostUrl": host_url})
        return {
            "availability": "available",
            "source": "langsmith",
            "reason": None,
            "message": None if runs else "No root traces were found in this time window.",
            "project": project_name,
            "window": {
                "startAt": _iso_ms(options["startTime"]),
                "endAt": _iso_ms(options["now"]),
                "hours": options["hours"],
                "limit": options["limit"],
            },
            **aggregate,
        }
    except Exception:
        return unavailable(
            "provider-unavailable",
            options,
            "LangSmith analytics could not be reached. Check the tracing key, endpoint, project, and network access.",
        )
