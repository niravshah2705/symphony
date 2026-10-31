'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const mw = require('./memory-middleware');

/* -------------------------------- enablement ------------------------------- */

test('isEnabled honors the explicit per-run flag and env fast-path', () => {
  assert.equal(mw.isEnabled({ memory: { enabled: true } }), true);
  assert.equal(mw.isEnabled({ memory: { enabled: false } }), false);
  const prev = process.env.MEMORY_ENABLED;
  try {
    process.env.MEMORY_ENABLED = 'true';
    assert.equal(mw.isEnabled({}), true);
    process.env.MEMORY_ENABLED = 'false';
    assert.equal(mw.isEnabled({}), false);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_ENABLED;
    else process.env.MEMORY_ENABLED = prev;
  }
});

/* --------------------------------- scrubbing ------------------------------- */

test('stripPrivate removes <private> regions; redactSecrets masks credentials', () => {
  assert.equal(mw.stripPrivate('keep <private>topsecret</private> end').includes('topsecret'), false);
  assert.match(mw.redactSecrets('token ghp_ABCDEFGHIJKLMNOPQRSTUVWX'), /\[redacted\]/);
  assert.match(mw.redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuv'), /\[redacted\]/);
});

test('buildRecord normalizes, redacts, id-stamps, and marks the source agent', () => {
  const rec = mw.buildRecord({ scope: 'project', title: 'X', text: 'api_key=abcdef123456 stays out' }, { workflow: 'coding' });
  assert.ok(rec.id.startsWith('mem_'));
  assert.equal(rec.source, 'agent');
  assert.equal(rec.scope, 'project');
  assert.match(rec.text, /\[redacted\]/);
  assert.ok(rec.createdAt);
});

test('buildRecord falls back to the workflow scope for an unknown proposed scope', () => {
  const rec = mw.buildRecord({ scope: 'nonsense', title: 'T', text: 'implement the widget endpoint' }, { workflow: 'coding' });
  assert.equal(rec.scope, 'task'); // coding → task
});

/* ---------------------------------- inject --------------------------------- */

test('inject prepends a bounded <memory_context> block from recalled memories', async () => {
  const memories = [{ id: 'm1', scope: 'project', title: 'DB', text: 'Firestore is the durable store' }];
  const backend = { load: () => memories, recall: () => memories };
  const embed = async (texts) => texts.map(() => [0, 1, 0]);
  const out = await mw.inject('what datastore do we use?', {}, { backend, embed });
  assert.ok(out.startsWith('<memory_context>'), out);
  assert.match(out, /Firestore is the durable store/);
  assert.match(out, /what datastore do we use\?/);
});

test('inject is byte-identical when there are no memories', async () => {
  const backend = { load: () => [], recall: () => [] };
  const out = await mw.inject('hello world', {}, { backend, embed: async () => [[0]] });
  assert.equal(out, 'hello world');
});

test('inject fails open — a backend error returns the original prompt', async () => {
  const backend = { load: () => { throw new Error('disk down'); }, recall: () => [] };
  const out = await mw.inject('stay intact', {}, { backend, embed: async () => [[0]] });
  assert.equal(out, 'stay intact');
});

/* --------------------------------- capture --------------------------------- */

test('capture compresses → embeds → persists each observation', async () => {
  const persisted = [];
  const backend = { persist: (record) => { persisted.push(record); return record; } };
  const callJson = async () => ({ json: { observations: [
    { scope: 'project', title: 'Store', text: 'Durable state lives in Firestore' },
    { scope: 'task', title: 'Deploy', text: 'Cloud Run scales to zero' },
  ] } });
  const embed = async (texts) => texts.map(() => [0.1, 0.2, 0.3]);
  const res = await mw.capture({ finalText: 'we did work', messages: [] }, { workflow: 'coding', prompt: 'do' }, { backend, callJson, embed });
  assert.equal(res.saved, 2);
  assert.equal(persisted.length, 2);
  assert.ok(Array.isArray(persisted[0].embedding));
  assert.equal(persisted[0].source, 'agent');
});

test('capture strips <private> from the finalText before compression', async () => {
  let seenPrompt = '';
  const callJson = async ({ prompt }) => { seenPrompt = prompt; return { json: { observations: [] } }; };
  await mw.capture({ finalText: 'keep this <private>leak me</private> here' }, {}, { callJson, embed: async () => [[0]], backend: { persist() {} } });
  assert.equal(seenPrompt.includes('leak me'), false);
  assert.match(seenPrompt, /keep this/);
});

test('capture fails open — compressor error yields saved:0, empty finalText skips the model', async () => {
  let called = 0;
  const boom = async () => { called += 1; throw new Error('grader down'); };
  assert.deepEqual(await mw.capture({ finalText: 'x' }, {}, { callJson: boom, embed: async () => [[0]], backend: { persist() {} } }), { saved: 0 });
  assert.equal(called, 1);
  assert.deepEqual(await mw.capture({ finalText: '' }, {}, { callJson: boom, embed: async () => [[0]], backend: { persist() {} } }), { saved: 0 });
  assert.equal(called, 1, 'empty finalText never invokes the model');
});

/* --------------------- end-to-end through Postgres ------------------------ */

/** Minimal in-memory pg.Pool stand-in (insert → select) for the real backend. */
function memoryPool() {
  const rows = new Map();
  return {
    async query(sql, params) {
      const text = String(sql).trim();
      if (/^(CREATE|CREATE INDEX)/i.test(text)) return { rows: [] };
      if (/^INSERT/i.test(text)) {
        const [id, orgKey, scope, title, body, tags, source, refId, createdAt, embedding] = params;
        rows.set(id, { id, org_key: orgKey, scope, title, body, tags: JSON.parse(tags), source, ref_id: refId, created_at: new Date(createdAt), embedding });
        return { rows: [] };
      }
      if (/^SELECT/i.test(text)) {
        const [orgKey, scope, cap] = params;
        return {
          rows: [...rows.values()]
            .filter((row) => row.org_key === orgKey && (!scope || row.scope === scope))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, cap)
            .map((row) => ({ ...row, text: row.body })),
        };
      }
      return { rows: [] };
    },
  };
}

test('capture then inject round-trips through the real Postgres-backed store', async () => {
  const { runWithWorkspaceContext } = require('@ai-fleet/shared-core/store/workspace-context');
  const { createPostgresBackend } = require('./memory-store/postgres-backend');
  const { recallMemories } = require('./memory-store/recall');
  const store = createPostgresBackend({ pool: memoryPool() });
  const backend = {
    persist: store.persist,
    load: store.load,
    recall: (args) => recallMemories({ ...args, loadVector: store.readVector }),
  };
  const embed = async (texts) => texts.map(() => [0.2, 0.4, 0.6, 0.8]);
  const callJson = async () => ({ json: { observations: [
    { scope: 'project', title: 'Datastore', text: 'Durable state lives in Firestore for this project' },
  ] } });
  await runWithWorkspaceContext({ organizationId: 'orgZ' }, async () => {
    const cap = await mw.capture({ finalText: 'we chose firestore' }, { workflow: 'coding' }, { embed, callJson, backend });
    assert.equal(cap.saved, 1);
    const out = await mw.inject('which datastore holds durable state?', {}, { embed, backend });
    assert.match(out, /Durable state lives in Firestore/);
  });
});
