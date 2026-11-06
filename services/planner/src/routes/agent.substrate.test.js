'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SUBSTRATE_PATH = require.resolve('@ai-fleet/shared/agent/substrate');
const RUNNER_PATH = require.resolve('@ai-fleet/shared/agent/substrate-runner');
const ROUTER_PATH = require.resolve('./agent');

const store = require('@ai-fleet/shared/store');

/**
 * Replace the ateapi client with a fake so the route can be exercised without a
 * cluster. Returns a restore fn.
 */
function stubSubstrate({ connected, actors, token = 'sa-projected-token', runCapture }) {
  const real = require(SUBSTRATE_PATH);
  const calls = { listActors: 0, tokenResolutions: 0 };
  require.cache[SUBSTRATE_PATH] = {
    id: SUBSTRATE_PATH,
    filename: SUBSTRATE_PATH,
    loaded: true,
    exports: {
      ...real,
      resolveSubstrateApiToken: async (input) => {
        calls.tokenResolutions += 1;
        calls.tokenArgs = input;
        return token;
      },
      getControlPlaneStatus: async (opts) => {
        calls.statusAuth = opts.token;
        return connected
          ? { connected: true, status: 'SERVING', atespace: 'tenant-a' }
          : { connected: false, status: 'OFFLINE', error: 'no cluster' };
      },
      listActors: async (opts) => {
        calls.listActors += 1;
        calls.listActorsAuth = opts && opts.token;
        return actors || [{ metadata: { name: 'actor-1' }, status: { state: 'RUNNING' } }];
      },
    },
  };
  if (runCapture) {
    const realRunner = require(RUNNER_PATH);
    require.cache[RUNNER_PATH] = {
      id: RUNNER_PATH,
      filename: RUNNER_PATH,
      loaded: true,
      exports: {
        ...realRunner,
        runPlanningOnSubstrate: async (args) => {
          runCapture(args);
          return {
            finalText: 'PLAN',
            substrate: { atespace: 'tenant-a', actorName: 'plan-x', credentialSync: { state: 'synced' } },
          };
        },
      },
    };
  }
  const originalGet = store.getSettings;
  store.getSettings = () => ({ agentPattern: 'substrate', substrateUrl: 'https://ateapi.ate-system.svc:8443' });
  delete require.cache[ROUTER_PATH];
  return {
    router: require(ROUTER_PATH),
    calls,
    restore: () => {
      store.getSettings = originalGet;
      delete require.cache[SUBSTRATE_PATH];
      delete require.cache[RUNNER_PATH];
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

test('GET /substrate/status resolves the credential per request and threads it to both RPCs', async (t) => {
  const stub = stubSubstrate({ connected: true });
  t.after(stub.restore);
  const body = await invoke(handlerFor(stub.router, 'get', '/substrate/status'));
  assert.equal(body.configured, true);
  assert.equal(body.credentialConfigured, true);
  assert.equal(stub.calls.tokenResolutions, 1);
  assert.equal(stub.calls.statusAuth, 'sa-projected-token');
  assert.equal(stub.calls.listActorsAuth, 'sa-projected-token');
  assert.ok(String(stub.calls.tokenArgs.organizationId).length > 0, 'resolution is org-scoped');
});

test('GET /substrate/status reports configured:false when no credential resolves', async (t) => {
  const stub = stubSubstrate({ connected: true, token: '' });
  t.after(stub.restore);
  const body = await invoke(handlerFor(stub.router, 'get', '/substrate/status'));
  assert.equal(body.configured, false);
  assert.equal(body.credentialConfigured, false);
  assert.equal(stub.calls.listActors, 0, 'no actor list without a credential');
});

test('POST /substrate/run resolves substrateApiToken over S2S and hands it to the runner', async (t) => {
  const savedInternalToken = process.env.INTERNAL_API_TOKEN;
  process.env.INTERNAL_API_TOKEN = 'internal-test-token';
  const savedFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (url) => {
    paths.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ secrets: { substrateApiToken: { value: 'sa-s2s-token' }, githubToken: { value: 'gh' } } }),
    };
  };
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedInternalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = savedInternalToken;
  });

  let passed;
  const stub = stubSubstrate({ connected: true, token: '', runCapture: (args) => { passed = args; } });
  t.after(stub.restore);

  const body = await invoke(
    handlerFor(stub.router, 'post', '/substrate/run'),
    { query: {}, body: { prompt: 'plan it' }, headers: {} },
  );
  assert.match(paths[0], /\/api\/v1\/internal\/s2s\/(managed-secrets|orgs\/)/);
  assert.equal(passed.substrateApiToken, 'sa-s2s-token');
  assert.equal(body.ok, true);
  // The credential is for our control-plane RPCs only — it is never echoed back.
  assert.equal(JSON.stringify(body).includes('sa-s2s-token'), false);
});
