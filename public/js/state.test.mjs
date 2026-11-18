import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// state.js reads `localStorage` at module scope, so every case loads a fresh copy
// of the module against its own storage rather than sharing one import.
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

// state.js has no imports of its own, so each case evaluates its own copy of the
// real source: the module reads storage at import time, and a shared import would
// give every test the same `state` object.
const SOURCE = readFileSync(new URL('./state.js', import.meta.url), 'utf8');
let loadCount = 0;
async function loadState(initial = {}) {
  globalThis.localStorage = memoryStorage(initial);
  loadCount += 1;
  return import(`data:text/javascript,${encodeURIComponent(SOURCE)}#load=${loadCount}`);
}

test('a project chosen under one organization is not the next organization\'s', async () => {
  const { setCurrentProject, setOrganizationScope, state } = await loadState();

  setOrganizationScope('org-a');
  setCurrentProject('project-a1', 'Atlas');
  assert.equal(state.currentProjectId, 'project-a1');

  setOrganizationScope('org-b');
  assert.equal(state.currentProjectId, '',
    'switching tenants must not carry the previous organization\'s project forward');
  assert.equal(state.currentProjectName, '', 'and not its project name either');

  // Coming home restores the choice that belongs to that organization.
  setOrganizationScope('org-a');
  assert.equal(state.currentProjectId, 'project-a1');
  assert.equal(state.currentProjectName, 'Atlas');
});

test('the pre-existing flat choice applies to the unscoped profile only', async () => {
  const { state, setOrganizationScope } = await loadState({
    'lm.currentProjectId': 'project-legacy',
    'lm.currentProjectName': 'Legacy',
  });
  assert.equal(state.currentProjectId, 'project-legacy',
    'the local single-workspace profile has no scope call to wait for, so first paint keeps its choice');

  setOrganizationScope('org-a');
  assert.equal(state.currentProjectId, '',
    'a real organization does not inherit it — that was the cross-tenant leak');

  setOrganizationScope('');
  assert.equal(state.currentProjectId, 'project-legacy',
    'and the unscoped scope reads the same flat keys back');
});

test('an explicit choice is remembered per organization across a reload', async () => {
  const first = await loadState();
  first.setOrganizationScope('org-a');
  first.setCurrentProject('project-a2', 'Apollo');
  const persisted = globalThis.localStorage.getItem('lm.projectByOrganization');
  assert.ok(persisted, 'the choice has to survive the tab');

  // Same storage, fresh module: what a page reload actually does.
  const again = await loadState({ 'lm.projectByOrganization': persisted });
  again.setOrganizationScope('org-b');
  assert.equal(again.state.currentProjectId, '', 'the sibling organization never sees it');
  again.setOrganizationScope('org-a');
  assert.equal(again.state.currentProjectId, 'project-a2');
  assert.equal(again.state.currentProjectName, 'Apollo');
});

test('re-applying the same scope keeps the choice this session already made', async () => {
  const { setCurrentProject, setOrganizationScope, state } = await loadState();
  setOrganizationScope('org-a');
  setCurrentProject('project-newer', 'Newer');
  setOrganizationScope('org-a');
  assert.equal(state.currentProjectId, 'project-newer',
    'a context refresh must not roll the view back to the value stored before it picked');
});

test('sign-out clears the in-memory choice without erasing what was stored', async () => {
  const { setCurrentProject, setOrganizationScope, clearOrganizationScope, state } = await loadState();
  setOrganizationScope('org-a');
  setCurrentProject('project-a1', 'Atlas');

  clearOrganizationScope();
  assert.equal(state.organizationId, '');
  assert.equal(state.currentProjectId, '');
  assert.notEqual(globalThis.localStorage.getItem('lm.projectByOrganization'), null,
    'the next sign-in to the same organization should not lose where work left off');

  setOrganizationScope('org-a');
  assert.equal(state.currentProjectId, 'project-a1',
    'because the scope reloads it, the cleared value must not be the one persisted');
});

test('unavailable storage degrades to in-memory state', async () => {
  globalThis.localStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceeded'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  const { setCurrentProject, setOrganizationScope, state } = await loadState();
  setOrganizationScope('org-a');
  setCurrentProject('project-a1', 'Atlas');
  assert.equal(state.currentProjectId, 'project-a1',
    'private-mode browsing still gets a working session, just nothing persisted');
});
