'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { currentWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');
const { main } = require('./job');

const pause = () => new Promise((resolve) => setImmediate(resolve));

test('coder workers bind their job context across init and execution concurrently', async () => {
  const initialized = [];
  const executed = [];
  const exits = [];
  const run = (suffix) => main({
    env: {
      ISSUE_ID: `issue-${suffix}`,
      CONVERSATION_ID: `conversation-${suffix}`,
      FLEET_ORG_ID: `org-${suffix}`,
      AI_FLEET_PROJECT_CONTEXT: `project-${suffix}`,
    },
    initStoreImpl: async () => {
      await pause();
      initialized.push(currentWorkspaceContext());
    },
    runTicketImpl: async (input) => {
      await pause();
      executed.push({ input, context: currentWorkspaceContext() });
    },
    logImpl: { info() {}, error() {} },
    exit: (code) => exits.push({ suffix, code }),
  });

  const results = await Promise.all([run('a'), run('b')]);
  assert.deepEqual(results, [0, 0]);
  const byOrganization = (a, b) => a.organizationId.localeCompare(b.organizationId);
  initialized.sort(byOrganization);
  executed.sort((a, b) => byOrganization(a.context, b.context));
  exits.sort((a, b) => a.suffix.localeCompare(b.suffix));
  assert.deepEqual(initialized, [
    { organizationId: 'org-a', projectId: 'project-a' },
    { organizationId: 'org-b', projectId: 'project-b' },
  ]);
  assert.deepEqual(executed.map(({ context }) => context), initialized);
  assert.deepEqual(executed.map(({ input }) => input), [
    {
      issueId: 'issue-a', conversationId: 'conversation-a', blocking: true,
      orgId: 'org-a', nativeProjectId: 'project-a',
    },
    {
      issueId: 'issue-b', conversationId: 'conversation-b', blocking: true,
      orgId: 'org-b', nativeProjectId: 'project-b',
    },
  ]);
  assert.deepEqual(exits, [{ suffix: 'a', code: 0 }, { suffix: 'b', code: 0 }]);
});

test('coder worker without context keeps legacy empty-workspace behavior', async () => {
  let observed;
  const result = await main({
    env: { ISSUE_ID: 'issue-local' },
    initStoreImpl: async () => {},
    runTicketImpl: async () => { observed = currentWorkspaceContext(); },
    logImpl: { info() {}, error() {} },
    exit() {},
  });
  assert.equal(result, 0);
  assert.deepEqual(observed, { organizationId: '', projectId: '' });
});
