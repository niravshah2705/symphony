"""Build tool (port of agent/tools/build.js).

Compile/build a project by delegating to its native build system (Gradle,
Maven, npm scripts, Make, Cargo, Go, Python build), auto-detected from the
project files. No build logic is re-implemented here.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Literal, Optional

from pydantic import BaseModel, Field

from ai_fleet.agent.tools.exec import define_tool, exec_tool, platform_cmd, resolve_workdir


def read_json(file):
    try:
        with open(file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def gradle_cmd():
    return "gradlew.bat" if sys.platform.startswith("win") else "./gradlew"


def build_systems_for(dir):
    """Detect candidate build systems in priority order (pure)."""
    def has(f):
        return os.path.exists(os.path.join(dir, f))

    out = []
    if has("gradlew") or has("build.gradle") or has("build.gradle.kts"):
        out.append(
            {
                "system": "gradle",
                "command": gradle_cmd() if has("gradlew") else "gradle",
                "args": ["assemble"],
                "notFoundHint": "Use the Gradle wrapper (gradlew) or install Gradle.",
            }
        )
    if has("pom.xml"):
        out.append(
            {
                "system": "maven",
                "command": (("mvnw.cmd" if sys.platform.startswith("win") else "./mvnw") if has("mvnw") else "mvn"),
                "args": ["-q", "-DskipTests", "package"],
                "notFoundHint": "Use the Maven wrapper (mvnw) or install Maven.",
            }
        )
    pkg = read_json(os.path.join(dir, "package.json"))
    if pkg and pkg.get("scripts") and pkg["scripts"].get("build"):
        out.append(
            {
                "system": "npm",
                "command": platform_cmd("npm"),
                "args": ["run", "build"],
                "notFoundHint": "Install Node.js (bundles npm).",
            }
        )
    if has("Cargo.toml"):
        out.append({"system": "cargo", "command": "cargo", "args": ["build", "--release"], "notFoundHint": "Install the Rust toolchain (rustup)."})
    if has("go.mod"):
        out.append({"system": "go", "command": "go", "args": ["build", "./..."], "notFoundHint": "Install Go."})
    if has("Makefile") or has("makefile"):
        out.append({"system": "make", "command": "make", "args": [], "notFoundHint": "Install make (build-essential / Xcode CLT)."})
    if has("pyproject.toml") or has("setup.py"):
        out.append({"system": "python", "command": platform_cmd("python3"), "args": ["-m", "build"], "notFoundHint": "pip install build."})
    return out


class _ProjectBuildSchema(BaseModel):
    dir: Optional[str] = Field(default=None, description="workspace-relative project directory")
    system: Optional[Literal["auto", "gradle", "maven", "npm", "cargo", "go", "make", "python"]] = Field(
        default=None, description="force a build system (default: auto)"
    )


async def _project_build(input, ctx):
    dir_ = resolve_workdir(ctx, input.get("dir"))
    candidates = build_systems_for(dir_)
    if not candidates:
        return f"No known build system detected in {dir_} (looked for Gradle/Maven/npm build script/Cargo/Go/Make/Python)."
    system = input.get("system")
    if system and system != "auto":
        chosen = next((c for c in candidates if c["system"] == system), None)
    else:
        chosen = candidates[0]
    if not chosen:
        detected = ", ".join(c["system"] for c in candidates)
        return f'Build system "{system}" not detected in {dir_}. Detected: {detected}.'
    return await exec_tool(
        ctx=ctx,
        label=f"build ({chosen['system']})",
        command=chosen["command"],
        args=chosen["args"],
        dir=input.get("dir"),
        not_found_hint=chosen.get("notFoundHint"),
    )


project_build_tool = define_tool(
    {
        "name": "project_build",
        "description": (
            "Build the project using its native build system (Gradle/Maven/npm/Make/Cargo/Go/Python), auto-detected "
            "from the workspace. Prefer this over guessing build commands. Pass `system` to force one when several exist."
        ),
        "schema": _ProjectBuildSchema,
    },
    _project_build,
)

FACTORIES = {"project_build": project_build_tool}
