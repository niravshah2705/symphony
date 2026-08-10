'use strict';

// Isolate the file backend to a temp dir BEFORE requiring the store.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.AI_FLEET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aifleet-gw-'));
process.env.STORE_BACKEND = 'file';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('@ai-fleet/shared/store');

function routeHandler(router, method, path) {
  const layer = router.stack.find((candidate) =>
    candidate.route && candidate.route.path === path && candidate.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  return layer.route.stack[0].handle;
}

function invoke(handler, body) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const response = {
      status(code) { statusCode = code; return this; },
      json(payload) { resolve({ statusCode, body: payload }); },
    };
    try {
      const result = handler({ body }, response, reject);
      if (result && typeof result.catch === 'function') result.catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

function withRouter(t, seed) {
  const originalGet = store.getSettings;
  const originalPatch = store.patchSettings;
  const originalHistory = store.addSettingsHistory;
  const modulePath = require.resolve('./settings');
  const history = [];
  let state = { ...originalGet(), ...seed };
  store.getSettings = () => state;
  store.patchSettings = (patch) => { state = { ...state, ...patch }; return state; };
  store.addSettingsHistory = (record) => { history.push(record); return record; };
  delete require.cache[modulePath];
  const router = require('./settings');
  t.after(() => {
    store.getSettings = originalGet;
    store.patchSettings = originalPatch;
    store.addSettingsHistory = originalHistory;
    delete require.cache[modulePath];
  });
  return { router, history, getState: () => state };
}

test('PUT /complexity applies a tier to every purpose role and records history', async (t) => {
  const { router, history, getState } = withRouter(t, {});
  const handler = routeHandler(router, 'put', '/complexity');

  const res = await invoke(handler, { tier: 'balanced' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.complexityTier, 'balanced', 'response reflects the applied tier');

  const state = getState();
  for (const role of ['thinking', 'execution', 'testing']) {
    assert.equal(state[`${role}LlmProvider`], 'claude');
    assert.equal(state[`${role}LlmPresetId`], 'claude-sonnet-5');
  }
  assert.equal(state.complexityTier, 'balanced');

  assert.equal(history.length, 1, 'a selection record is appended');
  const record = history[0];
  assert.equal(record.complexityTier, 'balanced');
  assert.equal(record.perRolePicks.execution.provider, 'claude');
  assert.equal(record.perRolePicks.execution.model, 'claude-sonnet-5');
  assert.ok(typeof record.estMonthlyCostUsd === 'number', 'priced tier carries a numeric estimate');
  // The record must never leak secrets.
  const serialized = JSON.stringify(record);
  assert.equal(/apiKey|token|secret/i.test(serialized), false);
});

test('PUT /complexity rejects an unknown tier without writing history', async (t) => {
  const { router, history } = withRouter(t, {});
  const handler = routeHandler(router, 'put', '/complexity');
  const res = await invoke(handler, { tier: 'nonexistent' });
  assert.equal(res.statusCode, 400);
  assert.equal(history.length, 0);
});

test('GET settings reports the stored tier only while it still matches (else custom)', async (t) => {
  // Seed a store that exactly matches the balanced tier, then diverge one role.
  const { settingsPatchForTier } = require('@ai-fleet/shared/agent/model-presets');
  const balanced = settingsPatchForTier('balanced');
  const { router } = withRouter(t, { ...balanced, complexityTier: 'balanced' });
  const getHandler = routeHandler(router, 'get', '/');
  const matched = await invoke(getHandler, {});
  assert.equal(matched.body.complexityTier, 'balanced');

  // Diverge the shared claude block; the stored tier no longer matches.
  const { router: router2 } = withRouter(t, {
    ...balanced, complexityTier: 'balanced', claudeModel: 'claude-opus-4-8',
  });
  const getHandler2 = routeHandler(router2, 'get', '/');
  const diverged = await invoke(getHandler2, {});
  assert.equal(diverged.body.complexityTier, 'custom');
});
