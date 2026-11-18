'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const linear = require('@ai-fleet/shared/linear');

const { normalizeProjectTask } = require('./issues');

test('planner project task validation bounds tracker inputs', () => {
  assert.deepEqual(normalizeProjectTask({
    projectId: 'project-1',
    title: 'Update checkout validation',
    description: 'Keep the existing payment flow.',
    priority: 2,
    idempotencyKey: 'agent:request-1',
  }), {
    projectId: 'project-1',
    title: 'Update checkout validation',
    description: 'Keep the existing payment flow.',
    priority: 2,
    idempotencyKey: 'agent:request-1',
  });
  assert.throws(() => normalizeProjectTask({}), /idempotencyKey is required/);
  assert.throws(() => normalizeProjectTask({ idempotencyKey: 'bad key' }), /only letters/);
  assert.throws(() => normalizeProjectTask({ idempotencyKey: 'valid-key', projectId: 'p', title: 't', priority: 8 }), /0 to 4/);
});

test('confirmed project task creation derives the team and replays duplicate requests once', async (t) => {
  const originalTeam = linear.getProjectTeam;
  const originalCreate = linear.createIssue;
  const modulePath = require.resolve('./issues');
  let creates = 0;
  linear.getProjectTeam = async (_key, projectId) => ({ project: { id: projectId }, team: { id: 'team-1' } });
  linear.createIssue = async (_key, input) => {
    creates += 1;
    return { id: 'issue-1', identifier: 'ENG-1', title: input.title, url: 'https://linear.app/issue/ENG-1' };
  };
  delete require.cache[modulePath];
  const router = require('./issues');
  t.after(() => {
    linear.getProjectTeam = originalTeam;
    linear.createIssue = originalCreate;
    delete require.cache[modulePath];
  });

  const layer = router.stack.find((candidate) => candidate.route && candidate.route.path === '/' && candidate.route.methods.post);
  assert.ok(layer);
  const handler = layer.route.stack[0].handle;
  const body = { projectId: 'project-1', title: 'Change checkout', description: 'Confirmed.', priority: 2, idempotencyKey: 'agent:duplicate-1' };
  const invoke = () => new Promise((resolve, reject) => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { resolve({ status: this.statusCode, payload }); } };
    handler({ body }, response, reject);
  });

  const first = await invoke();
  const second = await invoke();
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.payload.replayed, true);
  assert.equal(creates, 1);
});
