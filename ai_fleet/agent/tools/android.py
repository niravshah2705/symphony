"""Android tool (port of agent/tools/android.js).

Build an Android project through its Gradle wrapper. Delegates to ``./gradlew``;
no Android build logic is re-implemented. Requires a local JDK + Android SDK
(ANDROID_HOME/ANDROID_SDK_ROOT), which the wrapper resolves.
"""

from __future__ import annotations

import os
import re
import sys
from typing import Literal, Optional

from pydantic import BaseModel, Field

from ai_fleet.agent.tools.exec import define_tool, exec_tool, resolve_workdir

GRADLE_TASKS = {
    "debug": "assembleDebug",
    "release": "assembleRelease",
    "bundle": "bundleRelease",
    "lint": "lint",
    "test": "testDebugUnitTest",
}


def gradlew_cmd():
    return "gradlew.bat" if sys.platform.startswith("win") else "./gradlew"


def sanitize_module(name):
    v = re.sub(r"^:", "", str(name or "").strip())
    if not re.match(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$", v):
        raise Exception(f'invalid Gradle module: "{name}"')
    return v


class _AndroidBuildSchema(BaseModel):
    variant: Optional[Literal["debug", "release", "bundle", "lint", "test"]] = Field(
        default=None, description="build variant (default: debug)"
    )
    module: Optional[str] = Field(default=None, description='Gradle module to scope the task to, e.g. "app"')
    dir: Optional[str] = Field(default=None, description="workspace-relative project directory (must contain gradlew)")


async def _android_build(input, ctx):
    dir_ = resolve_workdir(ctx, input.get("dir"))
    if not os.path.exists(os.path.join(dir_, "gradlew")) and not sys.platform.startswith("win"):
        return f"❌ android_build: no Gradle wrapper (gradlew) in {dir_}. Run from the Android project root."
    variant = input.get("variant") or "debug"
    task = GRADLE_TASKS[variant]
    gradle_task = f":{sanitize_module(input['module'])}:{task}" if input.get("module") else task
    return await exec_tool(
        ctx=ctx,
        label=f"android {variant}",
        command=gradlew_cmd(),
        args=[gradle_task, "--stacktrace"],
        dir=input.get("dir"),
        not_found_hint="Ensure the Gradle wrapper is present and a JDK + Android SDK (ANDROID_HOME) are installed.",
    )


android_build_tool = define_tool(
    {
        "name": "android_build",
        "description": (
            "Build an Android project via its Gradle wrapper. `variant` maps to a Gradle task: debug→assembleDebug, "
            "release→assembleRelease, bundle→bundleRelease, lint→lint, test→testDebugUnitTest. Requires a JDK + Android SDK."
        ),
        "schema": _AndroidBuildSchema,
    },
    _android_build,
)

FACTORIES = {"android_build": android_build_tool}
