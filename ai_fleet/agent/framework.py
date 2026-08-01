"""Workflow-driven deep-agent framework (port of agent/framework.js).

Both the planning and coding agents are the SAME machine configured by a
declarative workflow descriptor (ai_fleet/agent/workflows/<name>.py). A workflow
declares which SKILLS to load, which TOOLS to attach, the backend kind, the
system prompt, and run limits. This module turns that descriptor into a live
`deepagents` agent and runs it.

Backends:
  - 'filesystem' — FilesystemBackend (read/write files, NO shell). Used by the planner.
  - 'shell'      — LocalShellBackend (fs + shell). Used by the coder, rooted at an
    isolated git workspace.
"""

from __future__ import annotations

import importlib
import os
import shutil
import stat
import subprocess
import tempfile
import uuid
from pathlib import Path

from .safe_read import install_safe_read

SKILLS_SRC = Path(__file__).parent / "skills"
SKILLS_DEST_DIRNAME = ".agent-skills"
SKILLS_OWNER_MARKER = ".tech-symphony-managed"
SKILLS_OWNER_MARKER_CONTENT = "tech-symphony-agent-skills-v1\n"


def _lstat_or_none(p):
    try:
        return os.lstat(p)
    except FileNotFoundError:
        return None


def _is_dir(p):
    try:
        return stat.S_ISDIR(os.stat(p).st_mode)
    except OSError:
        return False


def _assert_contained(real_root, candidate):
    relative = os.path.relpath(os.path.abspath(candidate), real_root)
    if relative == ".." or relative.startswith(f"..{os.sep}") or os.path.isabs(relative):
        raise ValueError(f"Refusing to install skills outside destination root: {candidate}")


def _assert_no_symlinks(target):
    st = _lstat_or_none(target)
    if not st:
        return
    if stat.S_ISLNK(st.st_mode):
        raise ValueError(f"Refusing symbolic link inside skill destination: {target}")
    if not stat.S_ISDIR(st.st_mode):
        return
    for entry in os.listdir(target):
        _assert_no_symlinks(os.path.join(target, entry))


def _validate_skill_name(name):
    if (
        not isinstance(name, str)
        or not name
        or name == "."
        or name == ".."
        or os.path.basename(name) != name
        or "/" in name
        or "\\" in name
    ):
        raise ValueError(f"Invalid skill name: {name}")


def _tracked_skill_paths(root):
    try:
        output = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--", SKILLS_DEST_DIRNAME],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return [line.strip() for line in output.splitlines() if line.strip()]
    except Exception:
        # Scratch workspaces are intentionally not Git repositories.
        return []


def _claim_skills_directory(dest, real_root):
    existing = _lstat_or_none(dest)
    if existing:
        if stat.S_ISLNK(existing.st_mode):
            raise ValueError(f"Refusing symbolic-link skill destination: {dest}")
        if not stat.S_ISDIR(existing.st_mode):
            raise ValueError(f"Refusing non-directory skill destination: {dest}")
        _assert_contained(real_root, os.path.realpath(dest))
        _assert_no_symlinks(dest)
        marker = os.path.join(dest, SKILLS_OWNER_MARKER)
        marker_stat = _lstat_or_none(marker)
        if not marker_stat or stat.S_ISLNK(marker_stat.st_mode) or not stat.S_ISREG(marker_stat.st_mode):
            raise ValueError(f"Refusing project-owned skill directory without a valid ownership marker: {dest}")
        with open(marker, encoding="utf-8") as fh:
            if fh.read() != SKILLS_OWNER_MARKER_CONTENT:
                raise ValueError(f"Refusing skill directory with an invalid ownership marker: {dest}")
        return

    _assert_contained(real_root, dest)
    os.mkdir(dest)
    _assert_contained(real_root, os.path.realpath(dest))
    fd = os.open(os.path.join(dest, SKILLS_OWNER_MARKER), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(SKILLS_OWNER_MARKER_CONTENT)


def install_skills(dest_root, skill_names=None):
    """Copy named skills into dest_root/.agent-skills/ and return their
    backend-relative paths (e.g. /.agent-skills/software-planning/)."""
    root = os.path.abspath(dest_root)
    root_stat = _lstat_or_none(root)
    if not root_stat or not stat.S_ISDIR(root_stat.st_mode):
        raise ValueError(f"Skill destination root is not a directory: {root}")
    real_root = os.path.realpath(root)
    dest = os.path.join(real_root, SKILLS_DEST_DIRNAME)
    available = [n for n in os.listdir(SKILLS_SRC) if _is_dir(os.path.join(SKILLS_SRC, n))]
    names = skill_names if isinstance(skill_names, list) and skill_names else available
    for name in names:
        _validate_skill_name(name)

    tracked = _tracked_skill_paths(root)
    if tracked:
        raise ValueError(
            f"Refusing to install framework skills over tracked project files in {SKILLS_DEST_DIRNAME}: {', '.join(tracked[:3])}"
        )

    _claim_skills_directory(dest, real_root)
    paths = []
    for name in dict.fromkeys(names):
        from_ = os.path.join(SKILLS_SRC, name)
        if not _is_dir(from_):
            continue
        _assert_no_symlinks(from_)
        to = os.path.join(dest, name)
        _assert_contained(real_root, to)
        _assert_no_symlinks(to)
        shutil.rmtree(to, ignore_errors=True)
        shutil.copytree(from_, to)
        paths.append(f"/{SKILLS_DEST_DIRNAME}/{name}/")
    return paths


def build_backend(kind, root_dir, opts=None):
    """Build the backend for a workflow kind, rooted at root_dir."""
    opts = opts or {}
    from deepagents.backends import FilesystemBackend, LocalShellBackend

    if kind == "shell":
        from .repository_broker import build_safe_agent_env

        env = build_safe_agent_env(opts.get("env") or dict(os.environ), root_dir)
        return LocalShellBackend(
            root_dir=str(root_dir), virtual_mode=False, env=env, inherit_env=False, timeout=opts.get("timeout") or 600
        )
    return FilesystemBackend(root_dir=str(root_dir), virtual_mode=False)


def load_workflow(name):
    """Load a workflow descriptor by name from workflows/<name>.py."""
    try:
        module = importlib.import_module(f"ai_fleet.agent.workflows.{name}")
    except ModuleNotFoundError:
        raise ValueError(f'Unknown workflow "{name}".')
    return module.WORKFLOW


def prepare_scratch(workflow):
    """Prepare an isolated scratch directory for a repo-less workflow (e.g. planner)."""
    root_dir = os.path.join(tempfile.gettempdir(), "techsym-agent", f"{workflow['name']}-{str(uuid.uuid4())[:8]}")
    os.makedirs(root_dir, exist_ok=True)
    skill_paths = install_skills(root_dir, workflow.get("skills"))

    def cleanup():
        shutil.rmtree(root_dir, ignore_errors=True)

    return {"rootDir": root_dir, "skillPaths": skill_paths, "cleanup": cleanup}


def _resolve_system_prompt(workflow, ctx):
    sp = workflow.get("systemPrompt")
    return sp(ctx) if callable(sp) else sp


def build_agent(workflow, llm, backend=None, skill_paths=None, root_dir=None, ctx=None, extra_tools=None, env=None):
    """Build a deep agent from a workflow descriptor."""
    from deepagents import create_deep_agent

    from . import llm as llm_module
    from . import tools as tool_registry
    from .fs_arg_normalizer import create_fs_arg_normalizer_middleware

    ctx = ctx or {}
    extra_tools = extra_tools or []
    skills = skill_paths
    be = backend
    if be is None:
        if not root_dir:
            raise ValueError("build_agent needs a backend or a root_dir.")
        skills = skills if skills is not None else install_skills(root_dir, workflow.get("skills"))
        be = build_backend(workflow.get("backend"), root_dir, {"timeout": workflow.get("shellTimeoutSec"), "env": env})
    be = install_safe_read(be)
    tools = [*tool_registry.build_many(workflow.get("tools"), ctx), *extra_tools]
    system_prompt = _resolve_system_prompt(workflow, ctx)
    middleware = [create_fs_arg_normalizer_middleware()]
    agent = create_deep_agent(
        model=llm_module.create_chat_model(llm),
        backend=be,
        skills=skills,
        tools=tools,
        system_prompt=system_prompt,
        middleware=middleware,
    )
    return {"agent": agent, "backend": be, "skillPaths": skills, "tools": tools}


async def run_workflow(
    workflow,
    llm,
    user_message,
    backend=None,
    skill_paths=None,
    root_dir=None,
    ctx=None,
    invoke_config=None,
    runtime="deepagent",
    workflow_pattern="sequential",
    env=None,
):
    """Run a workflow agent to completion on a single user message and return
    {result, messages, finalText}."""
    from .runtimes import execute_agent_runtime, normalize_agent_runtime, effective_agent_runtime

    ctx = ctx or {}
    invoke_config = invoke_config or {}
    scratch = None
    if backend is None and not root_dir:
        scratch = prepare_scratch(workflow)
        root_dir = scratch["rootDir"]
        skill_paths = scratch["skillPaths"]
    try:
        requested_runtime = normalize_agent_runtime(runtime, strict=True)
        runtime_id = effective_agent_runtime(requested_runtime, llm, strict=True, workflow=workflow.get("name"))
        config = {
            "recursionLimit": workflow.get("recursionLimit") or 24,
            "tags": workflow.get("tags") or [],
            **invoke_config,
        }
        deep_agent_invoke = None
        if runtime_id == "deepagent":
            from .mcp import load_mcp_tools

            extra_tools = await load_mcp_tools(workflow.get("mcp"), ctx)
            built = build_agent(
                workflow, llm, backend=backend, skill_paths=skill_paths, root_dir=root_dir, ctx=ctx, extra_tools=extra_tools, env=env
            )
            agent = built["agent"]

            async def deep_agent_invoke(prompt, traced_config):
                # The runtime wrapper owns the LangSmith root run id; drop it so the
                # nested LangGraph invocation does not create a duplicate run.
                child_config = {k: v for k, v in (traced_config or {}).items() if k != "runId"}
                return await agent.ainvoke({"messages": [{"role": "user", "content": prompt}]}, child_config or None)

        return await execute_agent_runtime(
            {
                "runtime": requested_runtime,
                "workflowPattern": workflow_pattern,
                "prompt": user_message,
                "workflow": workflow.get("name"),
                "llm": llm,
                "rootDir": root_dir,
                "backendKind": workflow.get("backend"),
                "systemPrompt": workflow.get("systemPrompt"),
                "maxTurns": workflow.get("recursionLimit") or 24,
                "ctx": ctx,
                "env": env,
                "invokeConfig": config,
                "tags": workflow.get("tags") or [],
                "deepAgentInvoke": deep_agent_invoke,
                "lastText": last_text,
            }
        )
    finally:
        if scratch:
            scratch["cleanup"]()


def content_to_text(content):
    """Normalize message content (string or content-block list) to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, str):
                parts.append(c)
            elif isinstance(c, dict):
                parts.append(c.get("text") or "")
            else:
                parts.append(getattr(c, "text", "") or "")
        return "".join(parts)
    return ""


def message_text(msg):
    """Text of a chat message, tolerant of reasoning models."""
    if not msg:
        return ""
    content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
    primary = content_to_text(content)
    if primary and primary.strip():
        return primary
    ak = (msg.get("additional_kwargs") if isinstance(msg, dict) else getattr(msg, "additional_kwargs", None)) or {}
    return content_to_text(ak.get("reasoning_content") or ak.get("reasoning") or "")


def last_text(result):
    messages = (result or {}).get("messages") if isinstance(result, dict) else getattr(result, "messages", None)
    messages = messages or []
    return message_text(messages[-1]) if messages else ""
