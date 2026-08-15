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

function invoke(handler, body = {}) {
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

function withRouter(t) {
  const originalGet = store.getSettings;
  const originalPatch = store.patchSettings;
  const patches = [];
  const state = {
    ...originalGet(),
    linearApiKey: 'legacy-linear-plaintext',
    githubToken: 'legacy-github-plaintext',
    jiraApiToken: 'legacy-jira-plaintext',
  };
  store.getSettings = () => state;
  store.patchSettings = (patch) => { patches.push(patch); Object.assign(state, patch); return state; };
  const modulePath = require.resolve('./settings');
  delete require.cache[modulePath];
  const router = require('./settings');
  t.after(() => {
    store.getSettings = originalGet;
    store.patchSettings = originalPatch;
    delete require.cache[modulePath];
  });
  return { router, patches };
}

test('public planner settings never derive credential state from legacy plaintext store fields', async (t) => {
  const { router } = withRouter(t);
  const response = await invoke(routeHandler(router, 'get', '/'));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.hasKey, false);
  assert.equal(response.body.hasGithubToken, false);
  assert.equal(response.body.hasJiraToken, false);
  assert.equal(JSON.stringify(response.body).includes('legacy-'), false);
});

test('legacy planner credential routes and integration fields fail explicitly without writes', async (t) => {
  const { router, patches } = withRouter(t);
  const cases = [
    ['put', '/', { linearApiKey: 'lin_new' }],
    ['put', '/github', { githubToken: 'gh_new' }],
    ['put', '/langsmith', { langsmithApiKey: 'ls_new' }],
    ['put', '/integrations', { gitlabToken: 'gl_new' }],
    ['put', '/integrations', { jiraBaseUrl: 'https://acme.atlassian.net' }],
    ['put', '/json', { settings: { llmStreamRetries: 2, linearApiKey: 'lin_new' } }],
  ];
  for (const [method, path, body] of cases) {
    const response = await invoke(routeHandler(router, method, path), body);
    assert.equal(response.statusCode, 400, `${method.toUpperCase()} ${path}`);
    assert.match(response.body.error, /vault|connectors/i);
  }
  assert.deepEqual(patches, []);
});

test('planner integration route still accepts non-secret provider and repository choices', async (t) => {
  const { router, patches } = withRouter(t);
  const response = await invoke(routeHandler(router, 'put', '/integrations'), {
    planningProvider: 'jira',
    repositoryProvider: 'gitlab',
    repositoryUrl: 'group/project',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(patches, [{
    planningProvider: 'jira',
    repositoryProvider: 'gitlab',
    repositoryUrl: 'group/project',
  }]);
});
