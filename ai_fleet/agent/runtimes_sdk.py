"""SDK-specific executors for the codex-sdk and claude-agent-sdk runtimes.

Kept in a separate module from runtimes.py so the (default, critical) deepagent
path never imports the optional official SDKs. Both executors adapt
agent/runtimes.js executeCodex/executeClaude to the Python SDK APIs
(openai_codex.AsyncCodex, claude_agent_sdk.query).
"""

from __future__ import annotations

import os


def _llm_get(llm, key, default=None):
    if isinstance(llm, dict):
        return llm.get(key, default)
    return getattr(llm, key, default)


def _usage_to_dict(usage):
    if usage is None:
        return None
    if isinstance(usage, dict):
        return usage
    # pydantic / dataclass usage object → dict
    for attr in ("model_dump", "dict", "_asdict"):
        fn = getattr(usage, attr, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                pass
    return {
        k: getattr(usage, k)
        for k in (
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "reasoning_output_tokens",
            "total_tokens",
        )
        if hasattr(usage, k)
    }


async def execute_codex(options, prompt, ctx):
    AgentRuntimeError = ctx["AgentRuntimeError"]
    llm = options.get("llm")
    if not llm or _llm_get(llm, "provider") != "codex":
        raise AgentRuntimeError("Codex SDK requires the hosted Codex/OpenAI model slot.", "runtime_provider_mismatch", 400)
    if not _llm_get(llm, "accessToken"):
        raise AgentRuntimeError(
            "Codex SDK authentication is unavailable. Sign in with Codex in Settings and try again.",
            "runtime_auth_unavailable",
            401,
        )
    try:
        import openai_codex
    except Exception as error:
        raise AgentRuntimeError(
            "Codex SDK is unavailable. Install openai-codex in ai_fleet and restart the service.",
            "runtime_unavailable",
            503,
            cause=error,
        )
    if not hasattr(openai_codex, "AsyncCodex"):
        raise AgentRuntimeError("The installed Codex SDK does not export AsyncCodex.", "runtime_unavailable", 503)

    cwd = ctx["assert_working_directory"](options.get("rootDir"))
    chatgpt_auth = _llm_get(llm, "backend") == "chatgpt"
    ephemeral_auth = None
    try:
        env = ctx["build_safe_agent_env"](options.get("env") or dict(os.environ), cwd)
        if chatgpt_auth:
            ephemeral_auth = ctx["prepare_codex_chatgpt_home"](llm, env)
            env = ephemeral_auth["env"]
        system_prompt = ctx["clean_system_prompt"](options.get("systemPrompt"), options.get("ctx"))

        config_kwargs = {}
        # Trusted developer instructions are the authority-preserving channel.
        if system_prompt:
            config_kwargs["developer_instructions"] = system_prompt
        if not chatgpt_auth:
            config_kwargs["api_key"] = _llm_get(llm, "accessToken")
            if _llm_get(llm, "baseUrl"):
                config_kwargs["base_url"] = _llm_get(llm, "baseUrl")
        config_kwargs["env"] = env

        try:
            config = openai_codex.CodexConfig(**config_kwargs)
        except Exception:
            # Older/newer SDKs may accept a subset; retry with the minimal set.
            config = openai_codex.CodexConfig(env=env)
        client = openai_codex.AsyncCodex(config)

        sandbox = "read-only" if options.get("backendKind") == "filesystem" else "workspace-write"
        effort = ctx["reasoning_effort"](_llm_get(llm, "reasoningEffort"))
        run_kwargs = {
            "cwd": cwd,
            "model": _llm_get(llm, "model") or None,
            "sandbox": sandbox,
        }
        if effort:
            run_kwargs["effort"] = effort

        # Prefer an explicit thread; fall back to a direct run if unavailable.
        thread = None
        for starter in ("start_thread", "startThread"):
            if hasattr(client, starter):
                thread = getattr(client, starter)()
                break
        if thread is None:
            raise AgentRuntimeError("The installed Codex SDK does not expose a thread starter.", "runtime_unavailable", 503)

        turn = await thread.run(prompt, **run_kwargs)
        final_text = str(getattr(turn, "final_response", "") or "")
        return {
            "runtime": "codex-sdk",
            "provider": "codex",
            "model": _llm_get(llm, "model"),
            "workflowPattern": options.get("workflowPattern"),
            "result": turn,
            "messages": ctx["assistant_messages_from_text"](final_text),
            "finalText": final_text,
            "usage": ctx["normalize_usage"](_usage_to_dict(getattr(turn, "usage", None))),
            "costUsd": None,
            "sessionId": getattr(thread, "id", None) or None,
        }
    except Exception as error:
        raise ctx["wrap_execution_error"]("codex-sdk", error)
    finally:
        if ephemeral_auth:
            ephemeral_auth["cleanup"]()


async def execute_claude(options, prompt, ctx):
    AgentRuntimeError = ctx["AgentRuntimeError"]
    llm = options.get("llm")
    if not llm or _llm_get(llm, "provider") != "claude":
        raise AgentRuntimeError("Claude Agent SDK requires the hosted Claude model slot.", "runtime_provider_mismatch", 400)
    if not _llm_get(llm, "accessToken"):
        raise AgentRuntimeError(
            "Claude Agent SDK authentication is unavailable. Sign in with Claude in Settings and try again.",
            "runtime_auth_unavailable",
            401,
        )
    try:
        import claude_agent_sdk as sdk
    except Exception as error:
        raise AgentRuntimeError(
            "Claude Agent SDK is unavailable. Install claude-agent-sdk in ai_fleet and restart the service.",
            "runtime_unavailable",
            503,
            cause=error,
        )
    if not hasattr(sdk, "query"):
        raise AgentRuntimeError("The installed Claude Agent SDK does not export query.", "runtime_unavailable", 503)

    cwd = ctx["assert_working_directory"](options.get("rootDir"))
    env = ctx["build_safe_agent_env"](options.get("env") or dict(os.environ), cwd)
    credential = str(_llm_get(llm, "accessToken") or "")
    if credential:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = credential
    env["CLAUDE_AGENT_SDK_CLIENT_APP"] = "tech-symphony/1.0"

    planner_web_search = ctx["planner_web_search_allowed"](options)
    if options.get("backendKind") == "filesystem":
        sdk_tools = ["Read", "Glob", "Grep", *(["WebSearch"] if planner_web_search else [])]
    elif credential:
        sdk_tools = ["Read", "Edit", "Write", "Glob", "Grep"]
    else:
        sdk_tools = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"]
    if options.get("workflowPattern") in ("parallel", "supervisor"):
        sdk_tools.append("Task")  # the Claude Code subagent tool

    guard = ctx["claude_permission_guard"](cwd, bool(credential))

    async def can_use_tool(tool_name, input_, context=None):
        decision = await guard(tool_name, input_)
        if decision.get("behavior") == "deny":
            return sdk.PermissionResultDeny(message=decision.get("message", "Denied."))
        return sdk.PermissionResultAllow(updated_input=decision.get("updatedInput") or input_)

    system_prompt = ctx["clean_system_prompt"](options.get("systemPrompt"), options.get("ctx")) or None
    options_obj = sdk.ClaudeAgentOptions(
        cwd=cwd,
        env=env,
        model=_llm_get(llm, "model") or None,
        max_turns=int(options.get("maxTurns") or 24),
        system_prompt=system_prompt,
        setting_sources=[],
        strict_mcp_config=True,
        allowed_tools=sdk_tools,
        permission_mode="default",
        can_use_tool=can_use_tool,
    )

    messages = []
    outcome = None
    try:
        async for message in sdk.query(prompt=prompt, options=options_obj):
            messages.append(message)
            if isinstance(message, sdk.ResultMessage):
                outcome = message
            on_event = options.get("onEvent")
            if callable(on_event):
                on_event(message)
    except Exception as error:
        raise ctx["wrap_execution_error"]("claude-agent-sdk", error)

    if not outcome:
        raise AgentRuntimeError("Claude Agent SDK ended without a result message.", "runtime_incomplete", 502)
    subtype = getattr(outcome, "subtype", None)
    if getattr(outcome, "is_error", False) or subtype != "success":
        error = AgentRuntimeError(
            f"Claude Agent SDK did not complete ({subtype or 'unknown result'}).",
            "runtime_execution_failed",
            502,
            usage=ctx["normalize_usage"](_usage_to_dict(getattr(outcome, "usage", None))),
            costUsd=ctx["finite_number"](getattr(outcome, "total_cost_usd", None)),
        )
        raise error
    return {
        "runtime": "claude-agent-sdk",
        "provider": "claude",
        "model": _llm_get(llm, "model"),
        "workflowPattern": options.get("workflowPattern"),
        "result": outcome,
        "messages": messages,
        "finalText": str(getattr(outcome, "result", "") or ""),
        "usage": ctx["normalize_usage"](_usage_to_dict(getattr(outcome, "usage", None))),
        "costUsd": ctx["finite_number"](getattr(outcome, "total_cost_usd", None)),
        "sessionId": getattr(outcome, "session_id", None) or None,
    }
