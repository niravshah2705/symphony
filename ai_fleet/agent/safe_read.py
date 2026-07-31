"""Guard the deep-agent read_file tool against Anthropic's content-block rules
(port of agent/safe-read.js).

deepagents' read_file decides text-vs-binary purely from a file's extension.
Anything it doesn't recognize as text — extensionless files (Dockerfile,
LICENSE, Makefile), non-PDF binaries (.pptx, .ico, fonts, .lock) or unknown
extensions — becomes ``application/octet-stream`` and is emitted as a base64
``document``/``file`` content block. The Anthropic Messages API then rejects the
whole request, because a base64 ``document`` block's media_type MUST be
``application/pdf``:

    400 invalid_request_error … tool_result.content.0.document.source
    .base64.media_type: Input should be 'application/pdf'

We wrap the backend's ``read()`` so any result that isn't a model-safe type is
downgraded before the tool sees it: text-looking bytes are returned as UTF-8
text, everything else as a short text placeholder. Real PDFs and PNG/JPEG/
GIF/WebP images still pass through as native Anthropic blocks.
"""

from __future__ import annotations

import inspect
import re

# Decode at most this many bytes when treating unknown binary as text.
MAX_TEXT_SNIFF_BYTES = 256 * 1024
# Number of leading bytes inspected to decide text vs binary.
SNIFF_WINDOW = 8192
# Fraction of control characters above which content is treated as binary.
MAX_SUSPICIOUS_RATIO = 0.1
# Image media types the Anthropic Messages API accepts as native image blocks.
MODEL_SAFE_IMAGE = re.compile(r"^image/(png|jpe?g|gif|webp)$")

_INSTALLED_FLAG = "__safeReadInstalled"


def is_model_safe_mime(mime_type) -> bool:
    """Media types the Anthropic Messages API accepts as native content blocks."""
    if not mime_type:
        return False
    if mime_type.startswith("text/"):
        return True
    if mime_type in ("application/json", "application/javascript"):
        return True
    if mime_type == "image/svg+xml":  # deepagents inlines SVG as text
        return True
    if mime_type == "application/pdf":
        return True
    return bool(MODEL_SAFE_IMAGE.match(mime_type))


def _to_bytes(content):
    """Coerce a read() content payload (bytes/bytearray/serialized) to bytes."""
    if content is None:
        return None
    if isinstance(content, (bytes, bytearray)):
        return bytes(content)
    if isinstance(content, memoryview):
        return content.tobytes()
    # A serialized buffer: dict of index->byte, or a sequence of byte ints.
    if isinstance(content, dict):
        try:
            return bytes(int(v) for v in content.values())
        except (TypeError, ValueError):
            return None
    if isinstance(content, (list, tuple)):
        try:
            return bytes(int(v) for v in content)
        except (TypeError, ValueError):
            return None
    return None


def looks_like_text(buf) -> bool:
    """Heuristic: bytes are UTF-8 text when there are no NULs and few control chars."""
    n = min(len(buf), SNIFF_WINDOW)
    if n == 0:
        return True
    suspicious = 0
    for i in range(n):
        b = buf[i]
        if b == 0:
            return False  # NUL byte is a decisive binary marker
        if b < 9 or (13 < b < 32):  # control chars (keep \t \n \v \f \r)
            suspicious += 1
    return suspicious / n < MAX_SUSPICIOUS_RATIO


def _placeholder(file_path, mime_type, size) -> str:
    kind = mime_type or "unknown type"
    return (
        f"[binary file not shown: {file_path} ({kind}, {size} bytes). "
        "Use the shell (e.g. `file`, `xxd`, `strings`) to inspect it if needed.]"
    )


def sanitize_read_result(result, file_path):
    """Normalize a backend read() result so it can never become a non-PDF
    document block. Model-safe results (text, PDF, supported image) pass through
    untouched; text-looking binaries are decoded to UTF-8; the rest become a
    text placeholder.
    """
    if not result or result.get("error"):
        return result
    if is_model_safe_mime(result.get("mimeType")):
        return result

    content = result.get("content")
    # Non-safe mime with string content (e.g. the empty-file warning) — tag text.
    if isinstance(content, str):
        return {**result, "mimeType": "text/plain"}

    buf = _to_bytes(content)
    if buf is None:
        return {
            **result,
            "content": _placeholder(file_path, result.get("mimeType"), 0),
            "mimeType": "text/plain",
        }
    if looks_like_text(buf):
        slice_bytes = buf[:MAX_TEXT_SNIFF_BYTES]
        text = slice_bytes.decode("utf-8", errors="replace")
        omitted = len(buf) - MAX_TEXT_SNIFF_BYTES
        if omitted > 0:
            text = f"{text}\n… [truncated {omitted} more bytes]"
        return {**result, "content": text, "mimeType": "text/plain"}
    return {
        **result,
        "content": _placeholder(file_path, result.get("mimeType"), len(buf)),
        "mimeType": "text/plain",
    }


def install_safe_read(backend):
    """Patch ``backend.read`` in place so the read_file tool only ever receives
    model-safe content. Patching the instance (rather than subclassing) keeps the
    backend's private fields and ``isinstance`` checks intact. Idempotent.

    The wrapped ``read`` is always an async callable; it awaits the original when
    it returns a coroutine/awaitable, supporting both sync and async backends.
    """
    if backend is None:
        return backend
    original = getattr(backend, "read", None)
    if not callable(original):
        return backend
    if getattr(backend, _INSTALLED_FLAG, False):
        return backend

    async def safe_read(file_path, offset=0, limit=500):
        result = original(file_path, offset, limit)
        if inspect.isawaitable(result):
            result = await result
        return sanitize_read_result(result, file_path)

    backend.read = safe_read
    setattr(backend, _INSTALLED_FLAG, True)
    return backend
