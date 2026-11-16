'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-gate-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
// The unconfigured local profile, which is what this file is for: no FlexPrice,
// no named policy. The rule itself is tested where it lives —
// packages/shared-core/src/billing/gate.test.js.
delete process.env.BILLING_SWEEP_ENABLED;
delete process.env.BILLING_GATE_POLICY;
delete process.env.FLEXPRICE_ENABLED;
process.env.FLEET_ORG_ID = 'org-gate';

const coreGate = require('@ai-fleet/shared-core/billing/gate');
const { billingStatus, isBillingBlocked, getOrgFundStatus } = require('./gate');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('the agent-side gate IS the shared-core gate, not a second copy', () => {
  assert.equal(billingStatus, coreGate.billingStatus);
  assert.equal(isBillingBlocked, coreGate.isBillingBlocked);
  assert.equal(getOrgFundStatus, coreGate.getOrgFundStatus);
});

test('with no FlexPrice configured the gate is off, so a local run is never blocked', () => {
  assert.equal(isBillingBlocked({}), false);
  const status = billingStatus({});
  assert.equal(status.orgId, 'org-gate');
  assert.equal(status.gatePolicy, 'off');
  assert.equal(status.fundsAvailable, true);
  assert.equal(status.balancePaise, null, 'nothing was read, so nothing is claimed');
});
