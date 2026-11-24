import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGUI_MODEL_PROP,
  INTERRUPT_AUTH_REQUIRED,
  INTERRUPT_INPUT_REQUIRED,
  MODEL_METADATA_KEY,
  aguiRunPath,
} from '../src/index.ts';

test('the AG-UI vocabulary is spelled exactly once', () => {
  // The encoder writes these and the browser matches on them; a drift is a
  // silence — an approval prompt that never renders, not an error.
  assert.equal(AGUI_MODEL_PROP, MODEL_METADATA_KEY);
  assert.equal(AGUI_MODEL_PROP, 'fleet.dev/model');
  assert.equal(INTERRUPT_INPUT_REQUIRED, 'input-required');
  assert.equal(INTERRUPT_AUTH_REQUIRED, 'auth-required');
});

test('the run path carries the project scope, like the A2A facade base', () => {
  assert.equal(
    aguiRunPath('https://app.fleet.dev', 'org-uuid', 'proj-uuid'),
    'https://app.fleet.dev/api/agui/orgs/org-uuid/projects/proj-uuid/agent',
  );
  assert.equal(aguiRunPath('https://app.fleet.dev///', 'o', 'p'), 'https://app.fleet.dev/api/agui/orgs/o/projects/p/agent');
});
