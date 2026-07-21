'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('@ai-fleet/shared/store');

function routeHandler(router, path) {
  const layer = router.stack.find((candidate) => candidate.route && candidate.route.path === path);
  assert.ok(layer, `${path} route must exist`);
  return layer.route.stack[0].handle;
}

function invoke(handler) {
  return new Promise((resolve, reject) => {
    handler({}, { json: resolve }, reject);
  });
}

test('OMLX model discovery uses /v1/models, keeps Bearer auth server-side, and normalizes profiles', async (t) => {
  const originalGetSettings = store.getSettings;
  const originalFetch = global.fetch;
  const modulePath = require.resolve('./agent');
  let request;

  store.getSettings = () => ({
    omlxHost: 'http://127.0.0.1:8000/v1/',
    omlxApiKey: 'local-secret',
  });
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        data: [
          { id: 'z-model' },
          { id: 'a-model', max_model_len: 32768 },
          { id: '' },
        ],
      }),
    };
  };
  delete require.cache[modulePath];
  t.after(() => {
    store.getSettings = originalGetSettings;
    global.fetch = originalFetch;
    delete require.cache[modulePath];
  });

  const router = require('./agent');
  const result = await invoke(routeHandler(router, '/omlx-models'));

  assert.equal(request.url, 'http://127.0.0.1:8000/v1/models');
  assert.equal(request.options.headers.Authorization, 'Bearer local-secret');
  assert.deepEqual(result, {
    models: [
      { id: 'a-model', label: 'a-model', contextWindow: 32768 },
      { id: 'z-model', label: 'z-model' },
    ],
    reachable: true,
    source: 'local',
  });
  assert.equal(JSON.stringify(result).includes('local-secret'), false);
});
