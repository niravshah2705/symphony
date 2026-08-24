'use strict';

/**
 * Canonical table of supported chat-attachment file types. The one place
 * extension/MIME/size rules live — model.js validates against it, extract.js
 * branches on it, and the GET /attachment-types route exposes it verbatim so
 * the frontend's drag/drop filter never drifts from server-side enforcement.
 */
const SUPPORTED_ATTACHMENT_TYPES = Object.freeze({
  pdf: Object.freeze({ extensions: ['.pdf'], mimeTypes: ['application/pdf'], kind: 'text', extractable: true }),
  docx: Object.freeze({
    extensions: ['.docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    kind: 'text',
    extractable: true,
  }),
  // Legacy binary .doc is accepted (stored, downloadable) but never indexed —
  // mammoth only parses OOXML, and users rarely distinguish .doc from .docx.
  doc: Object.freeze({ extensions: ['.doc'], mimeTypes: ['application/msword'], kind: 'text', extractable: false }),
  txt: Object.freeze({ extensions: ['.txt'], mimeTypes: ['text/plain'], kind: 'text', extractable: true }),
  jpg: Object.freeze({ extensions: ['.jpg', '.jpeg'], mimeTypes: ['image/jpeg'], kind: 'image', extractable: false }),
  png: Object.freeze({ extensions: ['.png'], mimeTypes: ['image/png'], kind: 'image', extractable: false }),
});

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB

const EXTENSION_TO_TYPE_KEY = Object.freeze(
  Object.fromEntries(
    Object.entries(SUPPORTED_ATTACHMENT_TYPES).flatMap(([typeKey, def]) =>
      def.extensions.map((ext) => [ext, typeKey]))
  )
);

const MIME_TO_TYPE_KEY = Object.freeze(
  Object.fromEntries(
    Object.entries(SUPPORTED_ATTACHMENT_TYPES).flatMap(([typeKey, def]) =>
      def.mimeTypes.map((mime) => [mime, typeKey]))
  )
);

function extensionOf(filename) {
  const match = /\.[^./\\]+$/.exec(String(filename || '').toLowerCase());
  return match ? match[0] : '';
}

/** Resolve a filename + declared MIME type to a known type entry, or null if disallowed. */
function resolveAttachmentType(filename, mimeType) {
  const ext = extensionOf(filename);
  const byExt = EXTENSION_TO_TYPE_KEY[ext];
  const byMime = MIME_TO_TYPE_KEY[String(mimeType || '').toLowerCase()];
  if (!byExt || !byMime || byExt !== byMime) return null;
  return { typeKey: byExt, ...SUPPORTED_ATTACHMENT_TYPES[byExt] };
}

module.exports = {
  SUPPORTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  resolveAttachmentType,
  extensionOf,
};
