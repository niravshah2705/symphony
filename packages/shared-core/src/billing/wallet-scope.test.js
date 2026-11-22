'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KIND, WalletScopeError, createWalletScope, customerIdOf, DEFAULT_TTL_MS,
} = require('./wallet-scope');

function fakeFlex({ walletsOf = {}, customerStatus = 200, error = null } = {}) {
  const calls = { customer: [], wallets: [] };
  return {
    calls,
    client: {
      getCustomerByExternalId: async (orgId) => {
        calls.customer.push(orgId);
        if (error) throw error;
        if (customerStatus === 404) throw Object.assign(new Error('not found'), { status: 404 });
        if (customerStatus === 'no_id') return { external_id: orgId };
        return { id: `cust_of_${String(orgId).trim()}`, external_id: String(orgId).trim() };
      },
      listWalletsByCustomer: async (customerId) => {
        calls.wallets.push(customerId);
        return { items: walletsOf[customerId] || [] };
      },
    },
  };
}

function scope(over = {}) {
  const logged = [];
  const clock = { now: 1_000 };
  const s = createWalletScope({
    logger: { error: (line, fields) => logged.push({ line, fields }) },
    now: () => clock.now,
    ...over,
  });
  return { scope: s, logged, clock };
}

const failure = async (p) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
};

test('a wallet in the org’s own list is proven, and the proof is reused', async () => {
  const flex = fakeFlex({ walletsOf: { cust_of_org_a: [{ id: 'wal_1' }] } });
  const { scope: s, logged } = scope();
  assert.deepEqual(await s.assertWalletOwnership(flex.client, ' org_a ', ' wal_1 '), {
    verified: true, cached: false, customerId: 'cust_of_org_a',
  }, 'ids are trimmed the same way the gate trims them');
  assert.deepEqual(logged, []);

  // The gate refreshes a balance every 15s; two extra reads per refresh would make
  // the check something an operator wants to turn off.
  assert.deepEqual(await s.assertWalletOwnership(flex.client, 'org_a', 'wal_1'), { verified: true, cached: true, customerId: 'cust_of_org_a' });
  assert.equal(flex.calls.customer.length, 1);
  assert.equal(flex.calls.wallets.length, 1);
});

test('a wallet the customer does not have fails closed and says which one it has', async () => {
  const flex = fakeFlex({ walletsOf: { cust_of_org_a: [{ id: 'wal_mine' }] } });
  const { scope: s, logged } = scope();
  const err = await failure(s.assertWalletOwnership(flex.client, 'org_a', 'wal_of_org_b'));

  assert.ok(err instanceof WalletScopeError);
  assert.equal(err.kind, KIND.mismatch);
  assert.equal(err.status, 403, 'a scope failure is not a 404 to degrade as');
  assert.equal(err.walletId, 'wal_of_org_b');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].line, 'billing_flexprice_wallet_org_mismatch');
  assert.deepEqual(logged[0].fields.expectedWalletIds, ['wal_mine']);
  assert.ok(!JSON.stringify(logged[0].fields).includes('api-key'));

  // Nothing was memoized, so a fixed record is picked up on the next read.
  const again = fakeFlex({ walletsOf: { cust_of_org_a: [{ id: 'wal_of_org_b' }] } });
  assert.equal((await s.assertWalletOwnership(again.client, 'org_a', 'wal_of_org_b')).verified, true);
});

test('an org with no customer in FlexPrice cannot own the stored wallet', async () => {
  for (const over of [{ customerStatus: 404 }, { customerStatus: 'no_id' }]) {
    const flex = fakeFlex(over);
    const { scope: s, logged } = scope();
    const err = await failure(s.assertWalletOwnership(flex.client, 'org_a', 'wal_1'));
    assert.ok(err instanceof WalletScopeError, 'a missing customer is a provisioning gap, not an outage');
    assert.equal(err.kind, KIND.customerMissing);
    assert.equal(logged[0].line, 'billing_flexprice_wallet_org_mismatch');
    assert.equal(flex.calls.wallets.length, 0, 'no wallet list is fetched for a customer that does not exist');
  }
});

test('FlexPrice being unreachable is not evidence of a cross-tenant record', async () => {
  const outage = Object.assign(new Error('connection refused'), { status: 503 });
  const flex = fakeFlex({ error: outage });
  const { scope: s, logged } = scope();
  const err = await failure(s.assertWalletOwnership(flex.client, 'org_a', 'wal_1'));
  assert.equal(err, outage, 'rethrown unchanged, so the caller keeps its stale view');
  assert.equal(err instanceof WalletScopeError, false);
  assert.deepEqual(logged, []);
});

test('two orgs claiming one wallet: the first proof never vouches for the second', async () => {
  // The memo is keyed by the CLAIM. Keying it by the wallet id alone would let
  // org A's successful verification answer for org B's identical stored id —
  // which is precisely the record this module exists to catch.
  const { scope: s } = scope();
  const good = fakeFlex({ walletsOf: { cust_of_org_a: [{ id: 'wal_1' }] } });
  assert.equal((await s.assertWalletOwnership(good.client, 'org_a', 'wal_1')).cached, false);
  assert.equal((await s.assertWalletOwnership(good.client, 'org_a', 'wal_1')).cached, true);

  const victim = fakeFlex({ walletsOf: { cust_of_org_b: [{ id: 'wal_other' }] } });
  const err = await failure(s.assertWalletOwnership(victim.client, 'org_b', 'wal_1'));
  assert.ok(err instanceof WalletScopeError);
  assert.equal(err.kind, KIND.mismatch);
  assert.equal(victim.calls.customer.length, 1, 'org B was verified on its own merits');

  // `remember` (the gate's resolution path) is held to the same keying.
  const shared = fakeFlex({ walletsOf: { cust_of_org_a: [{ id: 'wal_9' }], cust_of_org_b: [{ id: 'wal_9' }] } });
  s.remember('org_a', 'wal_9', 'cust_of_org_a');
  assert.equal((await s.assertWalletOwnership(shared.client, 'org_a', 'wal_9')).cached, true);
  assert.equal((await s.assertWalletOwnership(shared.client, 'org_b', 'wal_9')).cached, false);
  assert.deepEqual(shared.calls.customer, ['org_b']);
});

test('nothing is asserted about an id this module was not given', async () => {
  const flex = fakeFlex({});
  const { scope: s } = scope();
  const missingWallet = await failure(s.assertWalletOwnership(flex.client, 'org_a', '  '));
  assert.ok(missingWallet instanceof WalletScopeError);
  assert.equal(missingWallet.kind, KIND.missing);
  const missingOrg = await failure(s.assertWalletOwnership(flex.client, '', 'wal_1'));
  assert.ok(missingOrg instanceof WalletScopeError);
  assert.equal(missingOrg.kind, KIND.missing);
  assert.equal(flex.calls.customer.length, 0, 'a blank id never reaches the provider');
});

test('a proof expires, so a record fixed on the FlexPrice side is re-read', async () => {
  const { scope: s, clock } = scope({ ttlMs: 50 });
  const flex = fakeFlex({ walletsOf: { cust_of_org_a: [{ id: 'wal_1' }] } });
  await s.assertWalletOwnership(flex.client, 'org_a', 'wal_1');
  clock.now += 50;
  assert.equal((await s.assertWalletOwnership(flex.client, 'org_a', 'wal_1')).cached, false);
  assert.equal(flex.calls.customer.length, 2);
  assert.ok(DEFAULT_TTL_MS > 60_000, 'the default outlives a gate refresh but not an admin fix');
});

test('forget clears one org’s claims or all of them', async () => {
  const { scope: s } = scope();
  const flex = fakeFlex({
    walletsOf: { cust_of_org_a: [{ id: 'wal_a' }], cust_of_org_b: [{ id: 'wal_b' }] },
  });
  await s.assertWalletOwnership(flex.client, 'org_a', 'wal_a');
  await s.assertWalletOwnership(flex.client, 'org_b', 'wal_b');
  assert.equal(s.size(), 2);

  assert.deepEqual(s.forget('org_a'), { cleared: 1, orgId: 'org_a' });
  assert.equal(s.size(), 1, 'a settle for A does not invalidate B’s proof');
  assert.equal((await s.assertWalletOwnership(flex.client, 'org_b', 'wal_b')).cached, true);
  assert.equal((await s.assertWalletOwnership(flex.client, 'org_a', 'wal_a')).cached, false);

  assert.deepEqual(s.forget(), { cleared: 'all' });
  assert.equal(s.size(), 0);
});

test("the customer id comes from the SDK model's flat shape, and nothing else", () => {
  assert.equal(customerIdOf({ id: 'cust_1' }), 'cust_1');
  assert.equal(customerIdOf({ id: '  ' }), null);
  // The pre-SDK wrapper answered `{ customer: { id } }`; the generated model is
  // flat, so a nested id is not read — a customer this code cannot name is a
  // customer it must not vouch for.
  assert.equal(customerIdOf({ customer: { id: 'cust_2' } }), null);
  assert.equal(customerIdOf(null), null);
  assert.equal(customerIdOf('cust'), null);
});
