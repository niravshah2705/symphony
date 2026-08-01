"""Deep-agent LLM provider factory (port of packages/shared/src/agent/llm.js).

Six providers are supported:
  - 'ollama'      — local inference (ChatOllama), no credentials.
  - 'lmstudio'    — local inference via LM Studio's OpenAI-compatible API.
  - 'omlx'        — local Apple-Silicon inference via oMLX's OpenAI-compatible API.
  - 'huggingface' — hosted inference via HF's OpenAI-compatible router (Bearer key).
  - 'codex'       — OpenAI via OAuth (ChatOpenAI/Responses) with a Bearer access token.
  - 'claude'      — Anthropic via OAuth (ChatAnthropic) with a Bearer access token.

plan.py is provider-agnostic: it builds a provider ``llm`` descriptor (a dict with
camelCase keys, via ``resolve_llm``) and asks this factory for a chat model. Tokens
never leave the server; the descriptor carries a short-lived access token resolved
per run.

Port notes (LangChain-Python forced a few design changes from the JS; see the
module's returned report):
  - The JS subclasses override ``_generate`` / ``_streamResponseChunks`` /
    ``_streamChatModelEvents`` / ``withConfig``. LangChain-Python's async
    entrypoints are ``_agenerate`` / ``_astream``; we override those. The
    prompt-budget trimming happens in an async ``_prepare_messages`` method the
    subclass exposes (the ported tests call it directly).
  - The JS Codex ChatGPT path sends ``maxTokens: -1`` to OMIT max_output_tokens;
    in Python we simply do not set ``max_tokens`` (equivalent).
  - The JS Claude path uses a ``createClient`` hook to supply OAuth Bearer auth and
    omit the API key. LangChain-Python's ChatAnthropic has no such hook, so we
    build the underlying ``anthropic`` async/sync clients with ``auth_token`` and
    inject them post-construction. ``outputConfig.effort`` has no ChatAnthropic
    field and is dropped (adaptive ``thinking`` is still passed).
"""

from __future__ import annotations

import math
import re
import uuid
from typing import Any

from pydantic import PrivateAttr

from langchain_core.messages import SystemMessage, HumanMessage, ChatMessage
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langchain_ollama import ChatOllama

from ai_fleet.config import CONFIG
from ai_fleet import store, logger, util
from ai_fleet.agent import oauth, claude_oauth
from ai_fleet.agent import llm_retry
from ai_fleet.agent import lmstudio_context

# Re-exported for callers/tests (see module __all__).
from ai_fleet.agent.lmstudio_context import (  # noqa: F401
    trim_messages_for_budget,
    estimate_message_tokens,
)

run_with_retry = llm_retry.run_with_retry
stream_with_retry = llm_retry.stream_with_retry
prepare_messages = lmstudio_context.prepare_messages
content_to_text = lmstudio_context.content_to_text
SUMMARY_SYSTEM_PROMPT = lmstudio_context.SUMMARY_SYSTEM_PROMPT

# Hard cap on the configurable stream-retry count (mirrors settings-patch.js).
MAX_STREAM_RETRIES = 5

# Reasoning-effort vocabularies (OpenAI-style vs local-template).
_OPENAI_EFFORTS = ("none", "low", "medium", "high", "xhigh", "max")
_CODEX_EFFORTS = ("none", "low", "medium", "high", "xhigh", "max", "ultra")
_CLAUDE_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_LOCAL_EFFORTS = ("low", "medium", "high")


# ------------------------------- small helpers --------------------------- #

def _g(llm, key, default=None):
    """Read a descriptor field whether ``llm`` is a dict or an object."""
    if isinstance(llm, dict):
        return llm.get(key, default)
    return getattr(llm, key, default)


def _number(value):
    """Mirror JS ``Number(x)``: a finite float, or None when not coercible."""
    if value is None or isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(n) or math.isinf(n):
        return None
    return n


def _num_or(value, default):
    """JS ``Number(x) || default`` — 0/NaN/None fall back to ``default``."""
    n = _number(value)
    return n if n else default


def _is_finite_number(value) -> bool:
    """JS ``typeof x === 'number' && Number.isFinite(x)``."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def clamp_stream_retries(value) -> int:
    """Coerce an operator-supplied retry count to a bounded, non-negative integer."""
    n = _number(value)
    if n is None:
        return CONFIG.LLM_STREAM_RETRIES
    return min(MAX_STREAM_RETRIES, max(0, math.floor(n + 0.5)))


def _stream_retry_logger(provider):
    """Build the ``on_retry`` callback: logs each retry with the provider and
    whatever the provider disclosed (HTTP status, error code/type, message)."""
    def on_retry(err, attempt):
        status = getattr(err, "status", None)
        if status is None:
            status = getattr(err, "statusCode", None)
        err_obj = getattr(err, "error", None)
        detail = ""
        if err_obj is not None:
            detail = getattr(err_obj, "code", None) or getattr(err_obj, "type", None) or ""
        if not detail:
            detail = getattr(err, "code", None) or ""
        message = f" {err}" if str(err) else ""
        status_str = status if status is not None else "none"
        detail_str = f", {detail}" if detail else ""
        logger.warn(
            f"LLM stream error on {provider} (status={status_str}{detail_str}); retry {attempt}.{message}"
        )

    return on_retry


# ------------------------------ budget helpers --------------------------- #

def lmstudio_json_kwargs(mode):
    """Map an LM Studio JSON mode to the model_kwargs for the OpenAI-compatible call.
    Returns None when no request-level constraint should be sent (prompt-driven)."""
    if mode == "json_object":
        return {"response_format": {"type": "json_object"}}
    if mode == "json_schema":
        return {
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "response", "strict": False, "schema": {"type": "object", "additionalProperties": True}},
            }
        }
    return None


def lmstudio_max_tokens(llm):
    """Output-token budget for LM Studio, bounded by the loaded context window."""
    ctx = _num_or(_g(llm, "contextWindow"), 8192)
    want = _num_or(_g(llm, "numTokens"), 4096)
    return int(max(256, min(want, math.floor(ctx / 2))))


def omlx_max_tokens(llm):
    """oMLX output budget; saved presets already reserve prompt room explicitly."""
    ctx = _num_or(_g(llm, "contextWindow"), 8192)
    want = _num_or(_g(llm, "numTokens"), 4096)
    return int(max(256, min(want, max(256, ctx - 256))))


def codex_max_tokens(llm):
    """Output-token reserve used when sizing the Codex prompt budget (does NOT cap
    output — the ChatGPT backend rejects ``max_output_tokens``)."""
    want = _num_or(_g(llm, "numTokens"), 4096)
    return int(max(256, want))


def codex_prompt_budget(llm):
    """Prompt-token budget for Codex: window minus the output reserve and a fixed
    margin. Returns 0 when no window is known (context management disabled)."""
    ctx = _num_or(_g(llm, "contextWindow"), 0)
    if ctx <= 0:
        return 0
    budget = ctx - codex_max_tokens(llm) - CONFIG.OAUTH.promptMarginTokens
    return int(max(0, budget))


def lmstudio_prompt_budget(llm):
    """Max prompt tokens for LM Studio: declared window minus the reserved output
    budget and a safety margin. Returns 0 when no window is known."""
    ctx = _num_or(_g(llm, "contextWindow"), 0)
    if ctx <= 0:
        return 0
    budget = ctx - lmstudio_max_tokens(llm) - CONFIG.LMSTUDIO.promptMarginTokens
    return int(max(0, budget))


def omlx_prompt_budget(llm):
    ctx = _num_or(_g(llm, "contextWindow"), 0)
    if ctx <= 0:
        return 0
    return int(max(0, ctx - omlx_max_tokens(llm) - CONFIG.OMLX.promptMarginTokens))


# Dedup key for the "loaded < configured" warning so resolve_llm logs it once per
# distinct situation, not on every scheduler/monitor tick.
_last_ctx_mismatch_warning = None


def _warn_context_mismatch(model, loaded, declared):
    """Warn (at most once per distinct combo) when LM Studio loaded a smaller
    context window than the operator configured."""
    global _last_ctx_mismatch_warning
    if not (loaded and declared and loaded < declared):
        return
    key = f"{model}:{loaded}:{declared}"
    if key == _last_ctx_mismatch_warning:
        return
    _last_ctx_mismatch_warning = key
    logger.warn(
        f'LM Studio: model "{model}" is loaded with only {loaded} context tokens, but the app is '
        f"configured for {declared}. Using {loaded}. Reload the model in LM Studio with a larger "
        "context window (it must exceed the coder's initial prompt, ~10–20k tokens) to run the coder."
    )


def clamp_context_window(declared, loaded):
    """Reconcile the operator-declared window with LM Studio's loaded value; prefer
    the smaller of the two (fall back to whichever is known)."""
    d = _num_or(declared, 0)
    l = _num_or(loaded, 0)
    if d > 0 and l > 0:
        return int(min(d, l))
    return int(l) if l > 0 else int(d)


async def _fetch_lmstudio_loaded_context(host, model):
    """Read the actually-loaded context length for ``model`` from LM Studio's native
    REST API (/api/v0/models). Returns None when it can't be determined (old LM
    Studio, model not loaded, endpoint unreachable). Short timeout, guarded."""
    url = re.sub(r"/$", "", str(host or "")) + "/api/v0/models"
    try:
        import httpx  # lazy: keep the dep off the import path
    except Exception:
        return None
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            res = await client.get(url)
        if not (200 <= res.status_code < 300):
            return None
        body = res.json()
        models = (body.get("data") or body.get("models")) if isinstance(body, dict) else []
        if not isinstance(models, list):
            models = []
        found = next((m for m in models if isinstance(m, dict) and m.get("id") == model), None)
        n = _number(found.get("loaded_context_length")) if found else None
        return int(n) if (n is not None and n > 0) else None
    except Exception:
        return None


# --------------------------- message transforms -------------------------- #

def _system_to_developer(messages):
    """Rewrite every system message to a generic ``developer`` ChatMessage.

    The ChatGPT Codex backend rejects ``role:"system"`` input items (it wants the
    system prompt as top-level ``instructions``). Normalizing to ``developer`` makes
    the Responses converter emit ``developer`` (accepted)."""
    out = []
    for m in messages:
        if lmstudio_context.message_type(m) == "system":
            out.append(ChatMessage(content=_g(m, "content"), role="developer"))
        else:
            out.append(m)
    return out


def _with_claude_identity(messages, prefix):
    """Prepend the Claude Code identity to the system prompt (merging into an
    existing leading system message), idempotently."""
    if not prefix:
        return messages
    first = messages[0] if messages else None
    is_system = first is not None and lmstudio_context.message_type(first) == "system"
    if not is_system:
        return [SystemMessage(prefix), *messages]
    content = _g(first, "content")
    if isinstance(content, str):
        if content.startswith(prefix):
            return messages
        return [SystemMessage(f"{prefix}\n\n{content}"), *messages[1:]]
    if isinstance(content, list):
        for c in content:
            text = c.get("text") if isinstance(c, dict) else getattr(c, "text", None)
            if isinstance(text, str) and text.startswith(prefix):
                return messages
        return [SystemMessage(content=[{"type": "text", "text": prefix}, *content]), *messages[1:]]
    return [SystemMessage(prefix), *messages]


# --------------------------- chat model subclasses ----------------------- #

class ContextManagedChatOpenAI(ChatOpenAI):
    """ChatOpenAI that (a) bounds the (unbounded, re-sent-every-turn) deep-agent
    history to ``prompt_budget`` tokens before each call — via the configured
    strategy (trim | summarize | none) and ONLY when the prompt actually exceeds
    the budget — and (b) retries a transient/in-stream error ``stream_retries``
    times. Shared by the LM Studio, oMLX, Codex, and Hugging Face paths."""

    prompt_budget: int = 0
    chars_per_token: float = CONFIG.LMSTUDIO.charsPerToken
    context_mode: str = "trim"
    summary_max_tokens: int = CONFIG.LMSTUDIO.summaryMaxTokens
    stream_retries: int = 0
    retry_provider: str = "openai"

    _summary_model: Any = PrivateAttr(default=None)

    def _build_summarizer(self):
        # A copy of THIS model with budgeting + retry disabled, so summarize calls
        # never re-enter budgeting and never carry the agent's bound tools.
        return self.model_copy(update={"prompt_budget": 0, "context_mode": "none", "stream_retries": 0})

    def _summarizer(self):
        if self._summary_model is None:
            self._summary_model = self._build_summarizer()
        return self._summary_model

    async def _summarize(self, text):
        res = await self._summarizer().ainvoke([SystemMessage(SUMMARY_SYSTEM_PROMPT), HumanMessage(text)])
        return content_to_text(getattr(res, "content", None))

    async def _prepare_messages(self, messages):
        return await prepare_messages(
            messages=messages,
            mode=self.context_mode,
            budget=self.prompt_budget,
            chars_per_token=self.chars_per_token,
            summary_max_tokens=self.summary_max_tokens,
            summarize=self._summarize,
        )

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        prepared = await self._prepare_messages(messages)
        sup = super()

        async def call():
            return await sup._agenerate(prepared, stop=stop, run_manager=run_manager, **kwargs)

        return await run_with_retry(call, self.stream_retries, _stream_retry_logger(self.retry_provider))

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        prepared = await self._prepare_messages(messages)
        sup = super()

        def make():
            return sup._astream(prepared, stop=stop, run_manager=run_manager, **kwargs)

        async for chunk in stream_with_retry(make, self.stream_retries, _stream_retry_logger(self.retry_provider)):
            yield chunk


class CodexChatModel(ContextManagedChatOpenAI):
    """Codex (ChatGPT backend) model: the shared managed base plus a system→developer
    rewrite the ChatGPT Responses backend requires."""

    async def _prepare_messages(self, messages):
        base = await super()._prepare_messages(messages)
        return _system_to_developer(base)


class ClaudeChatModel(ChatAnthropic):
    """ChatAnthropic that injects the Claude Code identity system block on every
    request and adds the same transient/in-stream retry as the hosted providers."""

    stream_retries: int = 0
    identity_prefix: str = ""

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        prepared = _with_claude_identity(messages, self.identity_prefix)
        sup = super()

        async def call():
            return await sup._agenerate(prepared, stop=stop, run_manager=run_manager, **kwargs)

        return await run_with_retry(call, self.stream_retries, _stream_retry_logger("claude"))

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        prefix = self.identity_prefix
        sup = super()

        def make():
            return sup._astream(_with_claude_identity(messages, prefix), stop=stop, run_manager=run_manager, **kwargs)

        async for chunk in stream_with_retry(make, self.stream_retries, _stream_retry_logger("claude")):
            yield chunk


class RetryingChatOllama(ChatOllama):
    """ChatOllama with the same transient/in-stream retry as the hosted providers.
    Only the stream is wrapped: ChatOllama aggregates ``_agenerate`` by iterating
    ``_astream``, so wrapping only the stream covers both invoke() and stream()."""

    stream_retries: int = 0

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        sup = super()

        def make():
            return sup._astream(messages, stop=stop, run_manager=run_manager, **kwargs)

        async for chunk in stream_with_retry(make, self.stream_retries, _stream_retry_logger("ollama")):
            yield chunk


# ------------------------------ model builders --------------------------- #

def create_codex_chatgpt_model(llm, json=False):
    """Build a CodexChatModel targeting the ChatGPT-plan Codex backend (Responses API)."""
    opts = {
        "model": _g(llm, "model"),
        "api_key": _g(llm, "accessToken"),
        "use_responses_api": True,
        "streaming": True,
        "store": False,  # Zero Data Retention (JS zdrEnabled)
        # JS sends maxTokens:-1 to OMIT max_output_tokens; we simply do not set it.
        "base_url": _g(llm, "baseUrl"),
        "default_headers": {
            "chatgpt-account-id": _g(llm, "accountId"),
            "OpenAI-Beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "session_id": str(uuid.uuid4()),
        },
        # Bound the growing deep-agent history to fit the Codex context window.
        "prompt_budget": codex_prompt_budget(llm),
        "chars_per_token": CONFIG.OAUTH.charsPerToken,
        "context_mode": _g(llm, "contextMode") or "trim",
        "summary_max_tokens": CONFIG.OAUTH.summaryMaxTokens,
        "stream_retries": clamp_stream_retries(_g(llm, "streamRetries")),
        "retry_provider": "codex",
    }
    if _g(llm, "reasoningAdapter") == "openai" and _g(llm, "reasoningEffort") in _CODEX_EFFORTS:
        opts["reasoning"] = {"effort": _g(llm, "reasoningEffort")}
    if json:
        opts["model_kwargs"] = {"text": {"format": {"type": "json_object"}}}
    return CodexChatModel(**opts)


def create_claude_model(llm, json=False):
    """Build a ChatAnthropic authenticated with a Claude OAuth (subscription) token."""
    from anthropic import Anthropic, AsyncAnthropic

    base_url = re.sub(r"/$", "", str(_g(llm, "baseUrl") or CONFIG.CLAUDE.baseUrl))
    beta_header = CONFIG.CLAUDE.betaHeader
    opts = {
        "model": _g(llm, "model"),
        "max_tokens": _g(llm, "numTokens"),
        # Placeholder key: ChatAnthropic requires a key present; real auth comes from
        # the injected client below (OAuth Bearer via auth_token, not x-api-key).
        "anthropic_api_key": "oauth-bearer-placeholder",
        "anthropic_api_url": base_url,
        "betas": [beta_header],
        "streaming": _g(llm, "streaming") is not False,
        "stream_retries": clamp_stream_retries(_g(llm, "streamRetries")),
        "identity_prefix": CONFIG.CLAUDE.systemPrefix,
    }
    # Opus 4.8 supports adaptive thinking only (JS also sets outputConfig.effort,
    # which has no ChatAnthropic field and is dropped here).
    adapter = _g(llm, "reasoningAdapter")
    effort = _g(llm, "reasoningEffort")
    if adapter == "anthropic-adaptive" and effort in _CLAUDE_EFFORTS:
        opts["thinking"] = {"type": "adaptive"}
    model = ClaudeChatModel(**opts)
    # Inject OAuth Bearer auth by replacing the underlying anthropic clients.
    headers = {"anthropic-beta": beta_header}
    common = dict(auth_token=_g(llm, "accessToken"), base_url=base_url, default_headers=headers)
    object.__setattr__(model, "_client", Anthropic(**common))
    object.__setattr__(model, "_async_client", AsyncAnthropic(**common))
    return model


def create_chat_model(llm, json=False):
    """Build a LangChain chat model for the given provider descriptor."""
    provider = _g(llm, "provider")
    if provider == "claude":
        return create_claude_model(llm, json)

    if provider == "codex":
        if _g(llm, "backend") == "chatgpt":
            return create_codex_chatgpt_model(llm, json)
        # Metered OpenAI Chat Completions API — same managed base as the ChatGPT
        # backend (standard API accepts role:"system", so no developer rewrite).
        opts = {
            "model": _g(llm, "model"),
            "api_key": _g(llm, "accessToken"),
            "max_tokens": _g(llm, "numTokens"),
            "base_url": _g(llm, "baseUrl"),
            "prompt_budget": codex_prompt_budget(llm),
            "chars_per_token": CONFIG.OAUTH.charsPerToken,
            "context_mode": _g(llm, "contextMode") or "trim",
            "summary_max_tokens": CONFIG.OAUTH.summaryMaxTokens,
            "stream_retries": clamp_stream_retries(_g(llm, "streamRetries")),
            "retry_provider": "codex",
        }
        if _g(llm, "reasoningAdapter") == "openai" and _g(llm, "reasoningEffort") in _OPENAI_EFFORTS:
            opts["reasoning"] = {"effort": _g(llm, "reasoningEffort")}
        if (_g(llm, "reasoningAdapter") != "openai" or _g(llm, "reasoningEffort") == "none") and _is_finite_number(_g(llm, "temperature")):
            opts["temperature"] = _g(llm, "temperature")
        if json:
            opts["model_kwargs"] = {"response_format": {"type": "json_object"}}
        return ContextManagedChatOpenAI(**opts)

    if provider == "huggingface":
        opts = {
            "model": _g(llm, "model"),
            "api_key": _g(llm, "apiKey"),
            "max_tokens": _g(llm, "numTokens"),
            "streaming": True,
            "base_url": _g(llm, "baseUrl"),
            "stream_retries": clamp_stream_retries(_g(llm, "streamRetries")),
            "retry_provider": "huggingface",
        }
        if _g(llm, "reasoningAdapter") == "openai" and _g(llm, "reasoningEffort") in _OPENAI_EFFORTS:
            opts["reasoning"] = {"effort": _g(llm, "reasoningEffort")}
        if (_g(llm, "reasoningAdapter") != "openai" or _g(llm, "reasoningEffort") == "none") and _is_finite_number(_g(llm, "temperature")):
            opts["temperature"] = _g(llm, "temperature")
        if json:
            opts["model_kwargs"] = {"response_format": {"type": "json_object"}}
        return ContextManagedChatOpenAI(**opts)

    if provider == "lmstudio":
        opts = {
            "model": _g(llm, "model"),
            "api_key": "lm-studio",
            "max_tokens": lmstudio_max_tokens(llm),
            "stream_retries": clamp_stream_retries(_g(llm, "streamRetries")),
            "retry_provider": "lmstudio",
            "streaming": True,
            # JS SDK timeout is in ms; LangChain-Python timeout is in seconds.
            "timeout": CONFIG.LMSTUDIO.requestTimeoutMs / 1000,
            "max_retries": int(CONFIG.LMSTUDIO.maxRetries),
            "base_url": _g(llm, "baseUrl"),
            "prompt_budget": lmstudio_prompt_budget(llm),
            "context_mode": _g(llm, "contextMode") or "trim",
            "summary_max_tokens": CONFIG.LMSTUDIO.summaryMaxTokens,
            "chars_per_token": CONFIG.LMSTUDIO.charsPerToken,
        }
        if _is_finite_number(_g(llm, "temperature")):
            opts["temperature"] = _g(llm, "temperature")
        if _is_finite_number(_g(llm, "topP")):
            opts["top_p"] = _g(llm, "topP")
        model_kwargs = {}
        if _is_finite_number(_g(llm, "topK")):
            model_kwargs["top_k"] = _g(llm, "topK")
        if _is_finite_number(_g(llm, "repeatPenalty")):
            model_kwargs["repeat_penalty"] = _g(llm, "repeatPenalty")
        if _g(llm, "reasoningAdapter") == "openai-compatible" and _g(llm, "reasoningEffort") in _LOCAL_EFFORTS:
            model_kwargs["reasoning_effort"] = _g(llm, "reasoningEffort")
        if json:
            kwargs = lmstudio_json_kwargs(_g(llm, "jsonMode"))
            if kwargs:
                model_kwargs.update(kwargs)
        if model_kwargs:
            opts["model_kwargs"] = model_kwargs
        return ContextManagedChatOpenAI(**opts)

    if provider == "omlx":
        opts = {
            "model": _g(llm, "model"),
            "api_key": _g(llm, "apiKey") or "omlx-local",
            "max_tokens": omlx_max_tokens(llm),
            "streaming": True,
            "timeout": CONFIG.OMLX.requestTimeoutMs / 1000,
            "max_retries": int(CONFIG.OMLX.maxRetries),
            "base_url": _g(llm, "baseUrl"),
            "prompt_budget": omlx_prompt_budget(llm),
            "chars_per_token": CONFIG.OMLX.charsPerToken,
            "context_mode": _g(llm, "contextMode") or "trim",
            "summary_max_tokens": CONFIG.OMLX.summaryMaxTokens,
            "stream_retries": clamp_stream_retries(_g(llm, "streamRetries")),
            "retry_provider": "omlx",
        }
        if _is_finite_number(_g(llm, "temperature")):
            opts["temperature"] = _g(llm, "temperature")
        if _is_finite_number(_g(llm, "topP")):
            opts["top_p"] = _g(llm, "topP")
        model_kwargs = {}
        if _is_finite_number(_g(llm, "topK")):
            model_kwargs["top_k"] = _g(llm, "topK")
        if _is_finite_number(_g(llm, "repeatPenalty")):
            model_kwargs["repetition_penalty"] = _g(llm, "repeatPenalty")
        if _g(llm, "reasoningAdapter") == "omlx-template-effort" and _g(llm, "reasoningEffort") in _LOCAL_EFFORTS:
            model_kwargs["chat_template_kwargs"] = {"reasoning_effort": _g(llm, "reasoningEffort")}
        if json:
            kwargs = lmstudio_json_kwargs(_g(llm, "jsonMode"))
            if kwargs:
                model_kwargs.update(kwargs)
        if model_kwargs:
            opts["model_kwargs"] = model_kwargs
        return ContextManagedChatOpenAI(**opts)

    if provider != "ollama":
        raise TypeError(f"Unsupported LLM provider: {provider or 'unknown'}")

    # Local Ollama.
    opts = {
        "base_url": _g(llm, "host"),
        "model": _g(llm, "model"),
        "num_ctx": _g(llm, "contextWindow"),
        "num_predict": _g(llm, "numTokens"),
        "stream_retries": clamp_stream_retries(_g(llm, "streamRetries")),
    }
    if _is_finite_number(_g(llm, "temperature")):
        opts["temperature"] = _g(llm, "temperature")
    if _is_finite_number(_g(llm, "topP")):
        opts["top_p"] = _g(llm, "topP")
    if _is_finite_number(_g(llm, "topK")):
        opts["top_k"] = _g(llm, "topK")
    if _is_finite_number(_g(llm, "repeatPenalty")):
        opts["repeat_penalty"] = _g(llm, "repeatPenalty")
    if _g(llm, "reasoningAdapter") == "ollama-think-effort" and _g(llm, "reasoningEffort") in _LOCAL_EFFORTS:
        opts["reasoning"] = _g(llm, "reasoningEffort")
    elif _g(llm, "reasoningAdapter") == "ollama-think-toggle":
        opts["reasoning"] = _g(llm, "reasoningEffort") != "none"
    if json and _g(llm, "jsonMode") != "text":
        opts["format"] = "json"
    return RetryingChatOllama(**opts)


# ------------------------------ token refresh ---------------------------- #

def _auth_error(message):
    return util.AppError(message, status=401)


async def ensure_fresh_codex_tokens():
    """Return a valid Codex token set, refreshing (and persisting rotation) when the
    access token is missing or near expiry. Raises (401) when no usable token
    exists so the caller can prompt the operator to sign in again."""
    tokens = store.get_codex_tokens()
    if not tokens or (not tokens.get("accessToken") and not tokens.get("refreshToken")):
        raise _auth_error("Sign in with Codex (OpenAI) in Settings → LLM.")
    if not oauth.is_expired(tokens):
        return tokens
    refreshed = await oauth.refresh_tokens(tokens)
    store.set_codex_tokens(refreshed)
    return refreshed


async def ensure_fresh_claude_tokens():
    """Return a valid Claude token set, refreshing (and persisting rotation) when the
    access token is missing or near expiry. Raises (401) when no usable token exists."""
    tokens = store.get_claude_tokens()
    if not tokens or (not tokens.get("accessToken") and not tokens.get("refreshToken")):
        raise _auth_error("Sign in with Claude in Settings → LLM.")
    if not claude_oauth.is_expired(tokens):
        return tokens
    refreshed = await claude_oauth.refresh_tokens(tokens)
    store.set_claude_tokens(refreshed)
    return refreshed


# ------------------------------ role routing ----------------------------- #

# Maps deep-agent roles to their settings provider key. Two kinds of roles exist:
#   Deployment slots (legacy, deployment-pinned): 'global', 'local'.
#   Purpose roles (provider-flexible): 'thinking', 'execution', 'testing'.
ROLE_PROVIDER_KEYS = {
    "global": "llmProvider",
    "local": "localLlmProvider",
    "thinking": "thinkingLlmProvider",
    "execution": "executionLlmProvider",
    "testing": "testingLlmProvider",
}


def provider_for_role(settings, role="global"):
    """Which provider name backs a given deep-agent role."""
    if role == "local":
        return settings.get("localLlmProvider") or settings.get("llmProvider") or "ollama"
    key = ROLE_PROVIDER_KEYS.get(role, "llmProvider")
    return settings.get(key) or settings.get("llmProvider") or "ollama"


async def resolve_llm(settings, role="global"):
    """Resolve a provider descriptor from settings for the given role. For
    'codex'/'claude' this refreshes the access token if needed (async)."""
    provider = provider_for_role(settings, role)
    stream_retries = clamp_stream_retries(settings.get("llmStreamRetries"))

    if provider == "claude":
        tokens = await ensure_fresh_claude_tokens()
        return {
            "provider": "claude",
            "model": settings.get("claudeModel") or CONFIG.CLAUDE.defaultModel,
            "baseUrl": CONFIG.CLAUDE.baseUrl,
            "accessToken": tokens.get("accessToken"),
            "numTokens": settings.get("claudeMaxTokens") or 65536,
            "temperature": settings.get("claudeTemperature"),
            "reasoningEffort": settings.get("claudeReasoningEffort"),
            "reasoningAdapter": settings.get("claudeReasoningAdapter") or "none",
            "streaming": settings.get("claudeStreaming") is not False,
            "streamRetries": stream_retries,
        }

    if provider == "codex":
        tokens = await ensure_fresh_codex_tokens()
        if CONFIG.OAUTH.backend == "chatgpt":
            account_id = oauth.account_id_from_id_token(tokens.get("idToken"))
            if not account_id:
                raise _auth_error(
                    "Codex ChatGPT backend needs an account id from your sign-in; sign in with Codex again."
                )
            return {
                "provider": "codex",
                "backend": "chatgpt",
                "model": settings.get("codexModel") or CONFIG.OAUTH.chatgptModel,
                "baseUrl": CONFIG.OAUTH.chatgptBaseUrl,
                "accessToken": tokens.get("accessToken"),
                "authTokens": {**tokens},
                "accountId": account_id,
                "numTokens": settings.get("codexMaxTokens") or 65536,
                "contextWindow": _num_or(settings.get("codexContextWindow"), 0),
                "contextMode": settings.get("codexContextMode") or "trim",
                "temperature": settings.get("codexTemperature"),
                "reasoningEffort": settings.get("codexReasoningEffort"),
                "reasoningAdapter": settings.get("codexReasoningAdapter") or "none",
                "streamRetries": stream_retries,
            }
        return {
            "provider": "codex",
            "backend": "api",
            "model": settings.get("codexModel") or CONFIG.OAUTH.defaultModel,
            "baseUrl": CONFIG.OAUTH.baseUrl,
            "accessToken": tokens.get("accessToken"),
            "authTokens": {**tokens},
            "numTokens": settings.get("codexMaxTokens") or 65536,
            "contextWindow": _num_or(settings.get("codexContextWindow"), 0),
            "contextMode": settings.get("codexContextMode") or "trim",
            "temperature": settings.get("codexTemperature"),
            "reasoningEffort": settings.get("codexReasoningEffort"),
            "reasoningAdapter": settings.get("codexReasoningAdapter") or "none",
            "streamRetries": stream_retries,
        }

    if provider == "lmstudio":
        host = re.sub(r"/$", "", str(settings.get("lmstudioHost") or CONFIG.LMSTUDIO.defaultHost))
        declared_ctx = _num_or(settings.get("lmstudioContextWindow"), 0)
        loaded_ctx = await _fetch_lmstudio_loaded_context(host, settings.get("lmstudioModel"))
        context_window = clamp_context_window(declared_ctx, loaded_ctx)
        _warn_context_mismatch(settings.get("lmstudioModel"), loaded_ctx, declared_ctx)
        return {
            "provider": "lmstudio",
            "host": host,
            "baseUrl": f"{host}{CONFIG.LMSTUDIO.apiPath}",
            "model": settings.get("lmstudioModel"),
            "contextWindow": context_window,
            "numTokens": settings.get("lmstudioNumTokens"),
            "temperature": settings.get("lmstudioTemperature"),
            "topP": settings.get("lmstudioTopP"),
            "topK": settings.get("lmstudioTopK"),
            "repeatPenalty": settings.get("lmstudioRepeatPenalty"),
            "reasoningEffort": settings.get("lmstudioReasoningEffort") or "none",
            "reasoningAdapter": settings.get("lmstudioReasoningAdapter") or "none",
            "jsonMode": settings.get("lmstudioJsonMode") or "text",
            "contextMode": settings.get("lmstudioContextMode") or "summarize",
            "streamRetries": stream_retries,
        }

    if provider == "omlx":
        raw = str(settings.get("omlxHost") or CONFIG.OMLX.defaultHost)
        host = re.sub(r"/$", "", re.sub(r"/v1/?$", "", raw, flags=re.IGNORECASE))
        return {
            "provider": "omlx",
            "host": host,
            "baseUrl": f"{host}{CONFIG.OMLX.apiPath}",
            "apiKey": settings.get("omlxApiKey") or "",
            "model": settings.get("omlxModel"),
            "contextWindow": settings.get("omlxContextWindow"),
            "numTokens": settings.get("omlxNumTokens"),
            "temperature": settings.get("omlxTemperature"),
            "topP": settings.get("omlxTopP"),
            "topK": settings.get("omlxTopK"),
            "repeatPenalty": settings.get("omlxRepeatPenalty"),
            "reasoningEffort": settings.get("omlxReasoningEffort") or "none",
            "reasoningAdapter": settings.get("omlxReasoningAdapter") or "none",
            "jsonMode": settings.get("omlxJsonMode") or "text",
            "contextMode": settings.get("omlxContextMode") or "summarize",
            "streamRetries": stream_retries,
        }

    if provider == "huggingface":
        raw = str(settings.get("huggingfaceHost") or CONFIG.HUGGINGFACE.defaultHost)
        host = re.sub(r"/$", "", re.sub(r"/v1/?$", "", raw, flags=re.IGNORECASE))
        return {
            "provider": "huggingface",
            "host": host,
            "baseUrl": f"{host}{CONFIG.HUGGINGFACE.apiPath}",
            "apiKey": settings.get("huggingfaceApiKey") or "",
            "model": settings.get("huggingfaceModel"),
            "contextWindow": settings.get("huggingfaceContextWindow"),
            "numTokens": settings.get("huggingfaceMaxTokens") or 8192,
            "temperature": settings.get("huggingfaceTemperature"),
            "reasoningEffort": settings.get("huggingfaceReasoningEffort") or "none",
            "reasoningAdapter": settings.get("huggingfaceReasoningAdapter") or "none",
            "streamRetries": stream_retries,
        }

    if provider != "ollama":
        raise TypeError(f"Unsupported LLM provider: {provider or 'unknown'}")
    return {
        "provider": "ollama",
        "host": settings.get("ollamaHost"),
        "model": settings.get("ollamaModel"),
        "contextWindow": settings.get("ollamaContextWindow"),
        "numTokens": settings.get("ollamaNumTokens"),
        "temperature": settings.get("ollamaTemperature"),
        "topP": settings.get("ollamaTopP"),
        "topK": settings.get("ollamaTopK"),
        "repeatPenalty": settings.get("ollamaRepeatPenalty"),
        "reasoningEffort": settings.get("ollamaReasoningEffort") or "none",
        "reasoningAdapter": settings.get("ollamaReasoningAdapter") or "none",
        "jsonMode": settings.get("ollamaJsonMode") or "json",
        "streamRetries": stream_retries,
    }


def llm_ready(settings, role="global"):
    """Cheap readiness check (no network) for status endpoints and scheduler gating."""
    provider = provider_for_role(settings, role)
    if provider == "claude":
        t = settings.get("claudeTokens")
        has_token = bool(t and (t.get("accessToken") or t.get("refreshToken")))
        has_model = bool(settings.get("claudeModel") or CONFIG.CLAUDE.defaultModel)
        return has_token and has_model
    if provider == "codex":
        t = settings.get("codexTokens")
        has_token = bool(t and (t.get("accessToken") or t.get("refreshToken")))
        has_model = bool(settings.get("codexModel") or CONFIG.OAUTH.defaultModel)
        return has_token and has_model
    if provider == "lmstudio":
        return bool(settings.get("lmstudioHost") and settings.get("lmstudioModel"))
    if provider == "omlx":
        return bool(settings.get("omlxHost") and settings.get("omlxModel"))
    if provider == "huggingface":
        # The HF access token is mandatory (the router rejects unauthenticated calls).
        return bool(settings.get("huggingfaceApiKey") and settings.get("huggingfaceModel"))
    return bool(settings.get("ollamaHost") and settings.get("ollamaModel"))


def not_ready_reason(settings, role="global"):
    """Human-readable 'not ready' reason for the given role's provider."""
    provider = provider_for_role(settings, role)
    if provider == "claude":
        return "Sign in with Claude in Settings → LLM to enable enrichment."
    if provider == "codex":
        return "Sign in with Codex (OpenAI) in Settings → LLM to enable enrichment."
    if provider == "lmstudio":
        return "Set the LM Studio host and model in Settings → LLM to enable enrichment."
    if provider == "omlx":
        return "Set the oMLX host and model in Settings → LLM to enable enrichment."
    if provider == "huggingface":
        return "Add your Hugging Face access token and model in Settings → LLM to enable enrichment."
    return "Set the Ollama host and model in Settings → LLM to enable enrichment."
