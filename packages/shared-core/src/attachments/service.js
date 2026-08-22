'use strict';

/**
 * Orchestrates upload -> extract -> chunk -> embed -> index, plus retrieval.
 * Deliberately has NO LLM-calling logic — this package has no agent-SDK
 * dependency (see package.json description). Assembling a prompt from
 * `searchAttachments` results and calling `resolveLlm` belongs one layer up,
 * in a package that already depends on the agent-SDK tree.
 */

const gcs = require('./gcs');
const store = require('./store');
const { extractText } = require('./extract');
const { chunkText } = require('./chunk');
const { embedTexts } = require('./embed');
const { validateUploadRequest, revalidateUploadedObject, newAttachmentId, newChunkId, AttachmentError } = require('./model');

function nowIso() {
  return new Date().toISOString();
}

/** Step 1: validate + mint a signed upload URL + create the pending Firestore doc. */
async function mintUpload({ orgId, projectId, conversationId, filename, mimeType, size }, deps = {}) {
  const validated = validateUploadRequest({ filename, mimeType, size });
  const attachmentId = newAttachmentId();
  const gcsPath = gcs.objectPath({ orgId, projectId, conversationId, attachmentId, filename: validated.filename });

  const { url, expiresAt } = await gcs.mintUploadUrl(gcsPath, {
    contentType: validated.mimeType,
    storageFactory: deps.storageFactory,
    bucketNameOverride: deps.bucketNameOverride,
  });

  const db = store.getDb(deps.firestoreFactory);
  const record = {
    orgId,
    projectId,
    conversationId,
    attachmentId,
    filename: validated.filename,
    mimeType: validated.mimeType,
    size: validated.size,
    gcsPath,
    kind: validated.kind,
    status: 'pending',
    extractedChars: 0,
    truncated: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store.createAttachment(db, record);

  return { attachmentId, uploadUrl: url, gcsPath, expiresAt };
}

/** Step 2: verify the object landed in GCS, then run the ingestion pipeline (text types only). */
async function completeUpload({ orgId, projectId, conversationId, attachmentId }, deps = {}) {
  const db = store.getDb(deps.firestoreFactory);
  const ids = { orgId, projectId, conversationId, attachmentId };
  const attachment = await store.getAttachment(db, ids);
  if (!attachment) throw new AttachmentError('attachment not found.', 404);

  const actual = await gcs.getObjectMetadata(attachment.gcsPath, {
    storageFactory: deps.storageFactory,
    bucketNameOverride: deps.bucketNameOverride,
  });
  if (!actual) throw new AttachmentError('the uploaded object was not found in storage.', 409);

  // Never trust the browser's declared type/size — re-check against the real object.
  const revalidated = revalidateUploadedObject(attachment, actual);

  // Images are never text-extractable BY DESIGN and are fully "ready" as-is
  // (stored + attachable for direct multimodal viewing). Legacy .doc is a
  // DIFFERENT case — a text-oriented format we chose not to parse — hence
  // "unsupported" rather than "ready" even though both have extractable:false.
  if (revalidated.kind === 'image') {
    return store.updateAttachment(db, ids, { status: 'ready', size: revalidated.size, updatedAt: nowIso() });
  }
  if (!revalidated.extractable) {
    return store.updateAttachment(db, ids, { status: 'unsupported', size: revalidated.size, updatedAt: nowIso() });
  }

  await store.updateAttachment(db, ids, { status: 'processing', size: revalidated.size, updatedAt: nowIso() });

  try {
    const buffer = await gcs.readObjectBuffer(attachment.gcsPath, {
      storageFactory: deps.storageFactory,
      bucketNameOverride: deps.bucketNameOverride,
    });
    const { text, truncated: textTruncated } = await extractText(buffer, revalidated.typeKey);
    const { chunks, truncated: chunksTruncated } = chunkText(text);

    if (chunks.length) {
      const vectors = await embedTexts(chunks, {
        apiKey: deps.embeddingApiKey,
        workspaceContext: deps.workspaceContext,
        fetchImpl: deps.fetchImpl,
      });
      const chunkRecords = chunks.map((chunkText_, i) => ({
        chunkId: newChunkId(),
        chunkIndex: i,
        text: chunkText_,
        embedding: store.toEmbeddingValue(vectors[i]),
        attachmentId,
        filename: attachment.filename,
        orgId,
        projectId,
        conversationId,
        createdAt: nowIso(),
      }));
      await store.addChunks(db, ids, chunkRecords);
    }

    return store.updateAttachment(db, ids, {
      status: 'ready',
      extractedChars: text.length,
      truncated: textTruncated || chunksTruncated,
      updatedAt: nowIso(),
    });
  } catch (err) {
    return store.updateAttachment(db, ids, {
      status: 'failed',
      error: String((err && err.message) || err).slice(0, 400),
      updatedAt: nowIso(),
    });
  }
}

async function listAttachments({ orgId, projectId, conversationId }, deps = {}) {
  const db = store.getDb(deps.firestoreFactory);
  return store.listAttachments(db, { orgId, projectId, conversationId });
}

async function removeAttachment({ orgId, projectId, conversationId, attachmentId }, deps = {}) {
  const db = store.getDb(deps.firestoreFactory);
  const ids = { orgId, projectId, conversationId, attachmentId };
  const attachment = await store.getAttachment(db, ids);
  if (!attachment) return; // idempotent — deleting twice is not an error
  await gcs.deleteObject(attachment.gcsPath, { storageFactory: deps.storageFactory, bucketNameOverride: deps.bucketNameOverride });
  await store.deleteAttachment(db, ids);
}

/** Cascade helper for conversation deletion — best-effort, never blocks the conversation delete itself. */
async function removeAllAttachmentsForConversation({ orgId, projectId, conversationId }, deps = {}) {
  const attachments = await listAttachments({ orgId, projectId, conversationId }, deps);
  await Promise.all(attachments.map((a) => removeAttachment({ orgId, projectId, conversationId, attachmentId: a.attachmentId }, deps).catch(() => {})));
}

/**
 * Pure retrieval — embeds the query and returns the nearest chunks, scoped to
 * one conversation. No LLM call here; see module doc comment above.
 */
async function searchAttachments({ conversationId, query, limit = 5 }, deps = {}) {
  const db = store.getDb(deps.firestoreFactory);
  const [queryVector] = await embedTexts([query], {
    apiKey: deps.embeddingApiKey,
    workspaceContext: deps.workspaceContext,
    fetchImpl: deps.fetchImpl,
  });
  if (!queryVector) return [];
  return store.searchAttachmentChunks(db, { conversationId, queryVector, limit });
}

module.exports = {
  mintUpload,
  completeUpload,
  listAttachments,
  removeAttachment,
  removeAllAttachmentsForConversation,
  searchAttachments,
};
