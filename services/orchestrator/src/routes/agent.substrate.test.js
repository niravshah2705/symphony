'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SUBSTRATE_PATH = require.resolve('@ai-fleet/shared/agent/substrate');
const ROUTER_PATH = require.resolve('./agent');

const store = require('@ai-fleet/shared/store');

/**
 * Replace the ateapi client with a fake so the route can be exercised without a
 * cluster. Returns a restore fn.
 */
function stubSubstrate({ connected, actors }) {
  const real = require(SUBSTRATE_PATH);
  const calls = { listActors: 0 };
  require.cache[SUBSTRATE_PATH] = {
    id: SUBSTRATE_PATH,
    filename: SUBSTRATE_PATH,
    loaded: true,
    exports: {
      ...real,
      getControlPlaneStatus: async () => (connected
        ? { connected: true, status: 'SERVING', atespace: 'tenant-a' }
        : { connected: false, status: 'OFFLINE', error: 'no cluster' }),
      listActors: async () => {
        calls.listActors += 1;
        return actors || [{ metadata: { name: 'actor-1' }, status: { state: 'RUNNING' } }];
      },
    },
  };
  const originalGet = store.getSettings;
  store.getSettings = () => ({ agentPattern: 'substrate', substrateUrl: 'https://ateapi.ate-system.svc:8443' });
  delete require.cache[ROUTER_PATH];
  return {
    router: require(ROUTER_PATH),
    calls,
    restore: () => {
      store.getSettings = originalGet;
      delete require.cache[SUBSTRATE_PATH];
      delete require.cache[ROUTER_PATH];
    },
  };
}

function handlerFor(router, method, path) {
  const layer = router.stack.find((c) => c.route && c.route.path === path && c.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invoke(handler, req = { query: {}, body: {}, headers: {} }) {
  return new Promise((resolve, reject) => {
    handler(req, { json: resolve }, reject);
  });
}

test('GET /substrate/status answers instead of throwing when the control plane is up', async (t) => {
  const stub = stubSubstrate({ connected: true });
  t.after(stub.restore);
  const body = await invoke(handlerFor(stub.router, 'get', '/substrate/status'));
  assert.equal(body.configured, true);
  assert.equal(body.status.status, 'SERVING');
  assert.deepEqual(body.actors, [{ name: 'actor-1', state: 'RUNNING', workerPod: undefined, nodeName: undefined }]);
  assert.equal(stub.calls.listActors, 1);
});

test('GET /substrate/status skips the actor list when the control plane is unreachable', async (t) => {
  const stub = stubSubstrate({ connected: false });
  t.after(stub.restore);
  const body = await invoke(handlerFor(stub.router, 'get', '/substrate/status'));
  assert.equal(body.status.connected, false);
  assert.deepEqual(body.actors, []);
  assert.equal(stub.calls.listActors, 0);
});
