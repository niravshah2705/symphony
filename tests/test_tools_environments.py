"""Port of packages/shared/src/agent/tools/environments.test.js."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile

from ai_fleet.agent.tools.environments import (
    detect_project_types,
    pick_node_manager,
    pick_python_manager,
    render_devcontainer,
)


def scratch(files):
    dir = tempfile.mkdtemp(prefix="tools-env-")
    for name, content in files.items():
        with open(os.path.join(dir, name), "w", encoding="utf-8") as f:
            f.write(content or "")
    return dir


def test_detect_project_types_recognises_node_python_and_compose_markers():
    dir = scratch({"package.json": "{}", "requirements.txt": "", "docker-compose.yml": ""})
    try:
        types = detect_project_types(dir)
        assert types["node"] is True
        assert types["python"] is True
        assert types["compose"] is True
        assert types["go"] is False
    finally:
        shutil.rmtree(dir, ignore_errors=True)


def test_pick_node_manager_selects_the_manager_from_the_lockfile():
    pnpm = scratch({"pnpm-lock.yaml": ""})
    yarn = scratch({"yarn.lock": ""})
    npm = scratch({"package-lock.json": ""})
    bare = scratch({"package.json": "{}"})
    try:
        assert pick_node_manager(pnpm)["manager"] == "pnpm"
        assert pick_node_manager(yarn)["manager"] == "yarn"
        assert pick_node_manager(npm) == {"manager": "npm", "args": ["ci"]}
        assert pick_node_manager(bare) == {"manager": "npm", "args": ["install"]}
    finally:
        for d in (pnpm, yarn, npm, bare):
            shutil.rmtree(d, ignore_errors=True)


def test_pick_python_manager_prefers_lockfile_managers_then_uv_then_venv():
    poetry = scratch({"poetry.lock": ""})
    pipenv = scratch({"Pipfile": ""})
    plain = scratch({"requirements.txt": ""})
    try:
        assert pick_python_manager(poetry) == "poetry"
        assert pick_python_manager(pipenv) == "pipenv"
        assert pick_python_manager(plain, {"uvAvailable": True}) == "uv"
        assert pick_python_manager(plain, {"uvAvailable": False}) == "venv"
    finally:
        for d in (poetry, pipenv, plain):
            shutil.rmtree(d, ignore_errors=True)


def test_render_devcontainer_emits_pinned_image_and_non_root_remote_user():
    config = json.loads(render_devcontainer({"language": "node", "port": 3000}))
    assert re.search(r"devcontainers/javascript-node", config["image"])
    assert config["remoteUser"] == "node"
    assert config["forwardPorts"] == [3000]
