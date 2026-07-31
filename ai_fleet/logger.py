"""Dead-simple logger (port of packages/shared/src/logger.js).

Writes timestamped lines to stdout AND appends them to data/app.log so
``tail -f data/app.log`` shows every step. No external deps; never throws.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .config import CONFIG

LOG_FILE = CONFIG.LOG_FILE


def _ensure_dir() -> None:
    Path(CONFIG.DATA_DIR).mkdir(parents=True, exist_ok=True)


def _iso_now() -> str:
    # Match JS new Date().toISOString(): milliseconds + trailing Z.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def _write(level: str, message: str) -> str:
    ts = _iso_now()
    text = f"[{ts}] {level.upper():<5} {message}"
    print(text, flush=True)
    try:
        _ensure_dir()
        with open(CONFIG.LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(f"{text}\n")
    except Exception:
        pass  # logging must never throw
    return text


def info(message: str) -> str:
    return _write("info", message)


def warn(message: str) -> str:
    return _write("warn", message)


def error(message: str) -> str:
    return _write("error", message)
