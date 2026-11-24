"""LiteLLM proxy custom callback that forwards every request to FlexPrice.

Deploy alongside the LiteLLM proxy (mounted file, next to config.yaml) and
register the *instance* in config.yaml:

    litellm_settings:
      callbacks: flexprice_callback.flexprice_logger

Required env vars:
    FLEXPRICE_API_URL      e.g. https://api.cloud.flexprice.io  (no /v1)
    FLEXPRICE_API_KEY      FlexPrice private key (x-api-key)
    FLEXPRICE_ENVIRONMENT_ID  optional; send as X-Environment-ID header
    FLEXPRICE_ENTITY_FROM  optional dotted metadata path for the billing
                           entity; default: user_api_key_org_id, falling
                           back to user_api_key_team_id.
    FLEXPRICE_BILLABLE_TAGS  optional comma list; default "planning,skill,mcp"

Retries are safe: each event carries event_id = LiteLLM request id and
FlexPrice dedups on it.
"""

import asyncio
import json
import logging
import os
import time
import urllib.request

from litellm.integrations.custom_logger import CustomLogger

logger = logging.getLogger("flexprice_callback")

FLEXPRICE_API_URL = os.environ.get("FLEXPRICE_API_URL", "").rstrip("/")
FLEXPRICE_API_KEY = os.environ.get("FLEXPRICE_API_KEY", "")
FLEXPRICE_ENVIRONMENT_ID = os.environ.get("FLEXPRICE_ENVIRONMENT_ID", "")
ENTITY_FROM = os.environ.get("FLEXPRICE_ENTITY_FROM", "")
BILLABLE_TAGS = [
    t.strip()
    for t in os.environ.get("FLEXPRICE_BILLABLE_TAGS", "planning,skill,mcp").split(",")
    if t.strip()
]

BUFFER_SIZE = int(os.environ.get("FLEXPRICE_BUFFER_SIZE", "200"))
FLUSH_SECONDS = float(os.environ.get("FLEXPRICE_FLUSH_SECONDS", "10"))


def _entity(meta: dict) -> str:
    if ENTITY_FROM:
        val = meta
        for part in ENTITY_FROM.split("."):
            val = val.get(part) if isinstance(val, dict) else None
        if val:
            return str(val)
    return str(meta.get("user_api_key_org_id") or meta.get("user_api_key_team_id") or "unknown")


def _to_event(slp: dict) -> dict | None:
    meta = slp.get("metadata") or {}
    # request-level tags arrive via slp["request_tags"] (from litellm_metadata.tags
    # or key/team tag config); it also carries auto User-Agent pseudo-tags, so only
    # the configured billable tags count for meter routing.
    raw_tags = set(meta.get("tags") or []) | set(slp.get("tags") or []) | set(slp.get("request_tags") or [])
    tags = raw_tags & set(BILLABLE_TAGS)
    props = {
        "provider": str(slp.get("custom_llm_provider") or ""),
        "model": str(slp.get("model") or ""),
        "operation": "chat",
        "input_tokens": str(slp.get("prompt_tokens") or 0),
        "output_tokens": str(slp.get("completion_tokens") or 0),
        "total_tokens": str(slp.get("total_tokens") or 0),
        "reported_cost": str(slp.get("response_cost") or 0),
        "request_id": str(slp.get("id") or ""),
        "organisation_id": str(meta.get("user_api_key_org_id") or ""),
        "raw_team": str(meta.get("user_api_key_team_id") or ""),
        "raw_user": str(meta.get("user_api_key_user_id") or ""),
        "fidelity": "per_request",
        "tagged": "true" if tags else "false",
    }
    for tag in BILLABLE_TAGS:
        props[f"tag_{tag}"] = tag if tag in tags else ""
    request_id = props["request_id"] or f"litellm-{time.time_ns()}"
    return {
        "event_name": "ai.usage",
        "event_id": request_id,
        "timestamp": slp.get("end_time") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "litellm",
        "external_customer_id": f"litellm-org:{_entity(meta)}",
        "properties": props,
    }


def _post_batch(events: list) -> None:
    body = json.dumps({"events": events}).encode()
    req = urllib.request.Request(
        f"{FLEXPRICE_API_URL}/v1/events/bulk",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": FLEXPRICE_API_KEY,
            **({"X-Environment-ID": FLEXPRICE_ENVIRONMENT_ID} if FLEXPRICE_ENVIRONMENT_ID else {}),
        },
        method="POST",
    )
    delay = 1.0
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                if 200 <= resp.status < 300:
                    return
                raise RuntimeError(f"flexprice responded {resp.status}")
        except Exception as exc:  # noqa: BLE001
            logger.warning("flexprice bulk post attempt %d failed: %s", attempt + 1, exc)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("flexprice bulk post failed after 5 attempts")


class FlexpriceLogger(CustomLogger):
    def __init__(self) -> None:
        if not FLEXPRICE_API_URL or not FLEXPRICE_API_KEY:
            raise ValueError("FLEXPRICE_API_URL and FLEXPRICE_API_KEY are required")
        self._buffer: list = []
        self._lock = asyncio.Lock()
        self._last_flush = time.monotonic()

    async def _enqueue(self, kwargs: dict) -> None:
        slp = kwargs.get("standard_logging_object")
        if not slp:
            return
        event = _to_event(slp)
        send = None
        async with self._lock:
            self._buffer.append(event)
            if (
                len(self._buffer) >= BUFFER_SIZE
                or time.monotonic() - self._last_flush >= FLUSH_SECONDS
            ):
                send, self._buffer = self._buffer, []
                self._last_flush = time.monotonic()
        if send:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _post_batch, send)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        await self._enqueue(kwargs)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        await self._enqueue(kwargs)

    async def flush(self):
        async with self._lock:
            send, self._buffer = self._buffer, []
        if send:
            _post_batch(send)


flexprice_logger = FlexpriceLogger()
