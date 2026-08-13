'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toPushEnvelope } = require('@ai-fleet/shared/messaging/publisher');
const { currentWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');
const runTicketModule = require('./run-ticket');

function coderHandler(router) {
  const layer = router.stack.find((candidate) => candidate.route && candidate.route.path === '/coder');
  assert.ok(layer, 'POST /coder route must exist');
  return layer.route.stack.at(-1).handle;
}

function invoke(handler, message) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200 };
    res.status = (code) => { res.statusCode = code; return res; };
    res.end = () => { resolve(res.statusCode); return res; };
    Promise.resolve(handler({ body: toPushEnvelope(message) }, res)).catch(reject);
  });
}

test('coder Pub/Sub binds concurrent decoded contexts for the full async dispatch', async (t) => {
  const modulePath = require.resolve('./pubsub');
  const original = runTicketModule.runTicket;
  const received = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  runTicketModule.runTicket = async (input) => {
    await new Promise((resolve) => setImmediate(resolve));
    received.push({ input, context: currentWorkspaceContext() });
    if (received.length === 2) finish();
    return { accepted: true };
  };
  delete require.cache[modulePath];
  t.after(() => {
    runTicketModule.runTicket = original;
    delete require.cache[modulePath];
  });

  const router = require('./pubsub');
  const handler = coderHandler(router);
  await Promise.all([
    invoke(handler, {
      issueId: 'issue-a', conversationId: 'conversation-a',
      orgId: 'org-a', nativeProjectId: 'project-a',
    }),
    invoke(handler, {
      issueId: 'issue-b', conversationId: 'conversation-b',
      orgId: 'org-b', nativeProjectId: 'project-b',
    }),
  ]);
  await finished;

  received.sort((a, b) => a.context.organizationId.localeCompare(b.context.organizationId));
  assert.deepEqual(received, [
    {
      input: {
        issueId: 'issue-a', conversationId: 'conversation-a',
        orgId: 'org-a', nativeProjectId: 'project-a',
      },
      context: { organizationId: 'org-a', projectId: 'project-a' },
    },
    {
      input: {
        issueId: 'issue-b', conversationId: 'conversation-b',
        orgId: 'org-b', nativeProjectId: 'project-b',
      },
      context: { organizationId: 'org-b', projectId: 'project-b' },
    },
  ]);
});

test('coder Pub/Sub missing context retains the legacy empty workspace', async (t) => {
  const modulePath = require.resolve('./pubsub');
  const original = runTicketModule.runTicket;
  let observed;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  runTicketModule.runTicket = async () => {
    observed = currentWorkspaceContext();
    finish();
    return { accepted: true };
  };
  delete require.cache[modulePath];
  t.after(() => {
    runTicketModule.runTicket = original;
    delete require.cache[modulePath];
  });

  const router = require('./pubsub');
  const status = await invoke(coderHandler(router), { issueId: 'issue-local' });
  await finished;
  assert.equal(status, 204);
  assert.deepEqual(observed, { organizationId: '', projectId: '' });
});

test('coder autonomous ticks fail closed only on an unpinned shared cloud runtime', () => {
  const { shouldRunAutonomousTick, dispatchCoderTick } = require('./pubsub');
  const empty = { organizationId: '', projectId: '' };
  const selected = { organizationId: 'org-a', projectId: 'project-a' };
  assert.equal(shouldRunAutonomousTick(empty, {
    messagingMode: 'pubsub', pinnedOrganizationId: '',
  }), false);
  assert.equal(shouldRunAutonomousTick(selected, {
    messagingMode: 'pubsub', pinnedOrganizationId: '',
  }), true);
  assert.equal(shouldRunAutonomousTick(empty, {
    messagingMode: 'pubsub', pinnedOrganizationId: 'org-pinned',
  }), true);
  assert.equal(shouldRunAutonomousTick(empty, {
    messagingMode: 'direct', pinnedOrganizationId: '',
  }), true);
  assert.equal(shouldRunAutonomousTick(selected, {
    messagingMode: 'pubsub', pinnedOrganizationId: 'org-pinned', orchestratorEnabled: true,
  }), false, 'orchestrator rollout disables the legacy label poller');

  let autonomousRuns = 0;
  const result = dispatchCoderTick(empty, {
    pollOnce: () => { autonomousRuns += 1; },
    logImpl: { error() {}, warn() {} },
    messagingMode: 'pubsub',
    pinnedOrganizationId: '',
  });
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.deepEqual(result, { autonomous: false });
    assert.equal(autonomousRuns, 0, 'board polling must not run without context');
  });
});

test('coder orchestrator rollout suppresses autonomous polling', async () => {
  const { dispatchCoderTick } = require('./pubsub');
  let autonomousRuns = 0;
  const result = dispatchCoderTick({ organizationId: 'org-a', projectId: 'project-a' }, {
    pollOnce: () => { autonomousRuns += 1; },
    logImpl: { error() {}, warn() {} },
    messagingMode: 'pubsub',
    pinnedOrganizationId: 'org-a',
    orchestratorEnabled: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result, { autonomous: false });
  assert.equal(autonomousRuns, 0);
});
