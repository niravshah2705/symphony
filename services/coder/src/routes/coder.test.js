'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runTicketModule = require('../run-ticket');
const orchestrator = require('@ai-fleet/shared/agent/coder-orchestrator');

function postHandler(router, path) {
  const layer = router.stack.find((candidate) => candidate.route
    && candidate.route.path === path
    && candidate.route.methods.post);
  assert.ok(layer, `POST ${path} route must exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200 };
    res.status = (statusCode) => { res.statusCode = statusCode; return res; };
    res.json = (body) => { resolve({ status: res.statusCode, body }); return res; };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

function routeHandler(router, path, method) {
  const layer = router.stack.find((candidate) => candidate.route
    && candidate.route.path === path
    && candidate.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  return layer.route.stack.at(-1).handle;
}

test('manual coder route forwards the gateway-validated organization and native project', async (t) => {
  const original = runTicketModule.runTicket;
  const modulePath = require.resolve('./coder');
  let received;
  runTicketModule.runTicket = async (input) => {
    received = input;
    return { accepted: true };
  };
  delete require.cache[modulePath];
  t.after(() => {
    runTicketModule.runTicket = original;
    delete require.cache[modulePath];
  });

  const router = require('./coder');
  const handler = postHandler(router, '/run');
  const response = await invoke(handler, {
    body: { issueId: 'issue-1', conversationId: 'conversation-1' },
    get(name) {
      return {
        'x-ai-fleet-organization-id': 'org-1',
        'x-ai-fleet-project-id': 'native-project-1',
      }[name];
    },
  });

  assert.equal(response.status, 202);
  assert.deepEqual(received, {
    issueId: 'issue-1',
    conversationId: 'conversation-1',
    orgId: 'org-1',
    nativeProjectId: 'native-project-1',
  });
});

test('coder status and monitor lifecycle use the exact selected context', async (t) => {
  const original = {
    status: orchestrator.status,
    start: orchestrator.start,
    resume: orchestrator.resume,
    stop: orchestrator.stop,
  };
  const calls = [];
  for (const action of Object.keys(original)) {
    orchestrator[action] = (context) => {
      calls.push({ action, context });
      return { action };
    };
  }
  const modulePath = require.resolve('./coder');
  delete require.cache[modulePath];
  t.after(() => {
    Object.assign(orchestrator, original);
    delete require.cache[modulePath];
  });
  const headers = {
    'x-ai-fleet-organization-id': 'org-selected',
    'x-ai-fleet-project-id': 'project-selected',
  };
  const request = (body = {}) => ({
    body,
    get: (name) => headers[String(name).toLowerCase()],
  });
  const router = require('./coder');

  await invoke(routeHandler(router, '/', 'get'), request());
  for (const action of ['start', 'resume', 'stop']) {
    await invoke(routeHandler(router, '/monitor', 'post'), request({ action }));
  }

  assert.deepEqual(calls, ['status', 'start', 'resume', 'stop'].map((action) => ({
    action,
    context: { organizationId: 'org-selected', projectId: 'project-selected' },
  })));
});
