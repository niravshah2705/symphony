"""Provider-neutral agent-runtime registry (port of agent/runtimes.js).

`deepagent` keeps the LangGraph/deepagents execution path. The two SDK runtimes
(Codex SDK, Claude Agent SDK) are loaded lazily so a deployment can keep using
the default without paying their startup cost, and so a partial installation
fails with a useful operator diagnostic instead of falling back to another
provider.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .repository_broker import build_safe_agent_env
from .workflow_patterns import PATTERNS, pattern_id

RUNTIMES = {
    "deepagent": {"id": "deepagent", "label": "DeepAgent", "packageName": "deepagents"},
    "codex-sdk": {"id": "codex-sdk", "label": "Codex SDK", "packageName": "openai-codex"},
    "claude-agent-sdk": {"id": "claude-agent-sdk", "label": "Claude Agent SDK", "packageName": "claude-agent-sdk"},
}

# Short, operator-facing "harness" names surfaced on traces and the Settings UI.
HARNESS_LABELS = {"deepagent": "deepagent", "codex-sdk": "codex", "claude-agent-sdk": "claudecode"}


def harness_label(runtime):
    return HARNESS_LABELS.get(runtime, runtime)


WORKFLOW_PATTERNS = {
    "sequential": {"id": "sequential", "label": "Sequential", "directive": ""},
    "parallel": {
        "id": "parallel",
        "label": "Parallel workstreams",
        "directive": (
            "Split independent investigation or validation work into parallel workstreams when the runtime supports it. "
            "Never let two workers edit the same file or mutate the same repository state concurrently; synthesize their findings before editing."
        ),
    },
    "evaluator": {
        "id": "evaluator",
        "label": "Generator + evaluator",
        "directive": (
            "Use a generator-evaluator loop: produce a candidate, evaluate it against the task acceptance criteria, repair concrete gaps, then validate the final result."
        ),
    },
    "supervisor": {
        "id": "supervisor",
        "label": "Supervisor",
        "directive": (
            "Act as a supervisor: decompose the task into bounded specialist work, review each result before accepting it, and integrate only verified changes into the final outcome."
        ),
    },
}


class AgentRuntimeError(Exception):
    def __init__(self, message, code="agent_runtime_error", status=502, **details):
        super().__init__(message)
        self.message = message
        self.name = "AgentRuntimeError"
        self.code = code
        self.status = status
        for k, v in details.items():
            setattr(self, k, v)


def normalize_agent_runtime(value, strict=False):
    id_ = str(value or "deepagent").strip().lower()
    if id_ in RUNTIMES:
        return id_
    if strict:
        raise AgentRuntimeError(
            f"Agent runtime must be one of: {', '.join(RUNTIMES.keys())}.", "invalid_agent_runtime", 400
        )
    return "deepagent"


def effective_agent_runtime(value, llm, strict=False, workflow=""):
    runtime = normalize_agent_runtime(value, strict=strict)
    provider = llm and llm.get("provider") if isinstance(llm, dict) else (getattr(llm, "provider", None) if llm else None)
    if workflow == "coding" and runtime != "deepagent":
        return "deepagent"
    if runtime == "codex-sdk" and provider != "codex":
        return "deepagent"
    if runtime == "claude-agent-sdk" and provider != "claude":
        return "deepagent"
    return runtime


def normalize_workflow_pattern(value, strict=False):
    requested = "sequential" if value is None or value == "" else value
    id_ = pattern_id(requested)
    if id_ and id_ in WORKFLOW_PATTERNS:
        return id_
    if strict:
        raise AgentRuntimeError(
            f"Workflow pattern must be one of: {', '.join(WORKFLOW_PATTERNS.keys())}.", "invalid_workflow_pattern", 400
        )
    return "sequential"


def runtime_catalog():
    return [{"id": r["id"], "label": r["label"]} for r in RUNTIMES.values()]


def workflow_pattern_catalog():
    return [{"id": p["id"], "label": p["label"]} for p in PATTERNS]


def apply_workflow_pattern(prompt, value):
    pattern = normalize_workflow_pattern(value, strict=True)
    directive = WORKFLOW_PATTERNS[pattern]["directive"]
    if not directive:
        return str(prompt or "")
    return "\n".join([f'<workflow_pattern id="{pattern}">', directive, "</workflow_pattern>", "", str(prompt or "")])


def _clean_system_prompt(system_prompt, ctx):
    value = system_prompt(ctx or {}) if callable(system_prompt) else system_prompt
    return str(value or "").strip()


def _assert_working_directory(value):
    cwd = os.path.abspath(value or os.getcwd())
    if not os.path.exists(cwd):
        raise AgentRuntimeError(f"Agent working directory does not exist: {cwd}", "invalid_working_directory", 400)
    if not os.path.isdir(cwd):
        raise AgentRuntimeError(f"Agent working directory is not a directory: {cwd}", "invalid_working_directory", 400)
    return cwd


def _remove_ephemeral_home(home):
    if not home:
        return
    try:
        shutil.rmtree(home, ignore_errors=True)
    except Exception:
        pass


def _iso_now():
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _prepare_codex_chatgpt_home(llm, base_env):
    """Seed the file-backed Codex ChatGPT auth cache for one SDK run."""
    tokens = llm.get("authTokens") if isinstance(llm, dict) else getattr(llm, "authTokens", None)
    access_token = str((tokens or {}).get("accessToken") or "")
    id_token = str((tokens or {}).get("idToken") or "")
    account_id = str((llm.get("accountId") if isinstance(llm, dict) else getattr(llm, "accountId", "")) or "")
    if not access_token or not id_token or not account_id:
        raise AgentRuntimeError(
            "Codex ChatGPT authentication is incomplete. Sign in with Codex in Settings and try again.",
            "runtime_auth_unavailable",
            401,
        )
    home = None
    try:
        home = tempfile.mkdtemp(prefix="techsymphony-codex-home-")
        os.chmod(home, 0o700)
        codex_home = os.path.join(home, ".codex")
        os.mkdir(codex_home, mode=0o700)
        os.chmod(codex_home, 0o700)
        auth_file = os.path.join(codex_home, "auth.json")
        auth = {
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": None,
            "tokens": {
                "id_token": id_token,
                "access_token": access_token,
                "refresh_token": "",
                "account_id": account_id,
            },
            "last_refresh": _iso_now(),
        }
        fd = os.open(auth_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(auth) + "\n")
        os.chmod(auth_file, 0o600)
        env = {
            **base_env,
            "HOME": home,
            "CODEX_HOME": codex_home,
            "XDG_CONFIG_HOME": os.path.join(home, ".config"),
            "XDG_CACHE_HOME": os.path.join(home, ".cache"),
        }
        state = {"cleaned": False}

        def cleanup():
            if state["cleaned"]:
                return
            state["cleaned"] = True
            _remove_ephemeral_home(home)

        return {"home": home, "authFile": auth_file, "env": env, "cleanup": cleanup}
    except Exception as error:
        _remove_ephemeral_home(home)
        if isinstance(error, AgentRuntimeError):
            raise
        raise AgentRuntimeError(
            "Could not prepare isolated Codex authentication for this run.", "runtime_auth_setup_failed", 500, cause=error
        )


def _finite_number(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def normalize_usage(value):
    if not value or not isinstance(value, dict):
        return None

    def pick(*keys):
        for k in keys:
            if k in value and value[k] is not None:
                return _finite_number(value[k])
        return None

    input_tokens = pick("inputTokens", "input_tokens")
    output_tokens = pick("outputTokens", "output_tokens")
    cached_input_tokens = pick("cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens")
    cache_creation_input_tokens = pick("cacheCreationInputTokens", "cache_creation_input_tokens")
    reasoning_output_tokens = pick("reasoningOutputTokens", "reasoning_output_tokens")
    reported_total = pick("totalTokens", "total_tokens")
    total_tokens = reported_total
    if total_tokens is None and (input_tokens is not None or output_tokens is not None):
        total_tokens = (input_tokens or 0) + (output_tokens or 0)
    if all(
        v is None
        for v in (input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens)
    ):
        return None
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cachedInputTokens": cached_input_tokens,
        "cacheCreationInputTokens": cache_creation_input_tokens,
        "reasoningOutputTokens": reasoning_output_tokens,
        "totalTokens": total_tokens,
    }


def _merge_usage(target, source):
    if not source:
        return target
    next_ = target or {
        "inputTokens": 0,
        "outputTokens": 0,
        "cachedInputTokens": 0,
        "cacheCreationInputTokens": 0,
        "reasoningOutputTokens": 0,
        "totalTokens": 0,
    }
    for key in list(next_.keys()):
        next_[key] += source.get(key) or 0
    return next_


def deep_agent_usage(messages):
    usage = None
    for message in messages if isinstance(messages, list) else []:
        meta = None
        if isinstance(message, dict):
            meta = message.get("usage_metadata") or message.get("usage")
        else:
            meta = getattr(message, "usage_metadata", None) or getattr(message, "usage", None)
        usage = _merge_usage(usage, normalize_usage(meta))
    return usage


def _deep_agent_cost(messages):
    total = 0
    found = False
    for message in messages if isinstance(messages, list) else []:
        if isinstance(message, dict):
            metadata = message.get("usage_metadata") or message.get("response_metadata") or {}
        else:
            metadata = getattr(message, "usage_metadata", None) or getattr(message, "response_metadata", None) or {}
        value = _finite_number(metadata.get("total_cost_usd") if isinstance(metadata, dict) else None)
        if value is None and isinstance(metadata, dict):
            value = _finite_number(metadata.get("cost_usd") or metadata.get("cost"))
        if value is not None:
            total += value
            found = True
    return total if found else None


def _assistant_messages_from_text(text):
    return [{"role": "assistant", "content": text}] if text else []


def _public_execution(result):
    return {
        "runtime": result["runtime"],
        "provider": result["provider"],
        "model": result["model"],
        "workflowPattern": result["workflowPattern"],
        "finalText": str(result.get("finalText") or "")[:20000],
        "usage": result["usage"],
        "costUsd": result["costUsd"],
        "costAvailable": result["costUsd"] is not None,
        "sessionId": result.get("sessionId") or None,
    }


def plUsage(llm, key, default=None):
    if isinstance(llm, dict):
        return llm.get(key, default)
    return getattr(llm, key, default)


def _lang_smith_provider(llm):
    provider = plUsage(llm, "provider") if llm else None
    if provider == "codex":
        return "openai"
    if provider == "claude":
        return "anthropic"
    if provider in ("lmstudio", "omlx", "huggingface"):
        return "openai"
    return provider or "unknown"


def reasoning_effort(value):
    effort = str(value or "").lower()
    return effort if effort in ("minimal", "low", "medium", "high", "xhigh") else None


def planner_web_search_allowed(options):
    return bool(options and options.get("workflow") == "planning" and options.get("backendKind") == "filesystem")


def _safe_path_in(cwd, candidate):
    if not isinstance(candidate, str) or not candidate:
        return True
    root = os.path.realpath(cwd)
    resolved = os.path.abspath(os.path.join(cwd, candidate))
    existing = resolved
    while not os.path.exists(existing):
        parent = os.path.dirname(existing)
        if parent == existing:
            return False
        existing = parent
    try:
        real_existing = os.path.realpath(existing)
    except OSError:
        return False
    real_relative = os.path.relpath(real_existing, root)
    return real_relative != ".." and not real_relative.startswith(f"..{os.sep}") and not os.path.isabs(real_relative)


def claude_permission_guard(cwd, carries_credential):
    async def guard(tool_name, input_):
        if carries_credential and tool_name == "Bash":
            return {
                "behavior": "deny",
                "message": "Bash is disabled for this run because SDK authentication is held in the subprocess environment.",
            }
        for key in ("file_path", "path", "notebook_path"):
            if not _safe_path_in(cwd, (input_ or {}).get(key)):
                return {"behavior": "deny", "message": "Tool access is limited to the prepared agent workspace."}
        return {"behavior": "allow", "updatedInput": input_}

    return guard


async def _execute_deep_agent(options, prompt):
    invoke = options.get("deepAgentInvoke")
    if not callable(invoke):
        raise AgentRuntimeError("DeepAgent runtime was selected without a prepared agent.", "runtime_not_prepared", 500)
    result = await invoke(prompt, options.get("invokeConfig") or {})
    messages = (result or {}).get("messages") or []
    llm = options.get("llm")
    return {
        "runtime": "deepagent",
        "provider": plUsage(llm, "provider") if llm else None,
        "model": plUsage(llm, "model") if llm else None,
        "workflowPattern": options.get("workflowPattern"),
        "result": result,
        "messages": messages,
        "finalText": options["lastText"](result) if callable(options.get("lastText")) else "",
        "usage": deep_agent_usage(messages),
        "costUsd": _deep_agent_cost(messages),
        "sessionId": None,
    }


async def _execute_codex(options, prompt):
    """Codex SDK executor. Adapts agent/runtimes.js executeCodex to the Python
    openai-codex SDK. See _refine notes; verified against the installed SDK."""
    from . import runtimes_sdk  # local import: SDK-specific glue kept isolated

    return await runtimes_sdk.execute_codex(options, prompt, _codex_context())


async def _execute_claude(options, prompt):
    from . import runtimes_sdk

    return await runtimes_sdk.execute_claude(options, prompt, _claude_context())


def _codex_context():
    return {
        "AgentRuntimeError": AgentRuntimeError,
        "assert_working_directory": _assert_working_directory,
        "build_safe_agent_env": build_safe_agent_env,
        "prepare_codex_chatgpt_home": _prepare_codex_chatgpt_home,
        "clean_system_prompt": _clean_system_prompt,
        "reasoning_effort": reasoning_effort,
        "planner_web_search_allowed": planner_web_search_allowed,
        "normalize_usage": normalize_usage,
        "assistant_messages_from_text": _assistant_messages_from_text,
        "wrap_execution_error": _wrap_execution_error,
    }


def _claude_context():
    return {
        "AgentRuntimeError": AgentRuntimeError,
        "assert_working_directory": _assert_working_directory,
        "build_safe_agent_env": build_safe_agent_env,
        "clean_system_prompt": _clean_system_prompt,
        "planner_web_search_allowed": planner_web_search_allowed,
        "claude_permission_guard": claude_permission_guard,
        "normalize_usage": normalize_usage,
        "finite_number": _finite_number,
        "wrap_execution_error": _wrap_execution_error,
    }


def _wrap_execution_error(runtime, error):
    if isinstance(error, AgentRuntimeError):
        return error
    message = " ".join(str(getattr(error, "message", None) or str(error) or "Unknown SDK error.").split())[:500]
    return AgentRuntimeError(
        f"{RUNTIMES[runtime]['label']} execution failed: {message}",
        "runtime_execution_failed",
        502,
        cause=error,
        usage=getattr(error, "usage", None),
        costUsd=_finite_number(getattr(error, "costUsd", None)),
    )


_EXECUTORS = {"deepagent": _execute_deep_agent, "codex-sdk": _execute_codex, "claude-agent-sdk": _execute_claude}


def _trace_metadata(result_or_error):
    usage = result_or_error.get("usage") if isinstance(result_or_error, dict) else getattr(result_or_error, "usage", None)
    cost_usd = _finite_number(result_or_error.get("costUsd") if isinstance(result_or_error, dict) else getattr(result_or_error, "costUsd", None))
    metadata = {"usage_available": bool(usage), "cost_available": cost_usd is not None}
    if usage:
        metadata["usage_metadata"] = {
            "input_tokens": usage["inputTokens"],
            "output_tokens": usage["outputTokens"],
            "total_tokens": usage["totalTokens"],
            **({"total_cost": cost_usd} if cost_usd is not None else {}),
        }
        metadata["usage_input_tokens"] = usage["inputTokens"]
        metadata["usage_output_tokens"] = usage["outputTokens"]
        metadata["usage_total_tokens"] = usage["totalTokens"]
        metadata["usage_cached_input_tokens"] = usage["cachedInputTokens"]
        metadata["usage_reasoning_output_tokens"] = usage["reasoningOutputTokens"]
    if cost_usd is not None:
        metadata["cost_usd"] = cost_usd
    return metadata


def _annotate_trace(result_or_error):
    try:
        from langsmith import get_current_run_tree

        current = get_current_run_tree()
        if current is not None:
            current.metadata = {**(current.metadata or {}), **_trace_metadata(result_or_error)}
    except Exception:
        pass  # No active LangSmith context (tracing disabled) is a normal deployment.


async def execute_agent_runtime(options=None):
    """Execute one workflow with a normalized result contract and one LangSmith
    root span, regardless of the selected SDK."""
    options = options or {}
    requested_runtime = normalize_agent_runtime(options.get("runtime"), strict=True)
    runtime = effective_agent_runtime(
        requested_runtime, options.get("llm"), strict=True, workflow=options.get("workflow") or ""
    )
    workflow_pattern = normalize_workflow_pattern(options.get("workflowPattern"), strict=True)
    prompt = apply_workflow_pattern(options.get("prompt"), workflow_pattern)

    async def execute():
        try:
            value = await _EXECUTORS[runtime]({**options, "runtime": runtime, "workflowPattern": workflow_pattern}, prompt)
            _annotate_trace(value)
            return value
        except Exception as error:
            wrapped = _wrap_execution_error(runtime, error)
            _annotate_trace(wrapped)
            raise wrapped

    if options.get("trace") is False:
        return await execute()

    invoke_config = options.get("invokeConfig") or {}
    harness = harness_label(runtime)
    model_name = (plUsage(options.get("llm"), "model") if options.get("llm") else "") or ""
    trace_metadata_base = {
        **(invoke_config.get("metadata") or {}),
        "agent_runtime": runtime,
        "harness": harness,
        **(
            {
                "requested_agent_runtime": requested_runtime,
                "runtime_fallback_reason": "workflow_requires_broker" if options.get("workflow") == "coding" else "provider_mismatch",
            }
            if requested_runtime != runtime
            else {}
        ),
        "model_provider": (plUsage(options.get("llm"), "provider") if options.get("llm") else None) or "unknown",
        "model_name": model_name or "unknown",
        "ls_provider": _lang_smith_provider(options.get("llm")),
        "ls_model_name": model_name or "unknown",
        "workflow_pattern": workflow_pattern,
        "workflow_name": options.get("workflow") or "agent",
    }
    tags = list(
        dict.fromkeys(
            [
                *(invoke_config.get("tags") or []),
                *(options.get("tags") or []),
                f"runtime:{runtime}",
                f"harness:{harness}",
                f"pattern:{workflow_pattern}",
                *([f"model:{model_name}"] if model_name else []),
            ]
        )
    )
    try:
        from langsmith import traceable

        traced = traceable(
            name=str(invoke_config.get("runName") or f"agent-runtime:{runtime}")[:120],
            run_type="chain" if runtime == "deepagent" else "llm",
            tags=tags,
            metadata=trace_metadata_base,
        )(execute)
        return await traced()
    except Exception as error:
        # Tracing setup must never mask a real execution; if traceable is
        # unavailable, run untraced (fail-open, matching the JS "no context" case).
        if isinstance(error, AgentRuntimeError):
            raise
        return await execute()
