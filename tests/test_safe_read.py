"""Port of packages/shared/src/agent/safe-read.test.js."""

from ai_fleet.agent.safe_read import (
    install_safe_read,
    is_model_safe_mime,
    looks_like_text,
    sanitize_read_result,
)


def _bin(arr):
    return bytes(arr)


def test_is_model_safe_mime_accepts_text_json_pdf_and_supported_images_only():
    for m in [
        "text/plain", "text/markdown", "application/json", "application/javascript",
        "image/svg+xml", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp",
    ]:
        assert is_model_safe_mime(m) is True, f"{m} should be safe"
    for m in [
        "application/octet-stream", "image/heic", "image/heif", "audio/mpeg",
        "video/mp4", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "",
    ]:
        assert is_model_safe_mime(m) is False, f"{m} should be unsafe"


def test_looks_like_text_rejects_buffers_with_nul_bytes():
    assert looks_like_text(b"FROM node:20\nRUN echo hi\n") is True
    assert looks_like_text(_bin([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])) is False  # PNG header + NUL


def test_passes_through_text_results_untouched():
    result = {"content": "const x = 1;", "mimeType": "text/plain"}
    assert sanitize_read_result(result, "a.ts") == result


def test_passes_through_pdf_and_supported_image_results_untouched():
    pdf = {"content": _bin([0x25, 0x50, 0x44, 0x46]), "mimeType": "application/pdf"}
    assert sanitize_read_result(pdf, "doc.pdf") is pdf
    png = {"content": _bin([0x89, 0x50, 0x4e, 0x47]), "mimeType": "image/png"}
    assert sanitize_read_result(png, "logo.png") is png


def test_passes_through_error_results_untouched():
    err = {"error": "File 'x' not found"}
    assert sanitize_read_result(err, "x") is err


def test_decodes_text_looking_octet_stream_to_utf8_text():
    # Extensionless file → deepagents returns octet-stream binary.
    content = bytes("FROM node:20-alpine\nWORKDIR /app\nCOPY . .\n", "utf-8")
    result = {"content": content, "mimeType": "application/octet-stream"}

    out = sanitize_read_result(result, "Dockerfile")

    assert out["mimeType"] == "text/plain"
    assert out["content"] == "FROM node:20-alpine\nWORKDIR /app\nCOPY . .\n"


def test_replaces_true_binary_non_pdf_with_a_text_placeholder():
    result = {"content": _bin([0x00, 0x01, 0x02, 0xff, 0xfe]), "mimeType": "image/x-icon"}
    out = sanitize_read_result(result, "favicon.ico")
    assert out["mimeType"] == "text/plain"
    assert "binary file not shown: favicon.ico" in out["content"]
    assert "image/x-icon" in out["content"]


def test_replaces_unsupported_image_type_heic_with_a_placeholder():
    result = {"content": _bin([0x00, 0x00, 0x00, 0x18]), "mimeType": "image/heic"}
    out = sanitize_read_result(result, "photo.heic")
    assert out["mimeType"] == "text/plain"
    assert "binary file not shown" in out["content"]


def test_tags_non_safe_string_content_as_text_plain():
    result = {
        "content": "System reminder: File exists but has empty contents",
        "mimeType": "application/octet-stream",
    }
    out = sanitize_read_result(result, "empty.bin")
    assert out["mimeType"] == "text/plain"
    assert "empty contents" in out["content"]


async def test_install_safe_read_patches_read_idempotently_and_downgrades_binary():
    # A fake backend whose read returns an unsupported binary block.
    class Backend:
        def __init__(self):
            self.calls = 0

        async def read(self, file_path, offset=0, limit=500):
            self.calls += 1
            return {"content": _bin([0x00, 0x01, 0x02]), "mimeType": "application/octet-stream"}

    backend = Backend()
    install_safe_read(backend)
    install_safe_read(backend)  # second call must not double-wrap

    out = await backend.read("mystery.bin", 0, 100)

    assert backend.calls == 1
    assert out["mimeType"] == "text/plain"
    assert "binary file not shown: mystery.bin" in out["content"]
