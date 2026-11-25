import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, gateDecision, type OrgStatus } from '../src/lifecycle.ts';
import { isAlreadyGone, withoutNamespacePolicy, type NamespacePolicy } from '../src/offboarding/steps.ts';
import { HttpError } from '../src/clients/http.ts';
import type { FacadeCall } from '../src/a2a/translate.ts';

const STATUSES: OrgStatus[] = ['active', 'disabled', 'offboarding', 'deleted'];
const CALLS: FacadeCall['kind'][] = ['agent-card', 'extended-card', 'stream', 'send', 'task', 'unknown'];

test('only the legal status changes are legal', () => {
  // The whole table, so a new status or a loosened edge shows up here rather than
  // in a tenant whose agents were deleted underneath an "undo".
  const legal: [OrgStatus, OrgStatus][] = [
    ['active', 'disabled'],
    ['active', 'offboarding'],
    ['disabled', 'active'],
    ['disabled', 'offboarding'],
    ['offboarding', 'deleted'],
  ];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = legal.some(([a, b]) => a === from && b === to);
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
    }
  }
  assert.equal(canTransition('active', 'active'), false, 'a no-op is not a transition');
  // The two the owner will ask for and must be refused:
  assert.equal(canTransition('offboarding', 'active'), false, 'a torn-down tenant has no agents to hand back');
  assert.equal(canTransition('deleted', 'active'), false, 'reviving a deleted org would resurrect its slug');
});

test('a suspended org refuses new turns and keeps every other door open', () => {
  for (const call of CALLS) {
    assert.equal(gateDecision('active', call), 'allow', `active must never be gated (${call})`);
  }
  for (const status of ['disabled', 'offboarding', 'deleted'] as const) {
    assert.equal(gateDecision(status, 'stream'), 'refuse', `${status} must not start a turn`);
    assert.equal(gateDecision(status, 'send'), 'refuse', `${status} must not start a turn`);
    // Reading, subscribing, and cancelling stay open: cancel is the user's lever on
    // the meter, and a task that cannot be read cannot be settled.
    assert.equal(gateDecision(status, 'task'), 'allow');
    assert.equal(gateDecision(status, 'agent-card'), 'allow');
    assert.equal(gateDecision(status, 'extended-card'), 'allow');
  }
});

const policies: NamespacePolicy[] = [
  { allowedNamespaces: ['ate-system'], atespace: 'kagent' },
  { allowedNamespaces: ['ate-system', 'org-demo'], atespace: 'org-demo' },
  { allowedNamespaces: ['ate-system'], atespace: 'org-other' },
];

test('the substrate policy edit removes exactly this tenant', () => {
  const kept = withoutNamespacePolicy(policies, 'org-demo');
  assert.deepEqual(kept.map((p) => p.atespace), ['kagent', 'org-other']);
  // The shared release belongs to everybody: the baseline entry and the other
  // tenant's entry must survive byte-identical.
  assert.deepEqual(kept[0], policies[0]);
  assert.deepEqual(kept[1], policies[2]);
  // A retry after the entry is already gone must produce an equal list, because the
  // step skips the helm write when nothing changed.
  assert.deepEqual(withoutNamespacePolicy(kept, 'org-demo'), kept);
  assert.deepEqual(withoutNamespacePolicy([], 'org-demo'), []);
});

test('gone is fine, and only gone', () => {
  const gone = [
    'Error: release: "demo-kagent-tenant" not found',
    'namespaces "org-demo" not found',
    'workerpools.ate.dev "org-demo-pool" not found',
    'HTTP 404: team does not exist',
    'no such key',
    'subscription is already cancelled',
    'invalid status',
    // The vendor's own code for the same fact, spelled with an underscore.
    '{"code":"subscription_invalid_status"}',
  ];
  for (const message of gone) {
    assert.equal(isAlreadyGone(new Error(message)), true, message);
  }
  // A wrong cluster, a dead credential, or a transport failure must NOT read as
  // "already deleted": the step has to fail and retry, or the teardown reports
  // success over a live namespace and a spend-capable key. Note the first two
  // overlap the gone patterns below, which is why they are excluded first.
  const real = [
    'kubectl get namespace org-demo failed: error: context "kind-fleet" does not exist',
    'helm get values substrate -n ate-system failed: spawn helm ENOENT',
    ' Unauthorized',
    'connection refused',
    'i/o timeout',
  ];
  for (const message of real) {
    assert.equal(isAlreadyGone(new Error(message)), false, message);
  }
  assert.equal(isAlreadyGone(new HttpError(404, 'nope', '{}')), true);
  assert.equal(isAlreadyGone(new HttpError(403, 'nope', 'forbidden')), false);
  assert.equal(isAlreadyGone(undefined), false);
});
