"""Port of packages/shared/src/agent/tools/docker.test.js."""

from __future__ import annotations

import os
import re
import shutil
import tempfile

import pytest

from ai_fleet.agent.tools.docker import (
    FACTORIES,
    assert_image,
    assert_safe_volume,
    build_arg_pairs,
    port_args,
    render_dockerfile,
    render_dockerignore,
)


def test_render_dockerfile_produces_a_hardened_image_for_every_preset():
    for language in ["node", "python", "go", "java", "generic"]:
        df = render_dockerfile({"language": language})
        assert re.search(r"^FROM ", df, re.MULTILINE), f"{language} has FROM"
        assert not re.search(r"FROM \S+:latest", df), f"{language} does not use :latest"
        assert re.search(r"USER ", df), f"{language} sets a non-root USER"


def test_render_dockerignore_excludes_secrets_and_vcs_metadata():
    ignore = render_dockerignore()
    lines = ignore.split("\n")
    for entry in [".git", ".env", "*.pem", "*.key", ".ssh", "node_modules"]:
        assert entry in lines, f"ignores {entry}"


def test_assert_image_accepts_valid_refs_and_rejects_flag_like_input():
    assert assert_image("myapp:1.2.3") == "myapp:1.2.3"
    assert assert_image("ghcr.io/org/app@sha256:abc") == "ghcr.io/org/app@sha256:abc"
    with pytest.raises(Exception, match="invalid image"):
        assert_image("--privileged")
    with pytest.raises(Exception, match="invalid image"):
        assert_image("a b")


def test_assert_safe_volume_refuses_docker_socket_and_host_escapes():
    base = "/work/space"
    assert assert_safe_volume("data:/data", base) == "data:/data"
    assert assert_safe_volume("/work/space/sub:/app", base) == "/work/space/sub:/app"
    with pytest.raises(Exception, match="Docker socket"):
        assert_safe_volume("/var/run/docker.sock:/var/run/docker.sock", base)
    with pytest.raises(Exception, match="outside the workspace"):
        assert_safe_volume("/etc:/etc", base)


def test_build_arg_pairs_refuses_secret_looking_build_args():
    assert build_arg_pairs({"NODE_ENV": "production"}) == ["--build-arg", "NODE_ENV=production"]
    with pytest.raises(Exception, match="secret-looking build-arg"):
        build_arg_pairs({"NPM_TOKEN": "x"})
    with pytest.raises(Exception, match="secret-looking build-arg"):
        build_arg_pairs({"AWS_SECRET_ACCESS_KEY": "x"})


def test_port_args_validates_port_mappings():
    assert port_args(["8080:80", "443"]) == ["-p", "8080:80", "-p", "443"]
    with pytest.raises(Exception, match="invalid port"):
        port_args(["8080; rm -rf /"])


async def test_dockerfile_generate_writes_a_dockerfile_and_dockerignore():
    # Arrange
    dir = tempfile.mkdtemp(prefix="tools-docker-")
    try:
        tool = FACTORIES["dockerfile_generate"]({"cwd": dir, "step": lambda *a, **k: None})

        # Act
        out = await tool.ainvoke({"language": "node"})

        # Assert
        assert "Wrote hardened Dockerfile" in out
        assert os.path.exists(os.path.join(dir, "Dockerfile"))
        assert os.path.exists(os.path.join(dir, ".dockerignore"))
        with open(os.path.join(dir, "Dockerfile"), "r", encoding="utf-8") as f:
            assert "USER node" in f.read()
    finally:
        shutil.rmtree(dir, ignore_errors=True)


async def test_dockerfile_generate_refuses_to_write_outside_the_workspace():
    dir = tempfile.mkdtemp(prefix="tools-docker-esc-")
    try:
        tool = FACTORIES["dockerfile_generate"]({"cwd": dir, "step": lambda *a, **k: None})
        out = await tool.ainvoke({"language": "node", "dir": "../../etc"})
        assert re.search(r"failed: .*outside the workspace", out)
    finally:
        shutil.rmtree(dir, ignore_errors=True)
