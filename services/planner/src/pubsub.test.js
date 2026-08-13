'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('@ai-fleet/shared/agent/scheduler');
const events = require('@ai-fleet/shared/messaging/events');
const { toPushEnvelope } = require('@ai-fleet/shared/messaging/publisher');
const { currentWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');

function plannerHandler(router) {
  const layer = router.stack.find((candidate) => candidate.route && candidate.route.path === '/planner');
  assert.ok(layer, 'POST /planner route must exist');
  return layer.route.stack.at(-1).handle;
}

function invoke(handler, message) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200 };
    res.status = (code) => { res.statusCode = code; return res; };
    res.end = () => { resolve(res.statusCode); return res; };
    try {
      handler({ body: toPushEnvelope(message) }, res);
    } catch (error) {
      reject(error);
    }
  });
}

test('planner Pub/Sub scopes every conversation event to the native workspace context', async (t) => {
  const modulePath = require.resolve('./pubsub');
  const original = {
    enqueue: scheduler.enqueue,
    processPending: scheduler.processPending,
    publishEvent: events.publishEvent,
  };
  const enqueued = [];
  const published = [];
  scheduler.enqueue = (job) => {
    enqueued.push(job);
    return { id: 'job-1', ...job };
  };
  scheduler.processPending = async () => ({ processed: 1 });
  events.publishEvent = (...args) => published.push(args);
  delete require.cache[modulePath];
  t.after(() => {
    scheduler.enqueue = original.enqueue;
    scheduler.processPending = original.processPending;
    events.publishEvent = original.publishEvent;
    delete require.cache[modulePath];
  });

  const router = require('./pubsub');
  const status = await invoke(plannerHandler(router), {
    conversationId: 'conv_context',
    projectId: 'linear-project',
    projectName: 'Checkout',
    orgId: 'org-a',
    nativeProjectId: 'native-project-a',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(status, 204);
  assert.deepEqual(enqueued, [{
    projectId: 'linear-project',
    projectName: 'Checkout',
    assumedRole: null,
    orgId: 'org-a',
    nativeProjectId: 'native-project-a',
  }]);
  assert.equal(published.length, 2);
  assert.ok(published.every(([, , context]) => (
    context.organizationId === 'org-a' && context.projectId === 'native-project-a'
  )));
  assert.equal(published.some(([, event]) => event.jobId === 'job-1'), true);
  assert.equal(published.some(([, event]) => event.message === 'Planner processing tick complete'), true);
});

test('planner Pub/Sub validation errors remain scoped and never use the Linear project as native context', async (t) => {
  const modulePath = require.resolve('./pubsub');
  const originalPublish = events.publishEvent;
  const published = [];
  events.publishEvent = (...args) => published.push(args);
  delete require.cache[modulePath];
  t.after(() => {
    events.publishEvent = originalPublish;
    delete require.cache[modulePath];
  });

  const router = require('./pubsub');
  const status = await invoke(plannerHandler(router), {
    conversationId: 'conv_invalid',
    projectId: '',
    orgId: 'org-a',
    nativeProjectId: 'native-project-a',
  });

  assert.equal(status, 204);
  assert.equal(published.length, 1);
  assert.equal(published[0][1].level, 'error');
  assert.deepEqual(published[0][2], { organizationId: 'org-a', projectId: 'native-project-a' });
});

test('planner Pub/Sub preserves concurrent decoded workspace contexts through detached processing', async (t) => {
  const modulePath = require.resolve('./pubsub');
  const original = {
    enqueue: scheduler.enqueue,
    processPending: scheduler.processPending,
  };
  const enqueued = [];
  const processed = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  scheduler.enqueue = (job) => {
    enqueued.push({ job, context: currentWorkspaceContext() });
    return { id: `job-${job.orgId}`, ...job };
  };
  scheduler.processPending = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    processed.push(currentWorkspaceContext());
    if (processed.length === 2) finish();
    return { processed: 1 };
  };
  delete require.cache[modulePath];
  t.after(() => {
    scheduler.enqueue = original.enqueue;
    scheduler.processPending = original.processPending;
    delete require.cache[modulePath];
  });

  const router = require('./pubsub');
  const handler = plannerHandler(router);
  await Promise.all([
    invoke(handler, {
      conversationId: 'conversation-a', projectId: 'linear-a',
      orgId: 'org-a', nativeProjectId: 'project-a',
    }),
    invoke(handler, {
      conversationId: 'conversation-b', projectId: 'linear-b',
      orgId: 'org-b', nativeProjectId: 'project-b',
    }),
  ]);
  await finished;

  const byOrg = (left, right) => left.organizationId.localeCompare(right.organizationId);
  assert.deepEqual(enqueued.map(({ context }) => context).sort(byOrg), [
    { organizationId: 'org-a', projectId: 'project-a' },
    { organizationId: 'org-b', projectId: 'project-b' },
  ]);
  assert.deepEqual(processed.sort(byOrg), [
    { organizationId: 'org-a', projectId: 'project-a' },
    { organizationId: 'org-b', projectId: 'project-b' },
  ]);
});

test('planner Pub/Sub missing context keeps legacy empty-workspace behavior', async (t) => {
  const modulePath = require.resolve('./pubsub');
  const original = { enqueue: scheduler.enqueue, processPending: scheduler.processPending };
  let enqueuedContext;
  let processedContext;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  scheduler.enqueue = (job) => {
    enqueuedContext = currentWorkspaceContext();
    return { id: 'job-local', ...job };
  };
  scheduler.processPending = async () => {
    processedContext = currentWorkspaceContext();
    finish();
    return { processed: 1 };
  };
  delete require.cache[modulePath];
  t.after(() => {
    scheduler.enqueue = original.enqueue;
    scheduler.processPending = original.processPending;
    delete require.cache[modulePath];
  });

  const router = require('./pubsub');
  await invoke(plannerHandler(router), { projectId: 'linear-local' });
  await finished;
  assert.deepEqual(enqueuedContext, { organizationId: '', projectId: '' });
  assert.deepEqual(processedContext, { organizationId: '', projectId: '' });
});

test('planner autonomous ticks fail closed only on an unpinned shared cloud runtime', () => {
  const { shouldRunAutonomousTick, dispatchPlannerTick } = require('./pubsub');
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
  }), false, 'orchestrator rollout disables the legacy planner chain');

  let billingSweeps = 0;
  let autonomousRuns = 0;
  const result = dispatchPlannerTick(empty, {
    processBillingSweepImpl: () => { billingSweeps += 1; },
    processPending: () => { autonomousRuns += 1; },
    logImpl: { error() {}, warn() {} },
    messagingMode: 'pubsub',
    pinnedOrganizationId: '',
  });
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.deepEqual(result, { autonomous: false });
    assert.equal(billingSweeps, 1, 'global billing sweep remains enabled');
    assert.equal(autonomousRuns, 0, 'tenant queue must not run without context');
  });
});

test('planner orchestrator rollout keeps billing sweeps but suppresses autonomous planning', async () => {
  const { dispatchPlannerTick } = require('./pubsub');
  let billingSweeps = 0;
  let autonomousRuns = 0;
  const result = dispatchPlannerTick({ organizationId: 'org-a', projectId: 'project-a' }, {
    processBillingSweepImpl: () => { billingSweeps += 1; },
    processPending: () => { autonomousRuns += 1; },
    logImpl: { error() {}, warn() {} },
    messagingMode: 'pubsub',
    pinnedOrganizationId: 'org-a',
    orchestratorEnabled: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result, { autonomous: false });
  assert.equal(billingSweeps, 1);
  assert.equal(autonomousRuns, 0);
});
