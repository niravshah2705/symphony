"""Quality tools (port of agent/tools/quality.js).

Lint/format and run tests by delegating to the project's own linters and test
runners (ESLint, Prettier, Ruff, Black, npm test, pytest, Gradle, Go, Cargo,
Maven). Detection is by project files; no runner logic is re-implemented.
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
)


def _any_file(dir, names):
    return any(os.path.exists(os.path.join(dir, n)) for n in names)


async def pick_linter(dir, mode, requested=None):
    """Choose a linter/formatter for a directory."""
    fix = mode == "fix"
    linters = {
        "eslint": {
            "command": platform_cmd("npx"),
            "args": ["--no-install", "eslint", ".", *(["--fix"] if fix else [])],
            "hint": "Add ESLint to the project (npm i -D eslint).",
        },
        "prettier": {
            "command": platform_cmd("npx"),
            "args": ["--no-install", "prettier", "--write" if fix else "--check", "."],
            "hint": "Add Prettier (npm i -D prettier).",
        },
        "ruff": {
            "command": "ruff",
            "args": ["check", "--fix", "."] if fix else ["check", "."],
            "hint": "pip install ruff.",
        },
        "black": {
            "command": "black",
            "args": ["."] if fix else ["--check", "."],
            "hint": "pip install black.",
        },
    }
    if requested and requested != "auto":
        return {"key": requested, **linters[requested]}
    if _any_file(dir, [".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs"]):
        return {"key": "eslint", **linters["eslint"]}
    if _any_file(dir, [".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js"]) or os.path.exists(
        os.path.join(dir, "package.json")
    ):
        return {"key": "prettier", **linters["prettier"]}
    if _any_file(dir, ["pyproject.toml", "ruff.toml", ".ruff.toml"]) and (await command_exists("ruff")):
        return {"key": "ruff", **linters["ruff"]}
    if _any_file(dir, ["pyproject.toml", "setup.py", "requirements.txt"]):
        return {"key": "black", **linters["black"]}
    return {"key": "prettier", **linters["prettier"]}


def pick_test_runner(dir, requested=None):
    """Choose a test runner (pure)."""
    def has(f):
        return os.path.exists(os.path.join(dir, f))

    def read_pkg():
        try:
            with open(os.path.join(dir, "package.json"), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    runners = {
        "npm": lambda: {"command": platform_cmd("npm"), "args": ["test"], "hint": "Install Node.js (bundles npm)."},
        "pytest": lambda: {"command": "pytest", "args": ["-q"], "hint": "pip install pytest."},
        "gradle": lambda: {
            "command": "gradlew.bat" if sys.platform.startswith("win") else "./gradlew",
            "args": ["test"],
            "hint": "Use the Gradle wrapper (gradlew).",
        },
        "maven": lambda: {
            "command": (("mvnw.cmd" if sys.platform.startswith("win") else "./mvnw") if has("mvnw") else "mvn"),
            "args": ["-q", "test"],
            "hint": "Use the Maven wrapper (mvnw) or install Maven.",
        },
        "go": lambda: {"command": "go", "args": ["test", "./..."], "hint": "Install Go."},
        "cargo": lambda: {"command": "cargo", "args": ["test"], "hint": "Install the Rust toolchain (rustup)."},
    }
    if requested and requested != "auto" and requested in runners:
        return {"key": requested, **runners[requested]()}
    pkg = read_pkg()
    if pkg and pkg.get("scripts") and pkg["scripts"].get("test"):
        return {"key": "npm", **runners["npm"]()}
    if has("pytest.ini") or has("tox.ini") or has("pyproject.toml") or has("setup.py"):
        return {"key": "pytest", **runners["pytest"]()}
    if has("gradlew") or has("build.gradle") or has("build.gradle.kts"):
        return {"key": "gradle", **runners["gradle"]()}
    if has("pom.xml"):
        return {"key": "maven", **runners["maven"]()}
    if has("go.mod"):
        return {"key": "go", **runners["go"]()}
    if has("Cargo.toml"):
        return {"key": "cargo", **runners["cargo"]()}
    return None


class _LintFormatSchema(BaseModel):
    dir: Optional[str] = Field(default=None, description="workspace-relative directory")
    mode: Optional[Literal["check", "fix"]] = Field(default=None, description="default: check")
    tool: Optional[Literal["auto", "eslint", "prettier", "ruff", "black"]] = Field(
        default=None, description="force a tool (default: auto)"
    )


class _TestRunSchema(BaseModel):
    dir: Optional[str] = Field(default=None, description="workspace-relative directory")
    system: Optional[Literal["auto", "npm", "pytest", "gradle", "maven", "go", "cargo"]] = Field(
        default=None, description="force a runner (default: auto)"
    )


async def _lint_format(input, ctx):
    dir_ = resolve_workdir(ctx, input.get("dir"))
    mode = input.get("mode") or "check"
    linter = await pick_linter(dir_, mode, input.get("tool"))
    return await exec_tool(
        ctx=ctx,
        label=f"lint/format ({linter['key']}, {mode})",
        command=linter["command"],
        args=linter["args"],
        dir=input.get("dir"),
        not_found_hint=linter["hint"],
    )


async def _test_run(input, ctx):
    dir_ = resolve_workdir(ctx, input.get("dir"))
    runner = pick_test_runner(dir_, input.get("system"))
    if not runner:
        return f"No known test runner detected in {dir_} (looked for npm test / pytest / Gradle / Maven / Go / Cargo)."
    return await exec_tool(
        ctx=ctx,
        label=f"tests ({runner['key']})",
        command=runner["command"],
        args=runner["args"],
        dir=input.get("dir"),
        not_found_hint=runner["hint"],
    )


lint_format_tool = define_tool(
    {
        "name": "lint_format",
        "description": (
            "Lint and/or format the workspace using the project's configured tools (ESLint, Prettier, Ruff, Black). "
            'mode "check" (default) reports issues; mode "fix" applies safe autofixes. Prefer this over manual formatting.'
        ),
        "schema": _LintFormatSchema,
    },
    _lint_format,
)

test_run_tool = define_tool(
    {
        "name": "test_run",
        "description": (
            "Run the project test suite using its native runner (npm test, pytest, Gradle, Maven, Go, Cargo), "
            "auto-detected from the workspace. Prefer this over guessing the test command."
        ),
        "schema": _TestRunSchema,
    },
    _test_run,
)

FACTORIES = {"lint_format": lint_format_tool, "test_run": test_run_tool}
