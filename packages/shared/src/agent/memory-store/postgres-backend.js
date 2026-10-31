'use strict';

/**
 * Cloud SQL for PostgreSQL memory backend.
 *
 * The MemoryMiddleware persists every AI-compressed observation as one row in
 * `agent_memories`, tenant-isolated by `org_key` (a stable digest of the
 * workspace organization). Embeddings are stored as float32 LE `bytea` and
 * decoded on read, so recall reuses the in-process cosine blend in recall.js —
 * no pgvector extension, no Chroma service.
 *
 * Connection: `MEMORY_DATABASE_URL` (or `MEMORY_DATABASE_URL_FILE`, the
 * secret-file mount Cloud Run uses). On Cloud Run that URL points at the
 * `/cloudsql/<project:region:instance>` unix socket mounted by the Cloud SQL
 * volume (see deploy/gcp/terraform/memory.tf), e.g.
 *
 *   postgresql://user:pass@/aifleet_memory?host=/cloudsql/<connection_name>
 *
 * The pool is small and idle-timed because agents scale to zero and Cloud SQL
 * has a connection ceiling. Every method is fail-open: a DB defect returns a
 * benign null/[] and never fails an agent run.
 */

const fs = require('fs');
const { MEMORY_SCOPES } = require('../memory');
const { workspaceOrganizationKey } = require('@ai-fleet/shared-core/store/workspace-context');

const DEFAULT_SCAN_CAP = 200;
const DEFAULT_POOL_SIZE = 2;
const IDLE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
const EMBEDDING_BYTES = 4; // Float32

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS agent_memories (
     id         text PRIMARY KEY,
     org_key    text NOT NULL,
     scope      text NOT NULL,
     title      text NOT NULL DEFAULT '',
     body       text NOT NULL,
     tags       jsonb NOT NULL DEFAULT '[]'::jsonb,
     source     text NOT NULL DEFAULT 'agent',
     ref_id     text,
     created_at timestamptz NOT NULL,
     embedding  bytea
   )`,
  `CREATE INDEX IF NOT EXISTS agent_memories_org_scope_created_idx
     ON agent_memories (org_key, scope, created_at DESC)`,
];

/**
 * Inline MEMORY_DATABASE_URL, else the mounted secret file (Cloud Run delivers
 * the connection string as a secret FILE so the agent primary stays
 * secret-env-free for per-tenant provisioning).
 */
function databaseUrl(env = process.env) {
  const inline = String(env.MEMORY_DATABASE_URL || '').trim();
  if (inline) return inline;
  const file = String(env.MEMORY_DATABASE_URL_FILE || '').trim();
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function isConfigured(env = process.env) {
  return databaseUrl(env) !== '';
}

/* ------------------------------ vector codec ------------------------------- */

function encodeVector(embedding) {
  const buf = Buffer.alloc(embedding.length * EMBEDDING_BYTES);
  for (let i = 0; i < embedding.length; i += 1) {
    buf.writeFloatLE(Number(embedding[i]) || 0, i * EMBEDDING_BYTES);
  }
  return buf;
}

function decodeVector(value) {
  if (Array.isArray(value)) return value.length ? value.map(Number) : null;
  if (!Buffer.isBuffer(value) || value.length < EMBEDDING_BYTES) return null;
  const out = new Array(Math.floor(value.length / EMBEDDING_BYTES));
  for (let i = 0; i < out.length; i += 1) out[i] = value.readFloatLE(i * EMBEDDING_BYTES);
  return out;
}

/* ---------------------------------- pool ----------------------------------- */

function createPool(env = process.env) {
  const url = databaseUrl(env);
  if (!url) return null;
  const { Pool } = require('pg');
  const max = Number(env.MEMORY_DB_POOL_SIZE);
  return new Pool({
    connectionString: url,
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_POOL_SIZE,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    allowExitOnIdle: true,
  });
}

let sharedPool;
let sharedPoolEnv;

/** Process-wide lazy pool (one per connection URL); null when unconfigured. */
function defaultPool(env = process.env) {
  const url = databaseUrl(env);
  if (!url) return null;
  if (!sharedPool || sharedPoolEnv !== url) {
    sharedPool = createPool(env);
    sharedPoolEnv = url;
  }
  return sharedPool;
}

/* --------------------------------- backend --------------------------------- */

/**
 * Build a backend over an injected pool (tests) or the lazy shared pool.
 * The schema is created once, lazily, on first use; a failed bootstrap is
 * retried on the next call rather than poisoning the process.
 */
function createPostgresBackend({ pool = null, env = process.env } = {}) {
  let schemaReady = null;

  function getPool() {
    return pool || defaultPool(env);
  }

  async function ensureSchema(client) {
    if (!schemaReady) {
      schemaReady = (async () => {
        for (const statement of SCHEMA_SQL) await client.query(statement);
      })().catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    return schemaReady;
  }

  async function persist(record, { context } = {}) {
    try {
      if (!record || !MEMORY_SCOPES.includes(record.scope) || !record.id) return null;
      const client = getPool();
      if (!client) return null;
      await ensureSchema(client);
      const embedding =
        Array.isArray(record.embedding) && record.embedding.length ? encodeVector(record.embedding) : null;
      const createdAt = Number.isFinite(Date.parse(record.createdAt || ''))
        ? new Date(record.createdAt).toISOString()
        : new Date().toISOString();
      await client.query(
        `INSERT INTO agent_memories
           (id, org_key, scope, title, body, tags, source, ref_id, created_at, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          record.id,
          workspaceOrganizationKey(context),
          record.scope,
          String(record.title || ''),
          String(record.text || ''),
          JSON.stringify(Array.isArray(record.tags) ? record.tags.map(String) : []),
          String(record.source || 'agent'),
          record.refId ? String(record.refId) : null,
          createdAt,
          embedding,
        ],
      );
      return record;
    } catch (_) {
      return null;
    }
  }

  async function load({ context, scope, limit } = {}) {
    try {
      const client = getPool();
      if (!client) return [];
      if (scope && !MEMORY_SCOPES.includes(scope)) return [];
      await ensureSchema(client);
      const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SCAN_CAP;
      const { rows } = await client.query(
        `SELECT id, scope, title, body AS text, tags, source, ref_id, created_at, embedding
           FROM (
             SELECT id, scope, title, body, tags, source, ref_id, created_at, embedding,
                    row_number() OVER (PARTITION BY scope ORDER BY created_at DESC) AS rn
               FROM agent_memories
              WHERE org_key = $1
                AND ($2::text IS NULL OR scope = $2)
           ) newest
          WHERE rn <= $3
          ORDER BY created_at DESC`,
        [workspaceOrganizationKey(context), scope || null, cap],
      );
      return rows.map((row) => ({
        id: row.id,
        scope: row.scope,
        title: row.title || '',
        text: row.text || '',
        tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
        source: row.source || 'agent',
        refId: row.ref_id || null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
        embedding: decodeVector(row.embedding),
      }));
    } catch (_) {
      return [];
    }
  }

  /** Rows carry their decoded vector, so recall reads it directly. */
  function readVector(memory) {
    return memory && Array.isArray(memory.embedding) && memory.embedding.length ? memory.embedding : null;
  }

  return { persist, load, readVector };
}

const defaultBackend = createPostgresBackend();

module.exports = {
  ...defaultBackend,
  createPostgresBackend,
  createPool,
  defaultPool,
  isConfigured,
  databaseUrl,
  encodeVector,
  decodeVector,
  SCHEMA_SQL,
  DEFAULT_SCAN_CAP,
  DEFAULT_POOL_SIZE,
};
