'use strict';

const { createHash, randomUUID } = require('node:crypto');

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function documentId(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

class MemoryIdempotencyStore {
  constructor({ leaseMs = DEFAULT_LEASE_MS, retentionMs = DEFAULT_RETENTION_MS } = {}) {
    this.leaseMs = leaseMs;
    this.retentionMs = retentionMs;
    this.records = new Map();
  }

  async claim(key, nowMs = Date.now()) {
    const id = documentId(key);
    const current = this.records.get(id);
    if (current && current.deleteAfterMs > nowMs) {
      if (current.status === 'sent') return { acquired: false, state: 'sent' };
      if (current.leaseExpiresAtMs > nowMs) return { acquired: false, state: 'in_progress' };
    }
    const claimId = randomUUID();
    this.records.set(id, {
      status: 'sending',
      claimId,
      leaseExpiresAtMs: nowMs + this.leaseMs,
      deleteAfterMs: nowMs + this.retentionMs,
    });
    return { acquired: true, claimId };
  }

  async complete(key, claimId, nowMs = Date.now()) {
    const id = documentId(key);
    const current = this.records.get(id);
    if (!current || current.claimId !== claimId) throw new Error('idempotency claim lost');
    this.records.set(id, {
      status: 'sent',
      claimId,
      leaseExpiresAtMs: 0,
      deleteAfterMs: nowMs + this.retentionMs,
    });
  }

  async release(key, claimId) {
    const id = documentId(key);
    const current = this.records.get(id);
    if (current && current.claimId === claimId && current.status === 'sending') this.records.delete(id);
  }
}

class FirestoreIdempotencyStore {
  constructor(db, collectionName, { leaseMs = DEFAULT_LEASE_MS, retentionMs = DEFAULT_RETENTION_MS } = {}) {
    this.db = db;
    this.collection = db.collection(collectionName);
    this.leaseMs = leaseMs;
    this.retentionMs = retentionMs;
  }

  async claim(key, nowMs = Date.now()) {
    const ref = this.collection.doc(documentId(key));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() : null;
      if (current && Number(current.delete_after_ms) > nowMs) {
        if (current.status === 'sent') return { acquired: false, state: 'sent' };
        if (Number(current.lease_expires_at_ms) > nowMs) return { acquired: false, state: 'in_progress' };
      }
      const claimId = randomUUID();
      transaction.set(ref, {
        status: 'sending',
        claim_id: claimId,
        lease_expires_at_ms: nowMs + this.leaseMs,
        delete_after_ms: nowMs + this.retentionMs,
        updated_at: new Date(nowMs).toISOString(),
      });
      return { acquired: true, claimId };
    });
  }

  async complete(key, claimId, nowMs = Date.now()) {
    const ref = this.collection.doc(documentId(key));
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() : null;
      if (!current || current.claim_id !== claimId) throw new Error('idempotency claim lost');
      transaction.set(ref, {
        status: 'sent',
        claim_id: claimId,
        lease_expires_at_ms: 0,
        delete_after_ms: nowMs + this.retentionMs,
        updated_at: new Date(nowMs).toISOString(),
      });
    });
  }

  async release(key, claimId) {
    const ref = this.collection.doc(documentId(key));
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() : null;
      if (current && current.claim_id === claimId && current.status === 'sending') transaction.delete(ref);
    });
  }
}

function createIdempotencyStore(config) {
  if (!config.useFirestore) return new MemoryIdempotencyStore();
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({
    projectId: config.projectId,
    databaseId: config.firestoreDatabase,
  });
  return new FirestoreIdempotencyStore(db, config.idempotencyCollection);
}

module.exports = {
  MemoryIdempotencyStore,
  FirestoreIdempotencyStore,
  createIdempotencyStore,
  documentId,
};
