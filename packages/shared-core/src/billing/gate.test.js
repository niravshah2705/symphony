'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-wallet-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.STORE_BACKEND = 'file';
// The local profile must not decide these tests: every case names its own policy.
delete process.env.BILLING_SWEEP_ENABLED;
delete process.env.BILLING_GATE_POLICY;
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const store = require('../store');
const gate = require('./gate');

const ON = { gatePolicy: 'enforced' };

/**
 * The two calls the gate makes, in the shapes measured live against v2.1.48:
 * `GET /v1/customers/external/:id`, then the wallet list (a bare array), then the
 * real-time projection (money as quoted decimal strings, `omitempty` nowhere in
 * sight). `credits` is what the projection answers.
 */
function makeFlex({ credits = '500', wallets = null, customer = true, throws = null, delayMs = 0 } = {}) {
  const calls = { customer: [], wallets: [], balance: [] };
  const client = {
    getCustomerByExternalId: async (orgId) => {
      calls.customer.push(orgId);
      if (throws) throw throws;
      if (!customer) throw Object.assign(new Error('not found'), { status: 404 });
      return { id: `cust_of_${orgId}`, external_id: orgId };
    },
    listWalletsByCustomer: async (customerId) => {
      calls.wallets.push(customerId);
      if (wallets !== null) return { items: wallets };
      return { items: [{ id: `wal_of_${customerId}`, currency: 'inr', wallet_type: 'PRE_PAID', conversion_rate: '1' }] };
    },
    walletRealTimeBalance: async (walletId) => {
      calls.balance.push(walletId);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        id: walletId,
        real_time_credit_balance: credits,
        current_period_usage: '12.50',
        unpaid_invoices_amount: '0',
        is_cached_fallback: false,
      };
    },
  };
  return { client, calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => gate.invalidate(null));

test('positive credit balance admits, and the paise figure is the wallet’s, not the ledger’s', async () => {
  const flex = makeFlex({ credits: '500' });
  // A first-party account that disagrees by a mile, to prove nothing reads it.
  store.upsertBillingAccount('org-gate-1', { balancePaise: -4_000_000 });
  await gate.ensureFundStatus('org-gate-1', { ...ON, client: flex.client });
  const status = gate.getOrgFundStatus('org-gate-1', { ...ON, client: flex.client });

  assert.equal(status.balancePaise, 50000, '500 credits at 100 paise each');
  assert.equal(status.fundsAvailable, true);
  assert.equal(status.state, 'available');
  assert.equal(flex.calls.balance[0], 'wal_of_cust_of_org-gate-1');
  // The fixture above answers `current_period_usage: '12.50'`, and the view has no
  // field for it. Measured on the live stack, that field is "0" on every wallet —
  // including one a manual debit drove to −2900 — because it is invoice-cycle
  // anchored. A "usage" number here would therefore be read as accrued consumption
  // and always read as none; the meter sum is the usage authority, not this view.
  assert.ok(!('currentPeriodUsagePaise' in status), 'the gate reports money, not usage');
});

test('zero is exhausted and negative is its own state, because only a manual debit makes one', async () => {
  const zero = makeFlex({ credits: '0' });
  await gate.ensureFundStatus('org-gate-zero', { ...ON, client: zero.client });
  const blockedZero = gate.billingStatus({ orgId: 'org-gate-zero' }, { ...ON, client: zero.client });
  assert.equal(blockedZero.blocked, true);
  assert.equal(blockedZero.fundStatus, 'unavailable');
  assert.equal(blockedZero.state, 'exhausted');
  assert.equal(blockedZero.sandboxCreationDisabled, true);
  assert.equal(blockedZero.scheduledCallsDisabled, true);
  assert.match(blockedZero.reason, /exhausted/i);

  const minus = makeFlex({ credits: '-2900' });
  await gate.ensureFundStatus('org-gate-neg', { ...ON, client: minus.client });
  const blockedNeg = gate.billingStatus({ orgId: 'org-gate-neg' }, { ...ON, client: minus.client });
  assert.equal(blockedNeg.blocked, true);
  assert.equal(blockedNeg.state, 'negative');
  // 'unavailable' is what ten call sites already compare against, so it stays the
  // value; 'negative' is the extra fact they do not have to know about.
  assert.equal(blockedNeg.fundStatus, 'negative');
  assert.match(blockedNeg.reason, /negative/i);
  assert.equal(blockedNeg.balancePaise, -290000);
});

test('off admits without asking FlexPrice anything at all', async () => {
  const flex = makeFlex({ credits: '0' });
  const status = gate.getOrgFundStatus('org-gate-off', { gatePolicy: 'off', client: flex.client });
  assert.equal(status.fundsAvailable, true);
  assert.equal(status.gatePolicy, 'off');
  assert.equal(flex.calls.balance.length, 0);
  assert.equal(flex.calls.customer.length, 0);
});

test('the shared free-tier org never reaches the wallet read', () => {
  const flex = makeFlex({ credits: '0' });
  const status = gate.getOrgFundStatus('__shared__', { ...ON, client: flex.client });
  assert.equal(status.fundsAvailable, true);
  assert.equal(flex.calls.customer.length, 0);
});

test('an org with no customer in FlexPrice is reported once and admitted', async () => {
  const flex = makeFlex({ customer: false });
  const first = gate.getOrgFundStatus('org-gate-nocust', { ...ON, client: flex.client });
  await tick();
  assert.equal(first.state, 'unknown');
  assert.equal(first.fundsAvailable, true, 'unprovisioned is not the same as broke');

  // Every later admission in the process says nothing more: the condition is one
  // provisioning gap, not a per-run event.
  for (let i = 0; i < 5; i += 1) gate.getOrgFundStatus('org-gate-nocust', { ...ON, client: flex.client });
  await tick();
  assert.equal(flex.calls.customer.length, 1, 'the retry cools down instead of hammering');
});

test('N admissions are ONE read, and a stale entry re-reads in the background without blocking', async () => {
  const flex = makeFlex({ credits: '10', delayMs: 20 });
  const results = [];
  for (let i = 0; i < 8; i += 1) results.push(gate.getOrgFundStatus('org-gate-burst', { ...ON, client: flex.client }));
  assert.equal(flex.calls.customer.length, 1, 'single-flight: the burst is one read');
  assert.ok(results.every((r) => r.state === 'unknown'), 'none of them waited for the network');
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(gate.getOrgFundStatus('org-gate-burst', { ...ON, client: flex.client }).balancePaise, 1000);
  assert.equal(flex.calls.customer.length, 1, 'the fresh entry is served from cache');

  // Expire it: the call still returns synchronously, with the last real number.
  const stale = gate.getOrgFundStatus('org-gate-burst', { ...ON, client: flex.client, ttlMs: -1 });
  assert.equal(flex.calls.customer.length, 2);
  assert.equal(stale.balancePaise, 1000, 'stale-while-revalidate serves the old value, not a guess');
  await tick();
});

test('a read that fails keeps the last known balance and marks it stale', async () => {
  const good = makeFlex({ credits: '700' });
  await gate.ensureFundStatus('org-gate-fail', { ...ON, client: good.client });
  const broken = makeFlex({ throws: new Error('connection refused') });
  // The failing read is the background one, so the admission that triggers it
  // still answers from the cache — that is the whole stale-while-revalidate deal.
  gate.getOrgFundStatus('org-gate-fail', { ...ON, client: broken.client, ttlMs: -1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = gate.getOrgFundStatus('org-gate-fail', { ...ON, client: broken.client });

  assert.equal(after.fundsAvailable, true);
  assert.equal(after.balancePaise, 70000, 'an outage is not evidence of an empty wallet');
  assert.equal(after.stale, true);
  assert.equal(after.state, 'available');
});

test('a recharge invalidates what this process believed about the org', async () => {
  const flex = makeFlex({ credits: '0' });
  await gate.ensureFundStatus('org-gate-recharge', { ...ON, client: flex.client });
  assert.equal(gate.billingStatus({ orgId: 'org-gate-recharge' }, { ...ON, client: flex.client }).blocked, true);

  gate.invalidate('org-gate-recharge');
  const richer = makeFlex({ credits: '250' });
  await gate.ensureFundStatus('org-gate-recharge', { ...ON, client: richer.client });
  const after = gate.getOrgFundStatus('org-gate-recharge', { ...ON, client: richer.client });
  assert.equal(after.fundsAvailable, true);
  assert.equal(after.balancePaise, 25000);
});

test('gateEnabled:false opts out, and costs no read', () => {
  const flex = makeFlex({ credits: '-5' });
  store.upsertBillingAccount('org-gate-optout', { gateEnabled: false });
  const status = gate.getOrgFundStatus('org-gate-optout', { ...ON, client: flex.client });
  assert.equal(status.fundsAvailable, true);
  assert.equal(status.optedOut, true);
  assert.equal(flex.calls.customer.length, 0);
});

test('the cached wallet id on the account is used instead of the lookup', async () => {
  const flex = makeFlex({ credits: '3' });
  store.upsertBillingAccount('org-gate-cached', { flexprice: { walletId: 'wal_saved_1' } });
  await gate.ensureFundStatus('org-gate-cached', { ...ON, client: flex.client });
  assert.equal(flex.calls.customer.length, 0);
  assert.deepEqual(flex.calls.balance, ['wal_saved_1']);
});

test('only the INR prepaid wallet is the balance of record', async () => {
  const flex = makeFlex({
    credits: '3',
    wallets: [
      { id: 'wal_free', currency: 'usd', wallet_type: 'FREE_TIER' },
      { id: 'wal_inr', currency: 'inr', wallet_type: 'PRE_PAID' },
    ],
  });
  await gate.ensureFundStatus('org-gate-two', { ...ON, client: flex.client });
  assert.deepEqual(flex.calls.balance, ['wal_inr']);
});

test('a balance the code cannot read admits, and says which one it could not read', async () => {
  const flex = {
    getCustomerByExternalId: async () => ({ id: 'cust_x' }),
    listWalletsByCustomer: async () => ({ items: [{ id: 'wal_x', currency: 'inr', wallet_type: 'PRE_PAID' }] }),
    walletRealTimeBalance: async () => ({ real_time_credit_balance: 'NaN-ish' }),
  };
  const status = await gate.ensureFundStatus('org-gate-junk', { ...ON, client: flex });
  assert.equal(status.fundsAvailable, true);
  assert.equal(status.state, 'unknown');
  assert.equal(status.balancePaise, null);
});

test('a sub-paise credit balance becomes whole paise without a float', async () => {
  const flex = makeFlex({ credits: '1000.505' });
  await gate.ensureFundStatus('org-gate-frac', { ...ON, client: flex.client });
  const status = gate.getOrgFundStatus('org-gate-frac', { ...ON, client: flex.client });
  // 1000.505 credits * 100 = 100050.5 paise, half-up to 100051. Never 100050: a
  // gate that rounds a balance down rounds a customer’s money away.
  assert.equal(status.balancePaise, 100051);
});

test('the policy default follows the money source, and only an explicit value names itself', () => {
  assert.deepEqual(gate.resolveGatePolicy({ gatePolicy: 'off' }), { policy: 'off', named: true });
  assert.deepEqual(gate.resolveGatePolicy({ gatePolicy: 'enforced' }), { policy: 'enforced', named: true });
  const derived = gate.resolveGatePolicy({});
  assert.ok(['off', 'enforced'].includes(derived.policy));
  assert.equal(derived.named, false, 'a derived policy is not one an operator chose');
});

test('boot names the policy, and an enforced gate with no money source is refused', () => {
  // This suite runs with FLEXPRICE_ENABLED unset, so `enforced` can only be a
  // named choice here — and a named choice with nothing to read is the open door
  // that logs like a closed one.
  assert.equal(gate.reportBoot({ gatePolicy: 'off' }), 'off');
  assert.throws(() => gate.reportBoot({ gatePolicy: 'enforced' }), /needs FLEXPRICE_ENABLED/);
});
