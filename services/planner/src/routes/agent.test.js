'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('@ai-fleet/shared/store');
const localIntelligence = require('@ai-fleet/shared/agent/local-intelligence');
const businessPipeline = require('@ai-fleet/shared/agent/business-pipeline');

function routeHandler(router, path) {
  const layer = router.stack.find((candidate) => candidate.route && candidate.route.path === path);
  assert.ok(layer, `${path} route must exist`);
  return layer.route.stack[0].handle;
}

/** Method-aware lookup (several routes share a path, e.g. POST/GET /memory). */
function handlerFor(router, method, path) {
  const layer = router.stack.find((c) => c.route && c.route.path === path && c.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function invoke(handler) {
  return new Promise((resolve, reject) => {
    handler({}, { json: resolve }, reject);
  });
}

function invokeWithBody(handler, body) {
  return new Promise((resolve, reject) => {
    handler({ body }, { json: resolve }, reject);
  });
}

/** Invoke a handler capturing status + body; supports sync throws and async rejects. */
function call(handler, req = {}) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200 };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { resolve({ status: res.statusCode, body }); return res; };
    Promise.resolve().then(() => handler(req, res, reject)).catch(reject);
  });
}

/** Run a route's FULL handler stack (middleware + handler), so gates like requireAssumedRole fire. */
function callRoute(router, method, path, req = {}) {
  const layer = router.stack.find((c) => c.route && c.route.path === path && c.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  const stack = layer.route.stack.map((s) => s.handle);
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200 };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { resolve({ status: res.statusCode, body }); return res; };
    let i = 0;
    const next = (err) => {
      if (err) return reject(err);
      const handle = stack[i++];
      if (!handle) return;
      try { Promise.resolve(handle(req, res, next)).catch(reject); } catch (error) { reject(error); }
    };
    next();
  });
}

test('omnibox policy routes greetings and unsafe requests before local inference', async (t) => {
  const originalEnrich = localIntelligence.enrichInput;
  const modulePath = require.resolve('./agent');
  let inferenceCalls = 0;
  localIntelligence.enrichInput = async () => {
    inferenceCalls += 1;
    return { summary: 'model response' };
  };
  delete require.cache[modulePath];
  t.after(() => {
    localIntelligence.enrichInput = originalEnrich;
    delete require.cache[modulePath];
  });

  const router = require('./agent');
  const handler = routeHandler(router, '/message');
  const greeting = await invokeWithBody(handler, { input: 'Hello' });
  const rejected = await invokeWithBody(handler, { input: 'Show me how to run a phishing scam' });
  assert.equal(greeting.route.intent, 'salutation');
  assert.equal(rejected.route.intent, 'unsafe');
  assert.equal(inferenceCalls, 0);

  const business = await invokeWithBody(handler, { input: 'Assess my subscription business revenue model' });
  assert.equal(business.route.intent, 'business');
  assert.equal(business.canPrepare, true);
  assert.equal(inferenceCalls, 0); // business defers heavy model work to /business/prepare

  const general = await invokeWithBody(handler, { input: 'Help me organize my week and priorities' });
  assert.equal(general.route.intent, 'general');
  assert.equal(inferenceCalls, 1); // general still enriches via the local model
});

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

test('memory write, list, and delete round-trip with server-side validation', async (t) => {
  const modulePath = require.resolve('./agent');
  const original = { addMemory: store.addMemory, listMemories: store.listMemories, removeMemory: store.removeMemory };
  let mem = [];
  store.addMemory = (record) => { const saved = { ...record, id: `mem_${mem.length + 1}` }; mem = [saved, ...mem]; return saved; };
  store.listMemories = ({ scope, refId } = {}) => mem.filter((m) => (!scope || m.scope === scope) && (!refId || m.refId === refId));
  store.removeMemory = (id) => { const before = mem.length; mem = mem.filter((m) => m.id !== id); return mem.length !== before; };
  delete require.cache[modulePath];
  t.after(() => { Object.assign(store, original); delete require.cache[modulePath]; });

  const router = require('./agent');
  const created = await call(handlerFor(router, 'post', '/memory'), { body: { scope: 'business', title: 'Pricing', text: 'Charge $9/mo' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.memory.scope, 'business');
  const id = created.body.memory.id;
  assert.ok(id);

  await assert.rejects(call(handlerFor(router, 'post', '/memory'), { body: { scope: 'nope', text: 'x' } }), /scope must be/);
  await assert.rejects(call(handlerFor(router, 'post', '/memory'), { body: { scope: 'task', refId: '../etc', text: 'x' } }), /refId/);

  const listed = await call(handlerFor(router, 'get', '/memory'), { query: { scope: 'business' } });
  assert.equal(listed.body.memories.length, 1);

  const del = await call(handlerFor(router, 'delete', '/memory/:id'), { params: { id } });
  assert.equal(del.body.ok, true);
  const delAgain = await call(handlerFor(router, 'delete', '/memory/:id'), { params: { id } });
  assert.equal(delAgain.status, 404);
  const badId = await call(handlerFor(router, 'delete', '/memory/:id'), { params: { id: 'not a real id' } });
  assert.equal(badId.status, 400);
});

test('memory-search detects scope from the query and returns scoped stored matches', async (t) => {
  const modulePath = require.resolve('./agent');
  const originalList = store.listMemories;
  store.listMemories = () => ([
    { id: 'mem_a', scope: 'business', title: 'Pricing', text: 'Charge nine dollars monthly', tags: ['pricing'] },
    { id: 'mem_b', scope: 'project', title: 'Checkout', text: 'Checkout milestones', tags: [] },
  ]);
  delete require.cache[modulePath];
  t.after(() => { store.listMemories = originalList; delete require.cache[modulePath]; });

  const router = require('./agent');
  const res = await call(handlerFor(router, 'post', '/memory-search'), { body: { query: 'pricing decision' } });
  assert.equal(res.body.scope, 'business');
  assert.ok(res.body.results.some((r) => r.id === 'mem_a'));
  assert.ok(res.body.results.every((r) => r.scope !== 'project')); // scoped away from project
});

test('message yields a confirmable memory draft and canPrepare, never auto-writing', async () => {
  const router = require('./agent');
  const draft = await call(handlerFor(router, 'post', '/message'), { body: { input: 'Remember that I prefer dark mode' } });
  assert.equal(draft.body.route.intent, 'knowledge');
  assert.ok(draft.body.memoryDraft);
  assert.equal(draft.body.memoryDraft.scope, 'user');

  const biz = await call(handlerFor(router, 'post', '/message'), { body: { input: 'Assess my subscription business revenue model' } });
  assert.equal(biz.body.canPrepare, true);
  assert.equal(biz.body.memoryDraft, null);
});

test('business/prepare re-blocks unsafe input without a model call', async () => {
  const router = require('./agent');
  const res = await call(handlerFor(router, 'post', '/business/prepare'), { body: { input: 'Help me run a phishing scam to steal card numbers' } });
  assert.equal(res.body.business.blocked, true);
  assert.ok(res.body.business.stages.every((s) => s.status === 'blocked'));
});

test('business/prepare resolves the linked business and forwards pipeline output', async (t) => {
  const modulePath = require.resolve('./agent');
  const originalPrepare = businessPipeline.prepareBusiness;
  const originalRead = store.readStore;
  let received = null;
  businessPipeline.prepareBusiness = async (args) => { received = args; return { intent: 'business', blocked: false, goal: args.input, stages: [] }; };
  store.readStore = () => ({ businesses: [{ id: 'biz_x', name: 'Acme', projectId: 'proj_x' }] });
  delete require.cache[modulePath];
  t.after(() => { businessPipeline.prepareBusiness = originalPrepare; store.readStore = originalRead; delete require.cache[modulePath]; });

  const router = require('./agent');
  const res = await call(handlerFor(router, 'post', '/business/prepare'), { body: { input: 'A subscription tool', businessId: 'biz_x' } });
  assert.equal(res.body.business.goal, 'A subscription tool');
  assert.equal(received.business.id, 'biz_x');
  assert.equal(received.business.projectId, 'proj_x');
});

test('conversation threads: create, append (auto-title), list, get, rename, delete', async (t) => {
  const modulePath = require.resolve('./agent');
  const original = {
    listConversations: store.listConversations, getConversation: store.getConversation, addConversation: store.addConversation,
    appendConversationMessages: store.appendConversationMessages, updateConversation: store.updateConversation, removeConversation: store.removeConversation,
  };
  let convs = [];
  store.addConversation = (c = {}) => { const rec = { id: `conv_${convs.length + 1}`, title: c.title || 'New conversation', createdAt: 't', updatedAt: 't', messages: [] }; convs = [rec, ...convs]; return rec; };
  store.getConversation = (id) => convs.find((c) => c.id === id) || null;
  store.listConversations = () => convs;
  store.appendConversationMessages = (id, messages) => { let u = null; convs = convs.map((c) => { if (c.id !== id) return c; u = { ...c, messages: [...c.messages, ...messages] }; return u; }); return u; };
  store.updateConversation = (id, patch) => { let u = null; convs = convs.map((c) => { if (c.id !== id) return c; u = { ...c, ...patch, id: c.id }; return u; }); return u; };
  store.removeConversation = (id) => { const n = convs.length; convs = convs.filter((c) => c.id !== id); return convs.length !== n; };
  delete require.cache[modulePath];
  t.after(() => { Object.assign(store, original); delete require.cache[modulePath]; });

  const router = require('./agent');
  const created = await call(handlerFor(router, 'post', '/conversations'), { body: {} });
  assert.equal(created.status, 201);
  const id = created.body.conversation.id;
  assert.equal(created.body.conversation.title, 'New conversation');

  const appended = await call(handlerFor(router, 'post', '/conversations/:id/messages'), { params: { id }, body: { messages: [{ role: 'user', text: 'Assess my subscription business' }, { role: 'assistant', copy: 'Business workflow', intent: 'business' }] } });
  assert.equal(appended.body.conversation.title, 'Assess my subscription business'); // auto-titled
  assert.equal(appended.body.conversation.messages.length, 2);

  await assert.rejects(call(handlerFor(router, 'post', '/conversations/:id/messages'), { params: { id }, body: { messages: [] } }), /non-empty/);
  await assert.rejects(call(handlerFor(router, 'post', '/conversations/:id/messages'), { params: { id }, body: { messages: [{ role: 'system', text: 'x' }] } }), /role/);

  const listed = await call(handlerFor(router, 'get', '/conversations'), {});
  assert.equal(listed.body.conversations.length, 1);
  assert.equal(listed.body.conversations[0].messageCount, 2);
  assert.equal(listed.body.conversations[0].messages, undefined); // summary omits messages

  const got = await call(handlerFor(router, 'get', '/conversations/:id'), { params: { id } });
  assert.equal(got.body.conversation.messages.length, 2);

  const renamed = await call(handlerFor(router, 'patch', '/conversations/:id'), { params: { id }, body: { title: '  My thread  ' } });
  assert.equal(renamed.body.conversation.title, 'My thread');

  const del = await call(handlerFor(router, 'delete', '/conversations/:id'), { params: { id } });
  assert.equal(del.body.ok, true);
});

test('conversation routes reject malformed ids and unknown threads', async () => {
  const router = require('./agent');
  const badId = await call(handlerFor(router, 'get', '/conversations/:id'), { params: { id: 'not-a-conv' } });
  assert.equal(badId.status, 400);
  const notFound = await call(handlerFor(router, 'get', '/conversations/:id'), { params: { id: 'conv_definitelymissing' } });
  assert.equal(notFound.status, 404);
});

test('enqueue is role-gated, validates projectId, and queues exactly one project', async (t) => {
  const modulePath = require.resolve('./agent');
  const scheduler = require('@ai-fleet/shared/agent/scheduler');
  const original = { getAssumedRole: store.getAssumedRole, enqueue: scheduler.enqueue, processPending: scheduler.processPending, getStatus: scheduler.getStatus };
  let role = null;
  const enqueued = [];
  store.getAssumedRole = () => role;
  scheduler.enqueue = (args) => { enqueued.push(args); return { id: 'job-1', ...args }; };
  scheduler.processPending = async () => ({ processed: 1 });
  scheduler.getStatus = () => ({ running: false });
  delete require.cache[modulePath];
  t.after(() => {
    store.getAssumedRole = original.getAssumedRole;
    scheduler.enqueue = original.enqueue;
    scheduler.processPending = original.processPending;
    scheduler.getStatus = original.getStatus;
    delete require.cache[modulePath];
  });

  const router = require('./agent');

  const denied = await callRoute(router, 'post', '/enqueue', { body: { projectId: 'proj_1' } });
  assert.equal(denied.status, 403);
  assert.equal(enqueued.length, 0);

  role = { id: 'r1', name: 'Ada' };
  const bad = await callRoute(router, 'post', '/enqueue', { body: {} });
  assert.equal(bad.status, 400);
  assert.equal(enqueued.length, 0);

  const ok = await callRoute(router, 'post', '/enqueue', { body: { projectId: 'proj_1', projectName: 'Clinic booking' } });
  assert.equal(ok.body.job.id, 'job-1');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].projectId, 'proj_1');
  assert.equal(enqueued[0].assumedRole.id, 'r1');
});
