'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('@ai-fleet/shared/store');
const attachmentsService = require('@ai-fleet/shared/attachments/service');
const llm = require('@ai-fleet/shared/agent/llm');

function handlerFor(router, method, path) {
  const layer = router.stack.find((c) => c.route && c.route.path === path && c.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
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

const selectedHeaders = {
  get(name) {
    return { 'x-ai-fleet-organization-id': 'org-a', 'x-ai-fleet-project-id': 'project-a' }[name];
  },
};

const CONV = { id: 'conv_1', orgId: 'org-a', nativeProjectId: 'project-a', title: 'T', messages: [] };

function freshRouter(t, { getConversation = () => CONV, service = {}, llmOverrides = {} } = {}) {
  const modulePath = require.resolve('./agent-attachments');
  const originalGetConversation = store.getConversation;
  const originalService = { ...attachmentsService };
  const originalLlm = { resolveLlm: llm.resolveLlm, createChatModel: llm.createChatModel };

  store.getConversation = getConversation;
  Object.assign(attachmentsService, service);
  Object.assign(llm, llmOverrides);

  delete require.cache[modulePath];
  t.after(() => {
    store.getConversation = originalGetConversation;
    Object.assign(attachmentsService, originalService);
    Object.assign(llm, originalLlm);
    delete require.cache[modulePath];
  });

  return require('./agent-attachments');
}

test('GET /attachment-types is a pure passthrough of the canonical table', async (t) => {
  const router = freshRouter(t);
  const result = await call(handlerFor(router, 'get', '/attachment-types'));
  assert.ok(result.body.types.pdf);
  assert.equal(result.body.maxBytes, 20 * 1024 * 1024);
});

test('mint/complete/list/delete all reject when org or project context is missing', async (t) => {
  const router = freshRouter(t, { service: { mintUpload: async () => ({}) } });
  const noHeaders = { params: { id: 'conv_1' }, body: {} };

  const mint = await call(handlerFor(router, 'post', '/conversations/:id/attachments'), noHeaders);
  assert.equal(mint.status, 400);
  assert.match(mint.body.error, /organization and project/);

  const complete = await call(handlerFor(router, 'post', '/conversations/:id/attachments/:attachmentId/complete'), { params: { id: 'conv_1', attachmentId: 'att_12345678' } });
  assert.equal(complete.status, 400);

  const list = await call(handlerFor(router, 'get', '/conversations/:id/attachments'), { params: { id: 'conv_1' } });
  assert.equal(list.status, 400);

  const del = await call(handlerFor(router, 'delete', '/conversations/:id/attachments/:attachmentId'), { params: { id: 'conv_1', attachmentId: 'att_12345678' } });
  assert.equal(del.status, 400);
});

test('routes reject an unknown/foreign conversation even with valid org/project headers', async (t) => {
  const router = freshRouter(t, { getConversation: () => null });
  const result = await call(handlerFor(router, 'post', '/conversations/:id/attachments'), {
    ...selectedHeaders,
    params: { id: 'conv_1' },
    body: { filename: 'a.pdf', mimeType: 'application/pdf', size: 10 },
  });
  assert.equal(result.status, 404);
});

test('a conversation that exists but belongs to a different org is 404, not 403 (no existence oracle)', async (t) => {
  // The conversation is real (org-b), but the caller's validated context is org-a.
  const foreignConv = { id: 'conv_1', orgId: 'org-b', nativeProjectId: 'project-b', title: 'T', messages: [] };
  const router = freshRouter(t, {
    getConversation: (id) => (id === foreignConv.id ? foreignConv : null),
    service: {
      mintUpload: async () => ({ attachmentId: 'att_x' }),
      listAttachments: async () => [],
      removeAttachment: async () => {},
    },
  });
  const reqFor = (extra) => ({ ...selectedHeaders, params: { id: foreignConv.id, attachmentId: 'att_12345678' }, ...extra });

  const mint = await call(handlerFor(router, 'post', '/conversations/:id/attachments'), reqFor({ body: { filename: 'a.pdf', mimeType: 'application/pdf', size: 10 } }));
  assert.equal(mint.status, 404);

  const list = await call(handlerFor(router, 'get', '/conversations/:id/attachments'), reqFor({}));
  assert.equal(list.status, 404);

  const del = await call(handlerFor(router, 'delete', '/conversations/:id/attachments/:attachmentId'), reqFor({}));
  assert.equal(del.status, 404);
});

test('mint validates the conversation id shape before touching the service', async (t) => {
  const router = freshRouter(t);
  const result = await call(handlerFor(router, 'post', '/conversations/:id/attachments'), {
    ...selectedHeaders,
    params: { id: 'not-a-conv' },
    body: {},
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Invalid conversation id/);
});

test('mint forwards org/project/conversation and body fields to the service, and returns 201', async (t) => {
  let captured = null;
  const router = freshRouter(t, {
    service: {
      mintUpload: async (args) => { captured = args; return { attachmentId: 'att_x', uploadUrl: 'https://x', gcsPath: 'p', expiresAt: 't' }; },
    },
  });
  const result = await call(handlerFor(router, 'post', '/conversations/:id/attachments'), {
    ...selectedHeaders,
    params: { id: 'conv_1' },
    body: { filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.attachmentId, 'att_x');
  assert.deepEqual(captured, {
    orgId: 'org-a',
    projectId: 'project-a',
    conversationId: 'conv_1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    size: 2048,
  });
});

test('complete rejects a malformed attachment id before touching the service', async (t) => {
  const router = freshRouter(t);
  const result = await call(handlerFor(router, 'post', '/conversations/:id/attachments/:attachmentId/complete'), {
    ...selectedHeaders,
    params: { id: 'conv_1', attachmentId: 'not-valid' },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Invalid attachment id/);
});

test('complete forwards ids to the service and returns its result', async (t) => {
  let captured = null;
  const router = freshRouter(t, {
    service: { completeUpload: async (ids) => { captured = ids; return { attachmentId: ids.attachmentId, status: 'ready' }; } },
  });
  const result = await call(handlerFor(router, 'post', '/conversations/:id/attachments/:attachmentId/complete'), {
    ...selectedHeaders,
    params: { id: 'conv_1', attachmentId: 'att_12345678' },
  });
  assert.equal(result.body.attachment.status, 'ready');
  assert.equal(captured.attachmentId, 'att_12345678');
  assert.equal(captured.orgId, 'org-a');
});

test('list and delete forward to the service correctly', async (t) => {
  let listedIds = null;
  let deletedIds = null;
  const router = freshRouter(t, {
    service: {
      listAttachments: async (ids) => { listedIds = ids; return [{ attachmentId: 'att_1' }]; },
      removeAttachment: async (ids) => { deletedIds = ids; },
    },
  });

  const listed = await call(handlerFor(router, 'get', '/conversations/:id/attachments'), { ...selectedHeaders, params: { id: 'conv_1' } });
  assert.equal(listed.body.attachments.length, 1);
  assert.equal(listedIds.conversationId, 'conv_1');

  const deleted = await call(handlerFor(router, 'delete', '/conversations/:id/attachments/:attachmentId'), {
    ...selectedHeaders,
    params: { id: 'conv_1', attachmentId: 'att_12345678' },
  });
  assert.equal(deleted.body.ok, true);
  assert.equal(deletedIds.attachmentId, 'att_12345678');
});

test('search returns [] without calling the service for an empty query, and maps/bounds results otherwise', async (t) => {
  let searchCalls = 0;
  const router = freshRouter(t, {
    service: {
      searchAttachments: async () => { searchCalls += 1; return [{ attachmentId: 'att_1', filename: 'a.pdf', text: 'y'.repeat(500) }]; },
    },
  });

  const empty = await call(handlerFor(router, 'get', '/conversations/:id/attachments/search'), { ...selectedHeaders, params: { id: 'conv_1' }, query: { q: '  ' } });
  assert.deepEqual(empty.body.results, []);
  assert.equal(searchCalls, 0);

  const found = await call(handlerFor(router, 'get', '/conversations/:id/attachments/search'), { ...selectedHeaders, params: { id: 'conv_1' }, query: { q: 'revenue' } });
  assert.equal(searchCalls, 1);
  assert.equal(found.body.results[0].snippet.length, 400);
});

test('ask returns a friendly no-attachments message and never calls the LLM when nothing is retrieved', async (t) => {
  let llmCalled = false;
  const router = freshRouter(t, {
    service: { searchAttachments: async () => [] },
    llmOverrides: { resolveLlm: async () => { llmCalled = true; return { provider: 'antigravity' }; } },
  });
  const result = await call(handlerFor(router, 'post', '/conversations/:id/attachments/ask'), {
    ...selectedHeaders,
    params: { id: 'conv_1' },
    body: { question: 'what does the report say?' },
  });
  assert.match(result.body.answer, /couldn't find anything/);
  assert.deepEqual(result.body.citations, []);
  assert.equal(llmCalled, false);
});

test('ask rejects an empty question before touching the service', async (t) => {
  const router = freshRouter(t);
  const result = await call(handlerFor(router, 'post', '/conversations/:id/attachments/ask'), {
    ...selectedHeaders,
    params: { id: 'conv_1' },
    body: { question: '   ' },
  });
  assert.equal(result.status, 400);
});

test('ask returns 400 when no thinking model is configured', async (t) => {
  const router = freshRouter(t, {
    service: { searchAttachments: async () => [{ attachmentId: 'att_1', filename: 'a.pdf', text: 'x' }] },
    llmOverrides: { resolveLlm: async () => null },
  });
  const result = await call(handlerFor(router, 'post', '/conversations/:id/attachments/ask'), {
    ...selectedHeaders,
    params: { id: 'conv_1' },
    body: { question: 'what does the report say?' },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /No thinking model/);
});

test('ask assembles retrieved excerpts into the model prompt and returns a bounded, cited answer', async (t) => {
  let invokedMessages = null;
  const fakeModel = {
    invoke: async (messages) => { invokedMessages = messages; return { content: 'The report says revenue grew 12%. [1]' }; },
  };
  const router = freshRouter(t, {
    service: {
      searchAttachments: async () => [
        { attachmentId: 'att_1', filename: 'revenue.pdf', text: 'Q3 revenue grew 12% year over year.' },
      ],
    },
    llmOverrides: {
      resolveLlm: async () => ({ provider: 'antigravity' }),
      createChatModel: () => fakeModel,
    },
  });
  const result = await call(handlerFor(router, 'post', '/conversations/:id/attachments/ask'), {
    ...selectedHeaders,
    params: { id: 'conv_1' },
    body: { question: 'how did revenue do?' },
  });
  assert.equal(result.body.answer, 'The report says revenue grew 12%. [1]');
  assert.equal(result.body.citations.length, 1);
  assert.equal(result.body.citations[0].filename, 'revenue.pdf');
  assert.match(invokedMessages[1][1], /Q3 revenue grew 12%/);
  assert.match(invokedMessages[1][1], /how did revenue do\?/);
});
