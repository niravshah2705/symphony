'use strict';

const { randomUUID } = require('node:crypto');
const { resolveAttachmentType, MAX_ATTACHMENT_BYTES } = require('./types');

const MAX_FILENAME = 255;
const ATTACHMENT_ID_PATTERN = /^att_[a-zA-Z0-9-]{8,64}$/;

class AttachmentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AttachmentError';
    this.status = status;
  }
}

/** Strip path separators/control characters; bound length. Never used to build a filesystem path. */
function sanitizeFilename(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .replace(/[/\\]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .slice(0, MAX_FILENAME);
}

function newAttachmentId() {
  return `att_${randomUUID()}`;
}

function newChunkId() {
  return `chunk_${randomUUID()}`;
}

/** Boundary validation for a mint (upload-intent) request — declared metadata only. */
function validateUploadRequest({ filename, mimeType, size } = {}) {
  const cleanFilename = sanitizeFilename(filename);
  if (!cleanFilename) throw new AttachmentError('filename is required.');

  const type = resolveAttachmentType(cleanFilename, mimeType);
  if (!type) throw new AttachmentError(`"${cleanFilename}" is not a supported attachment type.`);

  const numericSize = Number(size);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    throw new AttachmentError('size must be a positive number of bytes.');
  }
  if (numericSize > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`file exceeds the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit.`);
  }

  return {
    filename: cleanFilename,
    mimeType,
    size: numericSize,
    typeKey: type.typeKey,
    kind: type.kind,
    extractable: type.extractable,
  };
}

/**
 * Re-check the actual uploaded object against the declared metadata. Called at
 * complete-time with GCS-reported size/contentType — the browser could have
 * PUT something other than what it declared at mint time.
 */
function revalidateUploadedObject(declared, actual = {}) {
  const actualSize = Number(actual.size);
  if (!Number.isFinite(actualSize) || actualSize <= 0) {
    throw new AttachmentError('uploaded object could not be verified.');
  }
  if (actualSize > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`uploaded file exceeds the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit.`);
  }
  const type = resolveAttachmentType(declared.filename, actual.contentType || declared.mimeType);
  if (!type) throw new AttachmentError('uploaded file content type is not supported.');
  return { size: actualSize, typeKey: type.typeKey, kind: type.kind, extractable: type.extractable };
}

function isValidAttachmentId(id) {
  return ATTACHMENT_ID_PATTERN.test(String(id || ''));
}

module.exports = {
  AttachmentError,
  sanitizeFilename,
  newAttachmentId,
  newChunkId,
  validateUploadRequest,
  revalidateUploadedObject,
  isValidAttachmentId,
};
