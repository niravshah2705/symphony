'use strict';

const { CONFIG } = require('../config');

const SIGNED_URL_TTL_MS = 15 * 60 * 1000; // 15 minutes — matches the plan's "short-lived" upload window

/** `<project_id>-aifleet-attachments`, mirroring the skills-registry bucket naming convention. */
function bucketName() {
  const projectId = CONFIG.GCP && CONFIG.GCP.projectId;
  if (!projectId) throw new Error('GCP_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) must be set to resolve the attachments bucket.');
  return `${projectId}-aifleet-attachments`;
}

// Lazy require + injectable factory: mirrors packages/shared-core/src/store/firestore-backend.js
// so callers that never touch attachments don't need @google-cloud/storage installed, and tests
// can inject a fake (with an explicit bucket name, bypassing CONFIG.GCP.projectId entirely).
function getBucket(storageFactory, bucketNameOverride) {
  const storage = typeof storageFactory === 'function'
    ? storageFactory()
    : new (require('@google-cloud/storage').Storage)();
  return storage.bucket(bucketNameOverride || bucketName());
}

/** Mint a v4 signed PUT URL for a not-yet-uploaded object. Never a raw credential — single object, single verb, time-boxed. */
async function mintUploadUrl(gcsPath, { contentType, storageFactory, bucketNameOverride, ttlMs = SIGNED_URL_TTL_MS } = {}) {
  const bucket = getBucket(storageFactory, bucketNameOverride);
  const expires = Date.now() + ttlMs;
  const [url] = await bucket.file(gcsPath).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires,
    contentType,
  });
  return { url, expiresAt: new Date(expires).toISOString() };
}

/** Never trust a client's claim that an upload succeeded — verify against GCS itself. */
async function getObjectMetadata(gcsPath, { storageFactory, bucketNameOverride } = {}) {
  const bucket = getBucket(storageFactory, bucketNameOverride);
  const file = bucket.file(gcsPath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  return { size: Number(metadata.size), contentType: metadata.contentType || '' };
}

async function deleteObject(gcsPath, { storageFactory, bucketNameOverride } = {}) {
  const bucket = getBucket(storageFactory, bucketNameOverride);
  await bucket.file(gcsPath).delete({ ignoreNotFound: true });
}

/** Read full object bytes — used for text extraction and for inlining images into multimodal calls. */
async function readObjectBuffer(gcsPath, { storageFactory, bucketNameOverride } = {}) {
  const bucket = getBucket(storageFactory, bucketNameOverride);
  const [buffer] = await bucket.file(gcsPath).download();
  return buffer;
}

/** Server-derived only — never built from client input. */
function objectPath({ orgId, projectId, conversationId, attachmentId, filename }) {
  return `organizations/${orgId}/projects/${projectId}/conversations/${conversationId}/attachments/${attachmentId}-${filename}`;
}

module.exports = {
  bucketName,
  getBucket,
  mintUploadUrl,
  getObjectMetadata,
  deleteObject,
  readObjectBuffer,
  objectPath,
  SIGNED_URL_TTL_MS,
};
