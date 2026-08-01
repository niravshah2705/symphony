"""Dev/prod convenience runner (port of scripts/start-all.js).

Boot all three AI Fleet services as separate child processes from a single
terminal, with prefixed output and coordinated shutdown. In a real microservice
deployment each service runs in its own container; this just makes local startup
behave like the old monolith. Env (PORT, PLANNER_PORT, CODER_SERVICE_PORT, …) is
inherited by every child, so a single repo-root .env configures the whole fleet.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading

# Start the agent services first so the gateway's proxy targets are likely up by
# the time the first browser request arrives (connections are lazy anyway).
SERVICES = [
    ("planner", "ai_fleet.services.planner.app"),
    ("coder", "ai_fleet.services.coder.app"),
    ("gateway", "ai_fleet.services.gateway.app"),
]

_children: list[tuple[str, subprocess.Popen]] = []
_shutting_down = False


def _pump(stream, name, sink):
    for line in iter(stream.readline, ""):
        sink.write(f"[{name}] {line.rstrip(os.linesep)}\n")
        sink.flush()


def _start_service(name: str, module: str):
    child = subprocess.Popen(
        [sys.executable, "-m", module],
        cwd=str(__import__("ai_fleet.config", fromlist=["REPO_ROOT"]).REPO_ROOT),
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    threading.Thread(target=_pump, args=(child.stdout, name, sys.stdout), daemon=True).start()
    threading.Thread(target=_pump, args=(child.stderr, name, sys.stderr), daemon=True).start()
    threading.Thread(target=_watch_exit, args=(name, child), daemon=True).start()
    _children.append((name, child))


def _watch_exit(name: str, child: subprocess.Popen):
    code = child.wait()
    if _shutting_down:
        return
    sys.stdout.write(f"[start-all] {name} exited (code={code}); shutting down fleet.\n")
    _shutdown(code or 1)


def _shutdown(exit_code: int):
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True
    for _, child in _children:
        if child.poll() is None:
            child.terminate()
    os._exit(exit_code)


def main():
    signal.signal(signal.SIGINT, lambda *_: _shutdown(0))
    signal.signal(signal.SIGTERM, lambda *_: _shutdown(0))
    for name, module in SERVICES:
        _start_service(name, module)
    sys.stdout.write(f"[start-all] started {', '.join(n for n, _ in SERVICES)}\n")
    sys.stdout.flush()
    for _, child in _children:
        child.wait()


if __name__ == "__main__":
    main()
