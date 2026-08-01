"""Port of packages/shared/src/agent/tools/build.test.js."""

from __future__ import annotations

import json
import os
import shutil
import tempfile

from ai_fleet.agent.tools.build import build_systems_for
from ai_fleet.agent.tools.quality import pick_test_runner


def scratch(files):
    dir = tempfile.mkdtemp(prefix="tools-build-")
    for name, content in files.items():
        with open(os.path.join(dir, name), "w", encoding="utf-8") as f:
            f.write(content or "")
    return dir


def test_build_systems_for_detects_gradle_go_and_cargo():
    gradle = scratch({"build.gradle": ""})
    go = scratch({"go.mod": "module x"})
    cargo = scratch({"Cargo.toml": ""})
    try:
        assert build_systems_for(gradle)[0]["system"] == "gradle"
        assert build_systems_for(go)[0]["system"] == "go"
        assert build_systems_for(cargo)[0]["system"] == "cargo"
    finally:
        for d in (gradle, go, cargo):
            shutil.rmtree(d, ignore_errors=True)


def test_build_systems_for_only_surfaces_npm_when_build_script_exists():
    with_build = scratch({"package.json": json.dumps({"scripts": {"build": "tsc"}})})
    without_build = scratch({"package.json": json.dumps({"scripts": {"start": "node ."}})})
    try:
        assert any(s["system"] == "npm" for s in build_systems_for(with_build))
        assert not any(s["system"] == "npm" for s in build_systems_for(without_build))
    finally:
        for d in (with_build, without_build):
            shutil.rmtree(d, ignore_errors=True)


def test_pick_test_runner_prefers_npm_else_falls_back_to_language_runners():
    npm = scratch({"package.json": json.dumps({"scripts": {"test": "jest"}})})
    go = scratch({"go.mod": "module x"})
    none = scratch({"README.md": ""})
    try:
        assert pick_test_runner(npm)["key"] == "npm"
        assert pick_test_runner(go)["key"] == "go"
        assert pick_test_runner(none) is None
    finally:
        for d in (npm, go, none):
            shutil.rmtree(d, ignore_errors=True)
