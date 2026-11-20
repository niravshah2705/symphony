'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SUBSTRATE_PATH = require.resolve('@software-factory/shared/agent/substrate');
const RUNNER_PATH = require.resolve('@software-factory/shared/agent/substrate-runner');
const ROUTER_PATH = require.resolve('./agent');

const store = require('@software-factory/shared/store');

/**
 * Replace the ateapi client with a fake so the route can be exercised without a
 * cluster. Returns a restore fn.
 */
function stubSubstrate({ connected, actors, token = 'sa-projected-token', runCapture, exists = true }) {
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
      // The three card verbs, plus the existence probe that runs before them. Each
      // records the options it received so a test can assert the atespace came from
      // the server-side resolution and not from the query string.
      getActorStatus: async (opts) => {
        calls.probe = opts;
        return exists ? { metadata: { name: opts.name }, status: { state: 'RUNNING' } } : null;
      },
      suspendActor: async (opts) => {
        calls.suspend = opts;
        return { metadata: { name: opts.name }, status: { state: 'SUSPENDED' } };
      },
      resumeActor: async (opts) => {
        calls.resume = opts;
        return { actor: { metadata: { name: opts.name }, status: { state: 'RUNNING' } }, resumed: true };
      },
      deleteActor: async (opts) => {
        calls.remove = opts;
        return { deleted: true };
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

// Express-shaped request: the route reads a header through req.get(), so a bare
// `headers` object is not enough to exercise it.
function fakeReq({ query = {}, body = {}, headers = {}, params = {} } = {}) {
  return {
    query,
    body,
    params,
    headers,
    get(name) {
      const want = String(name).toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === want) return value;
      }
      return undefined;
    },
  };
}

function invoke(handler, req = fakeReq()) {
  return new Promise((resolve, reject) => {
    handler(req, { json: resolve }, reject);
  });
}

// For the handlers that answer with a status code rather than a bare 200 body:
// captures both halves, because the code is the assertion in those tests.
function invokeRes(handler, req = fakeReq()) {
  return new Promise((resolve, reject) => {
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode || 200, body }); },
    };
    handler(req, res, reject);
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
    fakeReq({ body: { prompt: 'plan it' } }),
  );
  assert.match(paths[0], /\/api\/v1\/internal\/s2s\/(managed-secrets|orgs\/)/);
  assert.equal(passed.substrateApiToken, 'sa-s2s-token');
  assert.equal(body.ok, true);
  // The credential is for our control-plane RPCs only — it is never echoed back.
  assert.equal(JSON.stringify(body).includes('sa-s2s-token'), false);
});

// The gateway pins the caller's workspace into x-ai-fleet-organization-id, and the
// substrate routes used to let ?organizationId= / body.organizationId OVERRIDE it.
// One line of that is a cross-tenant control-plane call: atespace resolution, actor
// creation and credential sync all follow the organizationId this function returns.
// A disagreement is answered as if the other tenant did not exist (404, not 403).
test('substrate routes refuse a body organization that contradicts the pinned context', async (t) => {
  const stub = stubSubstrate({ connected: true });
  t.after(stub.restore);
  const handler = handlerFor(stub.router, 'get', '/substrate/status');
  for (const req of [
    { query: { organizationId: 'org-victim' }, body: {}, headers: { 'x-ai-fleet-organization-id': 'org-caller' } },
    // A project id is only a validated context once an organization came with it.
    { query: { projectId: 'proj-victim' }, body: {}, headers: { 'x-ai-fleet-organization-id': 'org-caller', 'x-ai-fleet-project-id': 'proj-caller' } },
  ]) {
    await assert.rejects(() => invoke(handler, req), (err) => {
      assert.equal(err.status, 404, 'a contradicted tenant must not be reported as forbidden');
      assert.equal(err.message, 'context_not_found');
      return true;
    });
  }
  assert.equal(stub.calls.listActors, 0, 'the refused call must not reach the control plane');
});

test('substrate routes serve the organization the context pins', async (t) => {
  const stub = stubSubstrate({ connected: true });
  t.after(stub.restore);
  const body = await invoke(handlerFor(stub.router, 'get', '/substrate/status'), {
    query: { organizationId: 'org-caller' },
    body: {},
    headers: { 'x-ai-fleet-organization-id': 'org-caller', 'x-ai-fleet-project-id': 'proj-caller' },
  });
  assert.equal(body.configured, true);
  assert.equal(stub.calls.listActors, 1);
});

// Auth-disabled and local installs send no selection headers, so the body value is
// the only tenant signal there. Refusing it would break the local profile; it also
// carries no cross-tenant risk because that profile serves one workspace.
test('substrate routes still honor a body organization when nothing is pinned', async (t) => {
  const stub = stubSubstrate({ connected: true });
  t.after(stub.restore);
  const body = await invoke(handlerFor(stub.router, 'get', '/substrate/status'), {
    query: {}, body: { organizationId: 'org-local' }, headers: {},
  });
  assert.equal(body.configured, true);
});

// The actor cards post suspend/resume/delete here. Each verb is a control-plane
// write, so it must resolve its namespace the same way the read does: from the
// pinned context. A name alone is not a scope — the ObjectRef is (atespace, name),
// and the atespace half has to stay server-side.
const VERBS = [
  ['post', '/substrate/actors/:name/suspend', 'suspend'],
  ['post', '/substrate/actors/:name/resume', 'resume'],
  ['delete', '/substrate/actors/:name', 'delete'],
];

test('every actor verb takes its atespace from the pinned context, never the query', async (t) => {
  for (const [method, path, action] of VERBS) {
    const stub = stubSubstrate({ connected: true });
    t.after(stub.restore);
    await assert.rejects(() => invoke(
      handlerFor(stub.router, method, path),
      fakeReq({
        params: { name: 'plan-p-1' },
        query: { atespace: 'tenant-victim' },
        headers: { 'x-ai-fleet-organization-id': 'org-caller' },
      }),
    ), (err) => {
      assert.equal(err.status, 404, `${action}: a contradicted namespace is answered as absent`);
      assert.equal(err.message, 'context_not_found', `${action}: no existence oracle for other tenants`);
      return true;
    });
    assert.equal(stub.calls.suspend, undefined, `${action}: refused before reaching ateapi`);
    assert.equal(stub.calls.resume, undefined, `${action}: refused before reaching ateapi`);
    assert.equal(stub.calls.remove, undefined, `${action}: refused before reaching ateapi`);
  }
});

test('an actor verb serves the resolved namespace and reports the resulting state', async (t) => {
  const stub = stubSubstrate({ connected: true });
  t.after(stub.restore);
  const { atespace } = await invoke(handlerFor(stub.router, 'get', '/substrate/status'), fakeReq());
  const body = await invoke(
    handlerFor(stub.router, 'post', '/substrate/actors/:name/suspend'),
    fakeReq({ params: { name: 'plan-p1-9f0a' } }),
  );
  assert.equal(body.ok, true);
  assert.equal(body.action, 'suspend');
  assert.equal(body.state, 'SUSPENDED');
  assert.equal(body.atespace, atespace, 'the verb acts in the same namespace the list came from');
  assert.equal(stub.calls.suspend.name, 'plan-p1-9f0a');
  assert.equal(stub.calls.suspend.atespace, atespace);
  // The projected service-account token is threaded per call, not cached at startup.
  assert.equal(stub.calls.suspend.token, 'sa-projected-token');
});

test('an actor verb refuses a name the control plane cannot hold', async (t) => {
  const stub = stubSubstrate({ connected: true });
  t.after(stub.restore);
  for (const name of ['', 'Plan-P1', 'plan_p1', '-lead', 'trail-', 'x'.repeat(41), '../etc/passwd']) {
    const res = await invokeRes(
      handlerFor(stub.router, 'post', '/substrate/actors/:name/suspend'),
      fakeReq({ params: { name } }),
    );
    assert.equal(res.status, 400, `${JSON.stringify(name)} must be rejected before any RPC`);
    assert.equal(res.body.error, 'actor_name_invalid');
  }
  assert.equal(stub.calls.probe, undefined, 'a malformed name never reaches the existence probe');
});

test('an actor verb reports an absent actor as 404 rather than acting on it', async (t) => {
  const stub = stubSubstrate({ connected: true, exists: false });
  t.after(stub.restore);
  const res = await invokeRes(
    handlerFor(stub.router, 'delete', '/substrate/actors/:name'),
    fakeReq({ params: { name: 'plan-gone' } }),
  );
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'context_not_found');
  assert.equal(stub.calls.remove, undefined, 'delete must not be attempted for an actor that is not there');
});

test('an actor verb answers 409 when no credential resolves rather than trying anonymously', async (t) => {
  const stub = stubSubstrate({ connected: true, token: '' });
  t.after(stub.restore);
  const res = await invokeRes(
    handlerFor(stub.router, 'post', '/substrate/actors/:name/resume'),
    fakeReq({ params: { name: 'plan-p1' } }),
  );
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'substrate_not_configured');
  assert.equal(stub.calls.resume, undefined);
});

test('delete reports the control plane\'s deletion result, resume unwraps the actor', async (t) => {
  const del = stubSubstrate({ connected: true });
  t.after(del.restore);
  const deleted = await invoke(
    handlerFor(del.router, 'delete', '/substrate/actors/:name'),
    fakeReq({ params: { name: 'plan-p1' } }),
  );
  assert.equal(deleted.deleted, true, 'the UI keys its confirmation on this');
  assert.equal(deleted.state, null);

  const res = stubSubstrate({ connected: true });
  t.after(res.restore);
  const resumed = await invoke(
    handlerFor(res.router, 'post', '/substrate/actors/:name/resume'),
    fakeReq({ params: { name: 'plan-p1' } }),
  );
  assert.equal(resumed.state, 'RUNNING', 'ResumeActor answers { actor }, not the actor itself');
});

// A status list is only as scoped as the identity behind it: the project filter is
// a display refinement inside the tenant's own namespace, so a project id from
// another tenant can only ever yield an empty list, never another tenant's actors.
test('the project filter narrows the list by the name token and echoes what it matched', async (t) => {
  const stub = stubSubstrate({
    connected: true,
    actors: [
      { metadata: { name: 'plan-p-1-aabb' }, status: { state: 'RUNNING' } },
      { metadata: { name: 'plan-other-ccdd' }, status: { state: 'SUSPENDED' } },
    ],
  });
  t.after(stub.restore);
  const body = await invoke(handlerFor(stub.router, 'get', '/substrate/status'), {
    query: { projectId: 'p 1' }, body: {}, headers: {}, params: {},
  });
  const prefix = `plan-${require(SUBSTRATE_PATH).actorProjectToken('p 1')}-`;
  assert.equal(body.projectFilter.namePrefix, prefix);
  assert.deepEqual(body.actors.map((a) => a.name), ['plan-p-1-aabb']);
});
