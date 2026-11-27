import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGUI_MODEL_PROP,
  FILE_CUSTOM_EVENT,
  INTERRUPT_AUTH_REQUIRED,
  INTERRUPT_INPUT_REQUIRED,
  MODEL_METADATA_KEY,
  SOURCES_CUSTOM_EVENT,
  UI_CUSTOM_EVENT,
  aguiRunPath,
  uiSpecFor,
} from '../src/index.ts';

test('the AG-UI vocabulary is spelled exactly once', () => {
  // The encoder writes these and the browser matches on them; a drift is a
  // silence — an approval prompt that never renders, not an error.
  assert.equal(AGUI_MODEL_PROP, MODEL_METADATA_KEY);
  assert.equal(AGUI_MODEL_PROP, 'fleet.dev/model');
  assert.equal(INTERRUPT_INPUT_REQUIRED, 'input-required');
  assert.equal(INTERRUPT_AUTH_REQUIRED, 'auth-required');
  assert.equal(FILE_CUSTOM_EVENT, 'fleet.dev/file');
  assert.equal(SOURCES_CUSTOM_EVENT, 'fleet.dev/sources');
  assert.equal(UI_CUSTOM_EVENT, 'fleet.dev/ui');
});

test('an explicit kind is honored and its props ride through', () => {
  assert.deepEqual(uiSpecFor({ kind: 'kanban', props: { boards: ['a'] } }), { kind: 'kanban', props: { boards: ['a'] } });
  // `ui` is the other spelling a schema author reaches for; both are the same choice.
  assert.deepEqual(uiSpecFor({ ui: 'timeline', started: '2026-01' }), { kind: 'timeline', props: { started: '2026-01' } });
});

test('a shaped result is read structurally', () => {
  assert.deepEqual(uiSpecFor({ columns: [{ key: 'pkg' }], rows: [{ pkg: 'a2a' }] }), {
    kind: 'table',
    props: { columns: [{ key: 'pkg' }], rows: [{ pkg: 'a2a' }] },
  });
  // The commonest schema of all: a bare array of records, no column declaration.
  assert.deepEqual(uiSpecFor([{ name: 'go', stars: 3 }, { name: 'rust', stars: 4 }]), {
    kind: 'table',
    props: { columns: [{ key: 'name', title: 'name' }, { key: 'stars', title: 'stars' }], rows: [{ name: 'go', stars: 3 }, { name: 'rust', stars: 4 }] },
  });
  assert.deepEqual(uiSpecFor({ labels: ['a', 'b'], values: [1, 2] }), { kind: 'chart', props: { labels: ['a', 'b'], values: [1, 2] } });
  assert.deepEqual(uiSpecFor({ before: 'x', after: 'y' }), { kind: 'diff', props: { before: 'x', after: 'y' } });
});

test('anything unrecognized stays JSON rather than becoming a guess', () => {
  assert.deepEqual(uiSpecFor({ summary: 'looks fine' }), { kind: 'json', props: { value: { summary: 'looks fine' } } });
  assert.deepEqual(uiSpecFor('a plain string'), { kind: 'json', props: { value: 'a plain string' } });
  // Mismatched label/value counts is not a chart; a chart with one point is.
  assert.equal(uiSpecFor({ labels: ['a'], values: [1, 2] }).kind, 'json');
  assert.equal(uiSpecFor({ labels: ['a'], values: [1] }).kind, 'chart');
});

test('the run path carries the project scope, like the A2A facade base', () => {
  assert.equal(
    aguiRunPath('https://app.fleet.dev', 'org-uuid', 'proj-uuid'),
    'https://app.fleet.dev/api/agui/orgs/org-uuid/projects/proj-uuid/agent',
  );
  assert.equal(aguiRunPath('https://app.fleet.dev///', 'o', 'p'), 'https://app.fleet.dev/api/agui/orgs/o/projects/p/agent');
});
