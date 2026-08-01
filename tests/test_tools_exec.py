"""Port of packages/shared/src/agent/tools/exec.test.js."""

from __future__ import annotations

import os
import sys

import pytest

from ai_fleet.agent.tools.exec import (
    command_exists,
    redact_secrets,
    resolve_workdir,
    run_command,
    run_sequence,
    sanitized_tool_env,
    truncate,
)


def test_sanitized_tool_env_strips_credentials_but_keeps_toolchain_vars():
    # Arrange
    base = {
        "PATH": "/usr/bin",
        "HOME": "/home/dev",
        "ANDROID_HOME": "/opt/android",
        "GH_TOKEN": "ghp_deadbeefdeadbeefdeadbeef",
        "MY_SECRET": "shhh-super-secret",
        "DB_PASSWORD": "hunter2hunter2",
        "OPENAI_API_KEY": "sk-abc123abc123abc123",
    }

    # Act
    result = sanitized_tool_env(base)
    env, secrets = result["env"], result["secrets"]

    # Assert
    assert env["PATH"] == "/usr/bin"
    assert env["HOME"] == "/home/dev"
    assert env["ANDROID_HOME"] == "/opt/android"
    assert "GH_TOKEN" not in env
    assert "MY_SECRET" not in env
    assert "DB_PASSWORD" not in env
    assert "OPENAI_API_KEY" not in env
    assert env["GIT_TERMINAL_PROMPT"] == "0"  # non-interactive flag forced on
    assert "ghp_deadbeefdeadbeefdeadbeef" in secrets
    assert "hunter2hunter2" in secrets


def test_redact_secrets_blanks_known_values_and_token_patterns():
    # Arrange
    secret = "my-literal-token-value"
    text = f"using {secret}\nAuthorization: Bearer abcdef1234567890\ntoken ghp_0123456789abcdef0123"

    # Act
    out = redact_secrets(text, [secret])

    # Assert
    assert "my-literal-token-value" not in out
    assert "ghp_0123456789abcdef0123" not in out
    assert "«redacted»" in out


def test_truncate_keeps_head_and_tail_with_marker():
    # Arrange
    text = "x" * 1000

    # Act
    out = truncate(text, 100)

    # Assert
    assert len(out) < len(text)
    assert "[truncated" in out and "chars]" in out


def test_resolve_workdir_confines_to_workspace_and_refuses_traversal():
    # Arrange
    ctx = {"cwd": "/work/space"}

    # Act + Assert
    assert resolve_workdir(ctx) == os.path.abspath("/work/space")
    assert resolve_workdir(ctx, "sub/dir") == os.path.abspath("/work/space/sub/dir")
    with pytest.raises(Exception, match="outside the workspace"):
        resolve_workdir(ctx, "../escape")
    with pytest.raises(Exception, match="outside the workspace"):
        resolve_workdir(ctx, "/etc/passwd")


async def test_run_command_rejects_non_array_and_null_byte_args():
    with pytest.raises(Exception, match="array of strings"):
        await run_command("node", "not-an-array")
    with pytest.raises(Exception, match="null bytes"):
        await run_command("node", ["ok", "bad\0null"])


async def test_run_command_reports_missing_binary_as_not_found():
    # Act
    result = await run_command("definitely-not-a-real-binary-xyz", ["--version"])

    # Assert
    assert result["ok"] is False
    assert result["notFound"] is True


async def test_run_command_captures_non_zero_exit_without_throwing():
    # Act
    result = await run_command(sys.executable, ["-c", "import sys; sys.exit(3)"])

    # Assert
    assert result["ok"] is False
    assert result["code"] == 3
    assert result["notFound"] is False


async def test_command_exists_true_for_python_false_for_missing():
    assert await command_exists(sys.executable) is True
    assert await command_exists("definitely-not-a-real-binary-xyz") is False


async def test_run_sequence_stops_at_first_failing_step():
    # Arrange
    steps = [
        {"label": "ok", "command": sys.executable, "args": ["-c", "print('first')"]},
        {"label": "boom", "command": sys.executable, "args": ["-c", "import sys; sys.exit(2)"]},
        {"label": "never", "command": sys.executable, "args": ["-c", "print('third')"]},
    ]

    # Act
    result = await run_sequence(ctx={"cwd": os.getcwd()}, steps=steps)

    # Assert
    assert result["ok"] is False
    assert "first" in result["output"]
    assert "third" not in result["output"]
