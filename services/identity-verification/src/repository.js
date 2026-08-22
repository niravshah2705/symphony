'use strict';

const fs = require('node:fs');
const path = require('node:path');

function emptyState() {
  return { sessions: {}, results: {}, claims: {} };
}

function createInMemoryRepository(seed = emptyState()) {
  let state = JSON.parse(JSON.stringify(seed));
  let queue = Promise.resolve();
  const transact = (fn) => {
    const run = queue.then(async () => {
      const next = JSON.parse(JSON.stringify(state));
      const out = await fn(next);
      state = next;
      return out;
    });
    queue = run.catch(() => {});
    return run;
  };
  return {
    async read() { return JSON.parse(JSON.stringify(state)); },
    async getSession(id) { return JSON.parse(JSON.stringify(state.sessions[id] || null)); },
    async getResult(id) { return JSON.parse(JSON.stringify(state.results[id] || null)); },
    async transact(fn) { return transact(fn); },
  };
}

function createFileRepository(file) {
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  const memory = createInMemoryRepository(load());

  function load() {
    try {
      return JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (_) {
      return emptyState();
    }
  }

  function persist(state) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(state, null, 2), 'utf8');
  }

  return {
    read: () => memory.read(),
    getSession: (id) => memory.getSession(id),
    getResult: (id) => memory.getResult(id),
    transact: (fn) => memory.transact(async (state) => {
      const out = await fn(state);
      persist(state);
      return out;
    }),
  };
}

module.exports = { emptyState, createInMemoryRepository, createFileRepository };
