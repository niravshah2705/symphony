'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workspaceOrganizationKey } = require('@ai-fleet/shared-core/store/workspace-context');
const pg = require('./postgres-backend');

function record(overrides = {}) {
  return {
    id: 'mem_1',
    scope: 'project',
    title: 'Alpha',
    text: 'The API base URL is configured per org.',
    tags: ['api'],
    source: 'agent',
    createdAt: '2026-09-03T10:00:00.000Z',
    embedding: [0.1, 0.2, 0.3, 0.4],
    ...overrides,
  };
}

/** Minimal pg.Pool stand-in: records queries, returns canned SELECT rows. */
function fakePool({ selectRows = () => [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT/i.test(String(sql).trim())) return { rows: selectRows(sql, params) };
      return { rows: [] };
    },
  };
}

test('float32 vector codec round-trips', () => {
  const encoded = pg.encodeVector([0.1, -0.25, 1.5]);
  const decoded = pg.decodeVector(encoded);
  assert.equal(decoded.length, 3);
  assert.ok(Math.abs(decoded[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(decoded[1] + 0.25) < 1e-6);
  assert.equal(pg.decodeVector(null), null);
  assert.deepEqual(pg.decodeVector([0.5]), [0.5]);
});

test('isConfigured tracks MEMORY_DATABASE_URL', () => {
  assert.equal(pg.isConfigured({}), false);
  assert.equal(pg.isConfigured({ MEMORY_DATABASE_URL: '  ' }), false);
  assert.equal(pg.isConfigured({ MEMORY_DATABASE_URL: 'postgresql://x/y' }), true);
});

test('databaseUrl falls back to the mounted secret file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-db-url-'));
  const file = path.join(dir, 'url');
  fs.writeFileSync(file, 'postgresql://u:p@/db?host=/cloudsql/x\n');
  try {
    assert.equal(pg.databaseUrl({ MEMORY_DATABASE_URL_FILE: file }), 'postgresql://u:p@/db?host=/cloudsql/x');
    assert.equal(pg.databaseUrl({ MEMORY_DATABASE_URL: 'postgresql://inline/db', MEMORY_DATABASE_URL_FILE: file }), 'postgresql://inline/db');
    assert.equal(pg.databaseUrl({ MEMORY_DATABASE_URL_FILE: path.join(dir, 'missing') }), '', 'missing file is dormant');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persist bootstraps the schema once, then inserts an org-scoped row', async () => {
  const pool = fakePool();
  const backend = pg.createPostgresBackend({ pool });
  const ctx = { organizationId: 'orgA' };

  const out = await backend.persist(record(), { context: ctx });
  assert.equal(out.id, 'mem_1');

  const schema = pool.calls.filter((call) => /CREATE TABLE|CREATE INDEX/.test(call.sql));
  assert.equal(schema.length, 2, 'table + index created');

  const insert = pool.calls.find((call) => /^INSERT INTO agent_memories/.test(call.sql));
  assert.ok(insert, 'insert issued');
  assert.match(insert.sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.equal(insert.params[1], workspaceOrganizationKey(ctx), 'tenant digest, not raw org id');
  assert.equal(insert.params[2], 'project');
  assert.equal(insert.params[3], 'Alpha');
  assert.match(insert.params[4], /API base URL/);
  assert.equal(insert.params[5], '["api"]');
  assert.ok(Buffer.isBuffer(insert.params[9]), 'embedding stored as float32 bytea');
});

test('persist is a no-op for an unknown scope or a missing id', async () => {
  const pool = fakePool();
  const backend = pg.createPostgresBackend({ pool });
  assert.equal(await backend.persist(record({ scope: 'bogus' }), { context: {} }), null);
  assert.equal(await backend.persist(record({ id: null }), { context: {} }), null);
  assert.equal(pool.calls.length, 0, 'no query for invalid input');
});

test('load maps rows, passes the tenant digest + cap, and decodes vectors', async () => {
  const createdAt = new Date('2026-09-03T10:00:00.000Z');
  const pool = fakePool({
    selectRows: () => [
      {
        id: 'mem_2',
        scope: 'project',
        title: 'Beta',
        text: 'Firestore is the durable store',
        tags: ['db'],
        source: 'agent',
        ref_id: null,
        created_at: createdAt,
        embedding: pg.encodeVector([0.5, 0.6]),
      },
    ],
  });
  const backend = pg.createPostgresBackend({ pool });
  const ctx = { organizationId: 'orgA' };
  const rows = await backend.load({ context: ctx, scope: 'project', limit: 7 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'Firestore is the durable store');
  assert.equal(rows[0].createdAt, createdAt.toISOString());
  assert.deepEqual(rows[0].tags, ['db']);
  assert.ok(Math.abs(rows[0].embedding[1] - 0.6) < 1e-6);
  assert.deepEqual(backend.readVector(rows[0]), rows[0].embedding);

  const select = pool.calls.find((call) => /^SELECT/.test(call.sql));
  assert.match(select.sql, /org_key = \$1/);
  assert.deepEqual(select.params, [workspaceOrganizationKey(ctx), 'project', 7]);
});

test('load rejects an unknown scope filter without querying', async () => {
  const pool = fakePool();
  const backend = pg.createPostgresBackend({ pool });
  assert.deepEqual(await backend.load({ context: {}, scope: 'bogus' }), []);
  assert.equal(pool.calls.length, 0);
});

test('a database error is fail-open (null / [])', async () => {
  const backend = pg.createPostgresBackend({
    pool: {
      async query() {
        throw new Error('cloudsql down');
      },
    },
  });
  assert.equal(await backend.persist(record(), { context: {} }), null);
  assert.deepEqual(await backend.load({ context: {} }), []);
});

test('an unconfigured database is a safe no-op', async () => {
  const backend = pg.createPostgresBackend({ pool: null, env: {} });
  assert.equal(await backend.persist(record(), { context: {} }), null);
  assert.deepEqual(await backend.load({ context: {} }), []);
});
