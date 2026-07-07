"""Local Docker sandbox for Open SWE — run the coding agent in a container on your
own machine (a local sandbox environment) instead of a cloud sandbox.

Open SWE (langchain-ai/open-swe) is a Python LangGraph server whose sandbox
provider is pluggable via `SANDBOX_FACTORIES` in `agent/utils/sandbox.py`. Its
built-in `local` backend runs commands directly on the HOST with no isolation.
This module adds an isolated **local Docker** sandbox: each run gets its own
container, so the agent's shell commands cannot touch your host filesystem.

## Install (in your Open SWE checkout)

1. Copy this file to `agent/integrations/local_docker.py` in your Open SWE repo.
2. `uv pip install docker`  (the docker-py SDK).
3. Register the factory in `agent/utils/sandbox.py`:

       SANDBOX_FACTORIES["local_docker"] = (
           "agent.integrations.local_docker", "create_local_docker_sandbox"
       )

4. Run Open SWE with:

       SANDBOX_TYPE=local_docker \\
       LOCAL_DOCKER_IMAGE=ghcr.io/langchain-ai/open-swe-sandbox:latest \\
       make dev

   (Any image with git + the toolchains your repos need works; a plain
   `python:3.12` or `node:20` image is fine for many projects.)

Then point tech-symphony at this server:  CODER_BACKEND=openswe,
OPENSWE_URL=http://localhost:2024, OPENSWE_REPO=owner/name.
"""

from __future__ import annotations

import os
import shlex

try:
    import docker  # docker-py
except ImportError as exc:  # pragma: no cover - import guard
    raise ImportError("local_docker sandbox needs docker-py: `uv pip install docker`") from exc

from deepagents.backends.sandbox import BaseSandbox
from deepagents.backends.protocol import ExecuteResponse


DEFAULT_IMAGE = os.getenv("LOCAL_DOCKER_IMAGE", "python:3.12-slim")
WORKDIR = os.getenv("LOCAL_DOCKER_WORKDIR", "/workspace")
COMMAND_TIMEOUT = int(os.getenv("LOCAL_DOCKER_TIMEOUT", "600"))
MAX_OUTPUT = int(os.getenv("LOCAL_DOCKER_MAX_OUTPUT", "100000"))


class LocalDockerSandbox(BaseSandbox):
    """A SandboxBackendProtocol backed by a local Docker container.

    BaseSandbox implements every filesystem op (ls/read/write/edit/glob/grep) on
    top of `execute()`, so we only implement shell execution + `id`. Commands run
    as `sh -lc <command>` inside the container's WORKDIR.
    """

    def __init__(self, container):
        self._container = container

    @property
    def id(self) -> str:
        return self._container.id

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        # Run through a login shell so PATH/tooling resolves like an interactive session.
        wrapped = f"cd {shlex.quote(WORKDIR)} && ({command})"
        result = self._container.exec_run(
            ["sh", "-lc", wrapped],
            workdir=WORKDIR,
            demux=False,
        )
        output = (result.output or b"").decode("utf-8", "replace")
        truncated = len(output) > MAX_OUTPUT
        if truncated:
            output = output[:MAX_OUTPUT] + "\n…[output truncated]"
        return ExecuteResponse(output=output, exit_code=result.exit_code, truncated=truncated)

    def close(self) -> None:
        try:
            self._container.remove(force=True)
        except Exception:  # pragma: no cover - best-effort cleanup
            pass


def create_local_docker_sandbox(sandbox_id: str | None = None) -> LocalDockerSandbox:
    """Factory registered in SANDBOX_FACTORIES. Starts a fresh container per run."""
    client = docker.from_env()
    container = client.containers.run(
        DEFAULT_IMAGE,
        command="sleep infinity",  # keep alive; the agent drives it via exec_run
        detach=True,
        working_dir=WORKDIR,
        # Isolated by default: no host mounts, no host network. Add mounts here only
        # if a run legitimately needs host paths.
        network_mode=os.getenv("LOCAL_DOCKER_NETWORK", "bridge"),
        tty=False,
    )
    container.exec_run(["mkdir", "-p", WORKDIR])
    return LocalDockerSandbox(container)
