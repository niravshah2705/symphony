"""Environment tools (port of agent/tools/environments.js).

Create a working local dev environment by delegating to the standard toolchain
managers (uv / python venv, npm / pnpm / yarn, Docker Compose) rather than
hand-rolling setup scripts. Also scaffolds a devcontainer.json so the same setup
is reproducible in a container.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Literal, Optional

from pydantic import BaseModel, Field

from ai_fleet.agent.tools.exec import (
    command_exists,
    define_tool,
    exec_tool,
    platform_cmd,
    resolve_workdir,
    run_sequence,
)


def detect_project_types(dir):
    """Marker-file project detection for a directory (pure, side-effect free)."""
    def has(f):
        return os.path.exists(os.path.join(dir, f))

    return {
        "node": has("package.json"),
        "python": has("requirements.txt") or has("pyproject.toml") or has("Pipfile") or has("setup.py"),
        "go": has("go.mod"),
        "java": has("pom.xml") or has("build.gradle") or has("build.gradle.kts"),
        "compose": has("docker-compose.yml") or has("docker-compose.yaml") or has("compose.yml") or has("compose.yaml"),
        "android": has("gradlew") and (has("settings.gradle") or has("settings.gradle.kts")),
    }


def pick_node_manager(dir):
    """Choose the Node package manager and install command from lockfiles present."""
    def has(f):
        return os.path.exists(os.path.join(dir, f))

    if has("pnpm-lock.yaml"):
        return {"manager": "pnpm", "args": ["install", "--frozen-lockfile"]}
    if has("yarn.lock"):
        return {"manager": "yarn", "args": ["install", "--frozen-lockfile"]}
    if has("package-lock.json") or has("npm-shrinkwrap.json"):
        return {"manager": "npm", "args": ["ci"]}
    return {"manager": "npm", "args": ["install"]}


def pick_python_manager(dir, opts=None):
    """Choose the Python environment manager from the files present."""
    opts = opts or {}
    uv_available = opts.get("uvAvailable", False)

    def has(f):
        return os.path.exists(os.path.join(dir, f))

    if has("poetry.lock"):
        return "poetry"
    if has("Pipfile"):
        return "pipenv"
    if uv_available:
        return "uv"
    return "venv"


def node_install_steps(dir):
    """Build the Node install step list."""
    picked = pick_node_manager(dir)
    manager, args = picked["manager"], picked["args"]
    return [
        {
            "label": f"{manager} install",
            "command": platform_cmd(manager),
            "args": args,
            "notFoundHint": f"Install Node.js (bundles npm) or {manager}.",
        }
    ]


def python_steps(dir, manager):
    """Build the Python environment step list for a chosen manager."""
    def has(f):
        return os.path.exists(os.path.join(dir, f))

    has_req = has("requirements.txt")
    has_project = has("pyproject.toml") or has("setup.py")
    if manager == "poetry":
        return [{"label": "poetry install", "command": "poetry", "args": ["install"], "notFoundHint": "Install Poetry (https://python-poetry.org)."}]
    if manager == "pipenv":
        return [{"label": "pipenv install", "command": "pipenv", "args": ["install", "--dev"], "notFoundHint": "Install pipenv (pip install pipenv)."}]
    if manager == "uv":
        install = (
            {"label": "uv sync", "command": "uv", "args": ["sync"]}
            if has_project
            else {"label": "uv pip install", "command": "uv", "args": ["pip", "install", "-r", "requirements.txt"]}
        )
        return [
            {"label": "uv venv", "command": "uv", "args": ["venv"], "notFoundHint": "Install uv (https://docs.astral.sh/uv)."},
            install,
        ]
    # Plain venv + pip fallback.
    pip = (
        os.path.join(".venv", "Scripts", "pip.exe")
        if sys.platform.startswith("win")
        else os.path.join(".venv", "bin", "pip")
    )
    install = (
        {"label": "pip install -r requirements.txt", "command": pip, "args": ["install", "-r", "requirements.txt"]}
        if has_req
        else {"label": "pip install -e .", "command": pip, "args": ["install", "-e", "."]}
    )
    steps = [
        {"label": "python -m venv .venv", "command": platform_cmd("python3"), "args": ["-m", "venv", ".venv"], "notFoundHint": "Install Python 3."},
    ]
    if has_req or has_project:
        steps.append(install)
    return steps


def render_devcontainer(spec=None):
    """Render a devcontainer.json for a language preset."""
    spec = spec or {}
    language = str(spec.get("language") or "generic").lower()
    presets = {
        "node": {"name": "node-dev", "image": "mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm", "postCreateCommand": "npm ci", "remoteUser": "node"},
        "python": {"name": "python-dev", "image": "mcr.microsoft.com/devcontainers/python:1-3.12-bookworm", "postCreateCommand": "pip install --user -r requirements.txt", "remoteUser": "vscode"},
        "go": {"name": "go-dev", "image": "mcr.microsoft.com/devcontainers/go:1-1.23-bookworm", "postCreateCommand": "go mod download", "remoteUser": "vscode"},
        "java": {"name": "java-dev", "image": "mcr.microsoft.com/devcontainers/java:1-21-bookworm", "postCreateCommand": "./gradlew build -x test || mvn -q -DskipTests package", "remoteUser": "vscode"},
        "generic": {"name": "dev", "image": "mcr.microsoft.com/devcontainers/base:bookworm", "remoteUser": "vscode"},
    }
    config = dict(presets.get(language, presets["generic"]))
    if spec.get("port"):
        config["forwardPorts"] = [spec["port"]]
    return f"{json.dumps(config, indent=2)}\n"


# ---- Schemas --------------------------------------------------------------


class _SetupPythonEnvSchema(BaseModel):
    dir: Optional[str] = Field(default=None, description="workspace-relative project directory")
    manager: Optional[Literal["auto", "uv", "poetry", "pipenv", "venv"]] = Field(default=None, description="force a manager (default: auto)")


class _SetupNodeEnvSchema(BaseModel):
    dir: Optional[str] = Field(default=None, description="workspace-relative project directory")


class _SetupLocalEnvSchema(BaseModel):
    dir: Optional[str] = Field(default=None, description="workspace-relative project directory")
    startServices: Optional[bool] = Field(default=None, description="if a compose file exists, run `docker compose up -d`")


class _DevcontainerGenerateSchema(BaseModel):
    language: Literal["node", "python", "go", "java", "generic"] = Field(description="runtime preset")
    port: Optional[int] = Field(default=None, description="port to forward")
    dir: Optional[str] = Field(default=None, description="workspace-relative directory (default: root)")


# ---- Tool handlers --------------------------------------------------------


async def _setup_python_env(input, ctx):
    dir_ = resolve_workdir(ctx, input.get("dir"))
    requested = input.get("manager") if input.get("manager") and input.get("manager") != "auto" else None
    manager = requested or pick_python_manager(dir_, {"uvAvailable": await command_exists("uv")})
    result = await run_sequence(ctx=ctx, dir=input.get("dir"), steps=python_steps(dir_, manager))
    return f"Python environment ({manager}) in {dir_}\n\n{result['output']}"


async def _setup_node_env(input, ctx):
    dir_ = resolve_workdir(ctx, input.get("dir"))
    nvmrc = os.path.join(dir_, ".nvmrc")
    note = ""
    if os.path.exists(nvmrc):
        with open(nvmrc, "r", encoding="utf-8") as f:
            want = f.read().strip()
        note = f"\nℹ️ .nvmrc requests Node {want}; ensure your shell selected it (nvm/fnm use) before relying on this."
    result = await run_sequence(ctx=ctx, dir=input.get("dir"), steps=node_install_steps(dir_))
    return f"Node environment in {dir_}{note}\n\n{result['output']}"


async def _setup_local_env(input, ctx):
    dir_ = resolve_workdir(ctx, input.get("dir"))
    types = detect_project_types(dir_)
    steps = [
        *(node_install_steps(dir_) if types["node"] else []),
        *(python_steps(dir_, pick_python_manager(dir_, {"uvAvailable": await command_exists("uv")})) if types["python"] else []),
        *([{"label": "go mod download", "command": "go", "args": ["mod", "download"], "notFoundHint": "Install Go."}] if types["go"] else []),
    ]
    detected = ", ".join(k for k, v in types.items() if v) or "none"
    if not steps and not (input.get("startServices") and types["compose"]):
        return f"No Node/Python/Go project detected in {dir_} (found: {detected}). Nothing to install."
    if steps:
        result = await run_sequence(ctx=ctx, dir=input.get("dir"), steps=steps)
        ok, output = result["ok"], result["output"]
    else:
        ok, output = True, "(no dependency install steps)"
    compose_out = ""
    if ok and input.get("startServices") and types["compose"]:
        compose_result = await exec_tool(
            ctx=ctx,
            label="docker compose up",
            command="docker",
            args=["compose", "up", "-d"],
            dir=input.get("dir"),
            not_found_hint="Install Docker Desktop.",
        )
        compose_out = f"\n\n{compose_result}"
    return f"Local environment in {dir_} (detected: {detected})\n\n{output}{compose_out}"


async def _devcontainer_generate(input, ctx):
    dir_ = resolve_workdir(ctx, input.get("dir"))
    target = os.path.join(dir_, ".devcontainer")
    os.makedirs(target, exist_ok=True)
    json_out = render_devcontainer(input)
    with open(os.path.join(target, "devcontainer.json"), "w", encoding="utf-8") as f:
        f.write(json_out)
    return f"✅ Wrote {os.path.join(target, 'devcontainer.json')}\n\n{json_out}"


setup_python_env_tool = define_tool(
    {
        "name": "setup_python_env",
        "description": (
            "Create a Python virtual environment and install dependencies using the best available manager "
            "(uv, Poetry, Pipenv, or python -m venv + pip), auto-detected from the project files. "
            "Prefer this over manual venv commands."
        ),
        "schema": _SetupPythonEnvSchema,
    },
    _setup_python_env,
)

setup_node_env_tool = define_tool(
    {
        "name": "setup_node_env",
        "description": (
            "Install Node.js dependencies using the detected package manager (npm ci / pnpm / yarn, chosen from the "
            "lockfile). Reports the active Node version and any .nvmrc mismatch. Prefer this over manual install commands."
        ),
        "schema": _SetupNodeEnvSchema,
    },
    _setup_node_env,
)

setup_local_env_tool = define_tool(
    {
        "name": "setup_local_env",
        "description": (
            "Detect the project type(s) in the workspace and set up a complete local dev environment: install Node "
            "and/or Python dependencies, and (optionally) start Docker Compose services. One call to bootstrap a repo."
        ),
        "schema": _SetupLocalEnvSchema,
    },
    _setup_local_env,
)

devcontainer_generate_tool = define_tool(
    {
        "name": "devcontainer_generate",
        "description": "Scaffold a .devcontainer/devcontainer.json (pinned image, non-root remote user) for a language preset.",
        "schema": _DevcontainerGenerateSchema,
    },
    _devcontainer_generate,
)

FACTORIES = {
    "setup_python_env": setup_python_env_tool,
    "setup_node_env": setup_node_env_tool,
    "setup_local_env": setup_local_env_tool,
    "devcontainer_generate": devcontainer_generate_tool,
}
