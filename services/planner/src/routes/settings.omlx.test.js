'use strict';

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
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode, body: payload });
      },
    };

    try {
      const result = handler({ body }, response, reject);
      if (result && typeof result.catch === 'function') result.catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

test('planner OMLX preset settings reject plaintext keys and save only non-secret connection data', async (t) => {
  const originalGetSettings = store.getSettings;
  const originalPatchSettings = store.patchSettings;
  const modulePath = require.resolve('./settings');
  const patches = [];
  let state = {
    ...originalGetSettings(),
    byomProvider: 'omlx',
    byomPresetId: 'omlx-gpt-oss-20b',
    omlxHost: 'http://127.0.0.1:8000',
    omlxApiKey: '',
  };

  store.getSettings = () => state;
  store.patchSettings = (patch) => {
    patches.push(patch);
    state = { ...state, ...patch };
    return state;
  };
  delete require.cache[modulePath];
  t.after(() => {
    store.getSettings = originalGetSettings;
    store.patchSettings = originalPatchSettings;
    delete require.cache[modulePath];
  });

  const router = require('./settings');
  const handler = routeHandler(router, 'put', '/llm-preset');
  const apiKey = 'omlx-local-secret-value';
  const selection = {
    role: 'byom',
    provider: 'omlx',
    presetId: 'omlx-gpt-oss-20b',
  };

  const rejected = await invoke(handler, {
    ...selection,
    overrides: {
      host: 'http://127.0.0.1:9000/v1/',
      apiKey,
    },
  });

  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.body.error, /organization or project vault/i);
  assert.equal(patches.length, 0);
  assert.equal(state.omlxApiKey, '');

  const saved = await invoke(handler, {
    ...selection,
    overrides: { host: 'http://127.0.0.1:9000/v1/' },
  });

  assert.equal(saved.statusCode, 200);
  assert.equal(patches[0].omlxHost, 'http://127.0.0.1:9000');
  assert.equal(Object.prototype.hasOwnProperty.call(patches[0], 'omlxApiKey'), false);
  assert.equal(state.omlxHost, 'http://127.0.0.1:9000');
  assert.equal(state.omlxApiKey, '');
  assert.equal(saved.body.omlxHost, 'http://127.0.0.1:9000');
  assert.equal(saved.body.hasOmlxApiKey, false);
  assert.equal(saved.body.maskedOmlxApiKey, '');
  assert.equal(Object.prototype.hasOwnProperty.call(saved.body, 'omlxApiKey'), false);
  assert.equal(JSON.stringify(saved.body).includes(apiKey), false);
});
