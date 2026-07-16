'use strict';

/**
 * Guard the deep-agent read_file tool against Anthropic's content-block rules.
 *
 * deepagents' read_file decides text-vs-binary purely from a file's extension.
 * Anything it doesn't recognize as text — extensionless files (Dockerfile,
 * LICENSE, Makefile), non-PDF binaries (.pptx, .ico, fonts, .lock) or unknown
 * extensions — becomes `application/octet-stream` and is emitted as a base64
 * `document`/`file` content block. The Anthropic Messages API then rejects the
 * whole request, because a base64 `document` block's media_type MUST be
 * `application/pdf`:
 *
 *   400 invalid_request_error … tool_result.content.0.document.source
 *   .base64.media_type: Input should be 'application/pdf'
 *
 * We wrap the backend's `read()` so any result that isn't a model-safe type is
 * downgraded before the tool sees it: text-looking bytes are returned as UTF-8
 * text, everything else as a short text placeholder. Real PDFs and PNG/JPEG/
 * GIF/WebP images still pass through as native Anthropic blocks.
 */

// Decode at most this many bytes when treating unknown binary as text.
const MAX_TEXT_SNIFF_BYTES = 256 * 1024;
// Number of leading bytes inspected to decide text vs binary.
const SNIFF_WINDOW = 8192;
// Fraction of control characters above which content is treated as binary.
const MAX_SUSPICIOUS_RATIO = 0.1;
// Image media types the Anthropic Messages API accepts as native image blocks.
const MODEL_SAFE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/;

/** Media types the Anthropic Messages API accepts as native content blocks. */
function isModelSafeMime(mimeType) {
  if (!mimeType) return false;
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json' || mimeType === 'application/javascript') return true;
  if (mimeType === 'image/svg+xml') return true; // deepagents inlines SVG as text
  if (mimeType === 'application/pdf') return true;
  return MODEL_SAFE_IMAGE.test(mimeType);
}

/** Coerce a read() content payload (Uint8Array/Buffer/serialized) to a Buffer. */
function toBuffer(content) {
  if (!content) return null;
  if (Buffer.isBuffer(content)) return content;
  if (ArrayBuffer.isView(content)) return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  if (typeof content === 'object') {
    try {
      return Buffer.from(Uint8Array.from(Object.values(content)));
    } catch (_) {
      return null;
    }
  }
  return null;
}

/** Heuristic: bytes are UTF-8 text when there are no NULs and few control chars. */
function looksLikeText(buf) {
  const n = Math.min(buf.length, SNIFF_WINDOW);
  if (n === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false; // NUL byte is a decisive binary marker
    if (b < 9 || (b > 13 && b < 32)) suspicious++; // control chars (keep \t\n\v\f\r)
  }
  return suspicious / n < MAX_SUSPICIOUS_RATIO;
}

function placeholder(filePath, mimeType, size) {
  const kind = mimeType || 'unknown type';
  return `[binary file not shown: ${filePath} (${kind}, ${size} bytes). `
    + 'Use the shell (e.g. `file`, `xxd`, `strings`) to inspect it if needed.]';
}

/**
 * Normalize a backend read() result so it can never become a non-PDF document
 * block. Model-safe results (text, PDF, supported image) pass through untouched;
 * text-looking binaries are decoded to UTF-8; the rest become a text placeholder.
 */
function sanitizeReadResult(result, filePath) {
  if (!result || result.error) return result;
  if (isModelSafeMime(result.mimeType)) return result;

  // Non-safe mime with string content (e.g. the empty-file warning) — tag text.
  if (typeof result.content === 'string') {
    return { ...result, mimeType: 'text/plain' };
  }

  const buf = toBuffer(result.content);
  if (!buf) {
    return { ...result, content: placeholder(filePath, result.mimeType, 0), mimeType: 'text/plain' };
  }
  if (looksLikeText(buf)) {
    const slice = buf.subarray(0, MAX_TEXT_SNIFF_BYTES).toString('utf8');
    const omitted = buf.length - MAX_TEXT_SNIFF_BYTES;
    const text = omitted > 0 ? `${slice}\n… [truncated ${omitted} more bytes]` : slice;
    return { ...result, content: text, mimeType: 'text/plain' };
  }
  return { ...result, content: placeholder(filePath, result.mimeType, buf.length), mimeType: 'text/plain' };
}

/**
 * Patch `backend.read` in place so the read_file tool only ever receives
 * model-safe content. Patching the instance (rather than subclassing) keeps the
 * backend's private class fields and `instanceof` checks intact. Idempotent.
 */
function installSafeRead(backend) {
  if (!backend || typeof backend.read !== 'function' || backend.__safeReadInstalled) return backend;
  const original = backend.read.bind(backend);
  backend.read = async (filePath, offset = 0, limit = 500) =>
    sanitizeReadResult(await original(filePath, offset, limit), filePath);
  Object.defineProperty(backend, '__safeReadInstalled', { value: true, enumerable: false });
  return backend;
}

module.exports = {
  installSafeRead,
  sanitizeReadResult,
  isModelSafeMime,
  looksLikeText,
};
