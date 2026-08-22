'use strict';

/**
 * Firestore persistence for chat attachments: one document per attachment,
 * nested under organizations/{orgId}/projects/{projectId}/conversations/{conversationId},
 * with extracted-text chunks (each carrying an embedding vector) in a `chunks`
 * subcollection. Structural nesting — not a flat collection plus an equality
 * filter — so a query against a wrong/absent path returns nothing rather than
 * leaking cross-tenant data.
 *
 * `chunkId`/`orgId`/`projectId`/`conversationId` are duplicated onto every
 * chunk document because retrieval needs a `collectionGroup('chunks')` query,
 * and Firestore vector search can only pre-filter `findNearest()` via an
 * equality field in the same composite index — the physical path alone can't
 * scope a collection-group query.
 */

// Lazy require + injectable factory: mirrors store/firestore-backend.js so callers
// that never touch attachments don't need @google-cloud/firestore installed, and
// tests can inject an in-memory fake instead of hitting real Firestore.
function getDb(firestoreFactory) {
  if (typeof firestoreFactory === 'function') return firestoreFactory();
  const { Firestore } = require('@google-cloud/firestore');
  return new Firestore();
}

/** Wrap a raw embedding array as a Firestore VectorValue before writing a chunk. */
function toEmbeddingValue(embedding) {
  const { FieldValue } = require('@google-cloud/firestore');
  return FieldValue.vector(embedding);
}

function attachmentDocRef(db, { orgId, projectId, conversationId, attachmentId }) {
  return db
    .collection('organizations').doc(orgId)
    .collection('projects').doc(projectId)
    .collection('conversations').doc(conversationId)
    .collection('attachments').doc(attachmentId);
}

function attachmentsCollectionRef(db, { orgId, projectId, conversationId }) {
  return db
    .collection('organizations').doc(orgId)
    .collection('projects').doc(projectId)
    .collection('conversations').doc(conversationId)
    .collection('attachments');
}

async function createAttachment(db, record) {
  await attachmentDocRef(db, record).set(record);
  return record;
}

async function getAttachment(db, ids) {
  const snap = await attachmentDocRef(db, ids).get();
  return snap.exists ? snap.data() : null;
}

async function updateAttachment(db, ids, patch) {
  const ref = attachmentDocRef(db, ids);
  await ref.set(patch, { merge: true });
  const snap = await ref.get();
  return snap.data();
}

async function listAttachments(db, ids) {
  const snap = await attachmentsCollectionRef(db, ids).get();
  return snap.docs.map((doc) => doc.data());
}

/** Cascades to the chunk subcollection — callers must also delete the GCS object separately. */
async function deleteAttachment(db, ids) {
  const ref = attachmentDocRef(db, ids);
  const chunksSnap = await ref.collection('chunks').get();
  const batch = db.batch();
  for (const doc of chunksSnap.docs) batch.delete(doc.ref);
  batch.delete(ref);
  await batch.commit();
}

async function addChunks(db, ids, chunks) {
  if (!chunks.length) return;
  const ref = attachmentDocRef(db, ids);
  const batch = db.batch();
  for (const chunk of chunks) batch.set(ref.collection('chunks').doc(chunk.chunkId), chunk);
  await batch.commit();
}

/**
 * Nearest-neighbor search scoped to one conversation. `conversationId` is
 * server-derived by the caller — this function never accepts a client-supplied
 * scope, so a caller cannot widen the search beyond one conversation.
 */
async function searchAttachmentChunks(db, { conversationId, queryVector, limit = 5 }) {
  const snap = await db
    .collectionGroup('chunks')
    .where('conversationId', '==', conversationId)
    .findNearest({
      vectorField: 'embedding',
      queryVector,
      limit,
      distanceMeasure: 'COSINE',
    })
    .get();
  return snap.docs.map((doc) => doc.data());
}

module.exports = {
  getDb,
  toEmbeddingValue,
  attachmentDocRef,
  attachmentsCollectionRef,
  createAttachment,
  getAttachment,
  updateAttachment,
  listAttachments,
  deleteAttachment,
  addChunks,
  searchAttachmentChunks,
};
