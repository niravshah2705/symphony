"""
OpenAI-compatible client for the hosted inference backend (vLLM / Ollama).

The backend is described entirely by environment variables so the same Laya
image can talk to the Cloud Run vLLM backend, an Ollama service, or any other
OpenAI-compatible endpoint:

    INFERENCE_BASE_URL   base URL INCLUDING /v1 (empty -> fallback heuristics)
    INFERENCE_API_KEY    bearer key (Secret Manager on Cloud Run)
    INFERENCE_AUTH_MODE  bearer | iam | none (default: bearer when a key is set)
    INFERENCE_MODEL      model id (vLLM --served-model-name / Ollama tag)
    INFERENCE_TIMEOUT_MS request timeout
"""

import logging
import os
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger("laya.inference")

_METADATA_IDENTITY_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/"
    "service-accounts/default/identity"
)
# Cloud Run ID tokens are valid for ~1h; refresh comfortably ahead of expiry.
_ID_TOKEN_TTL_SECONDS = 3000
_id_token_cache: Dict[str, Tuple[str, float]] = {}


@dataclass(frozen=True)
class InferenceConfig:
    base_url: str
    api_key: str
    auth_mode: str
    model: str
    timeout_ms: int

    @classmethod
    def from_env(cls) -> "InferenceConfig":
        api_key = os.getenv("INFERENCE_API_KEY", "").strip()
        base_url = os.getenv("INFERENCE_BASE_URL", "").strip().rstrip("/")
        auth_mode = os.getenv(
            "INFERENCE_AUTH_MODE", "bearer" if api_key else "none"
        ).strip().lower()
        model = os.getenv("INFERENCE_MODEL", "gemma-3-1b-it").strip()
        timeout_ms = max(100, int(os.getenv("INFERENCE_TIMEOUT_MS", "2000")))
        return cls(base_url=base_url, api_key=api_key, auth_mode=auth_mode,
                   model=model, timeout_ms=timeout_ms)

    @property
    def configured(self) -> bool:
        return bool(self.base_url)


def _fetch_id_token(base_url: str, timeout_s: float) -> str:
    """Mint a Cloud Run ID token for `base_url`'s origin via the metadata server."""
    parts = urlsplit(base_url)
    audience = f"{parts.scheme}://{parts.netloc}"
    cached = _id_token_cache.get(audience)
    now = time.monotonic()
    if cached and cached[1] > now:
        return cached[0]

    response = httpx.get(
        _METADATA_IDENTITY_URL,
        params={"audience": audience, "format": "full"},
        headers={"Metadata-Flavor": "Google"},
        timeout=timeout_s,
    )
    response.raise_for_status()
    token = response.text.strip()
    _id_token_cache[audience] = (token, now + _ID_TOKEN_TTL_SECONDS)
    return token


class InferenceClient:
    def __init__(self, config: Optional[InferenceConfig] = None):
        self.config = config or InferenceConfig.from_env()

    @property
    def configured(self) -> bool:
        return self.config.configured

    def _headers(self) -> Dict[str, str]:
        mode = self.config.auth_mode
        if mode == "bearer" and self.config.api_key:
            return {"Authorization": f"Bearer {self.config.api_key}"}
        if mode == "iam":
            return {"Authorization": f"Bearer {_fetch_id_token(self.config.base_url, self._timeout_s)}"}
        return {}

    @property
    def _timeout_s(self) -> float:
        return self.config.timeout_ms / 1000.0

    def _post(self, path: str, payload: dict) -> dict:
        response = httpx.post(
            f"{self.config.base_url}{path}",
            json=payload,
            headers={"Content-Type": "application/json", **self._headers()},
            timeout=self._timeout_s,
        )
        response.raise_for_status()
        return response.json()

    def chat(self, messages: List[dict], max_tokens: int = 256) -> str:
        data = self._post("/chat/completions", {
            "model": self.config.model,
            "messages": messages,
            "temperature": 0,
            "max_tokens": max_tokens,
        })
        return data["choices"][0]["message"]["content"] or ""


def get_inference_client() -> InferenceClient:
    return InferenceClient()
