'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the store before anything loads config.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-billing-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const store = require('@ai-fleet/shared/store');
const { SHARED_ORG_ID } = require('@ai-fleet/shared/billing/org-context');
const billingRoute = require('./billing');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test.before(() => {
  store.addUsageRecord({ orgId: 'org-A', userId: 'uA', projectId: 'pA', usage: { totalTokens: 10 }, costPaise: 100 });
  store.addUsageRecord({ orgId: 'org-B', userId: 'uB', projectId: 'pB', usage: { totalTokens: 20 }, costPaise: 200 });
  store.addUsageRecord({ orgId: SHARED_ORG_ID, userId: 'personal-1', projectId: 'x', usage: { totalTokens: 5 }, costPaise: 50 });
  store.addUsageRecord({ orgId: SHARED_ORG_ID, userId: 'personal-2', projectId: 'y', usage: { totalTokens: 7 }, costPaise: 70 });
});

test('scopedUsageRecords returns only the caller org’s records (cross-tenant isolation)', () => {
  const a = billingRoute.scopedUsageRecords({ orgId: 'org-A', userId: 'uA', isAdmin: false });
  assert.equal(a.length, 1);
  assert.equal(a[0].orgId, 'org-A');
  // Org A cannot see Org B.
  assert.equal(a.every((r) => r.orgId !== 'org-B'), true);
});

test('shared account scopes drill-down to the caller’s own user (no cross-personal leak)', () => {
  const p1 = billingRoute.scopedUsageRecords({ orgId: SHARED_ORG_ID, userId: 'personal-1' });
  assert.equal(p1.length, 1);
  assert.equal(p1[0].userId, 'personal-1');
});

test('shared account with no user identity exposes nothing granular (safe default)', () => {
  const anon = billingRoute.scopedUsageRecords({ orgId: SHARED_ORG_ID, userId: null });
  assert.equal(anon.length, 0);
});
