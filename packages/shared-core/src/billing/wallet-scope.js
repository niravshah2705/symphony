'use strict';

/**
 * Proof that a FlexPrice wallet belongs to the organization asking for it.
 *
 * The org's wallet id is persisted on the billing account
 * (`account.flexprice.walletId`) so the hot paths do not re-resolve it, and one
 * FlexPrice API key spans the whole tenant — every org is a customer inside the
 * same environment. So a stale, hand-edited, or mis-provisioned account record
 * would answer with *another org's* balance, packs and ledger, and nothing in the
 * read path would notice: the numbers are well-formed and the wallet id is real.
 *
 * This module turns "the store says so" into "FlexPrice agrees". The proof is
 * `GET /v1/customers/external/{orgId}` → `GET /v1/customers/{id}/wallets` → the
 * asked-for wallet id is in that list, which is exactly the resolution the gate
 * already performs when it has no cached id — so it is a check that reuses the
 * shape of the existing read, not a new privilege.
 *
 * Failure modes are separated deliberately:
 *   - `wallet_org_mismatch`   FlexPrice answered, and the answer is "not yours".
 *                             Fail closed: this is the case the module exists for.
 *   - `customer_missing`      FlexPrice has no customer for this org, so nothing
 *                             about the stored wallet id can be proven. Fail closed.
 *   - anything else (a 5xx, a timeout) rethrown unchanged: FlexPrice being
 *     unreachable is not evidence of a cross-tenant record, and the callers'
 *     existing outage handling (stale view, degraded read) is the right answer.
 *
 * Verification is memoized per wallet id, so the gate's 15-second balance refresh
 * does not pay two extra reads every time.
 */

const log = require('../logger');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const KIND = Object.freeze({
  missing: 'wallet_missing',
  mismatch: 'wallet_org_mismatch',
  customerMissing: 'customer_missing',
});

class WalletScopeError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'WalletScopeError';
    this.kind = kind;
    // `status` keeps the shape the billing reads already branch on for provider
    // errors; a scope failure is not a 404 from FlexPrice, so it says 403.
    this.status = extra.status || 403;
    Object.assign(this, extra);
  }
}

/** The customer id, as the SDK's flat `CustomerResponse` answers it. */
function customerIdOf(customer) {
  if (!customer || typeof customer !== 'object') return null;
  return String(customer.id || '').trim() || null;
}

function walletIdsOf(wallets) {
  return (Array.isArray(wallets) ? wallets : [])
    .map((w) => String((w && w.id) || '').trim())
    .filter(Boolean);
}

function createWalletScope({
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  logger = log,
  rowsOf = (out) => (Array.isArray(out) ? out : (out && Array.isArray(out.items) ? out.items : [])),
} = {}) {
  // `${orgId}\0${walletId}` -> { orgId, customerId, at }.
  //
  // Keyed by the CLAIM, not by the wallet: two orgs asserting one wallet cannot
  // both be true, and whichever asked first must not vouch for the other. The NUL
  // separator is not a collision risk the way `:` or `|` would be — neither id is
  // allowed to contain one.
  const proven = new Map();

  const claimKey = (orgId, walletId) => `${orgId}\u0000${walletId}`;

  function memoFor(orgId, walletId) {
    const key = claimKey(orgId, walletId);
    const hit = proven.get(key);
    if (!hit) return null;
    if (now() - hit.at >= ttlMs) {
      proven.delete(key);
      return null;
    }
    return hit;
  }

  async function assertWalletOwnership(client, orgId, walletId) {
    const wanted = String(walletId || '').trim();
    const org = String(orgId || '').trim();
    if (!wanted) throw new WalletScopeError(KIND.missing, `no wallet id to verify for org ${org}`);
    if (!org) throw new WalletScopeError(KIND.missing, 'cannot verify a wallet without an org id');

    const cached = memoFor(org, wanted);
    if (cached) return { verified: true, cached: true, customerId: cached.customerId };

    let customer;
    try {
      customer = await client.getCustomerByExternalId(org);
    } catch (err) {
      if (err && err.status === 404) {
        // The org has no customer, so the stored wallet id cannot be its own. This
        // is the mis-provisioned-record case, not an outage.
        logger.error('billing_flexprice_wallet_org_mismatch', { orgId: org, walletId: wanted, detail: 'customer_missing' });
        throw new WalletScopeError(KIND.customerMissing, `FlexPrice has no customer for org ${org}, so wallet ${wanted} cannot be verified`, {
          orgId: org, walletId: wanted,
        });
      }
      throw err;
    }
    const customerId = customerIdOf(customer);
    if (!customerId) {
      logger.error('billing_flexprice_wallet_org_mismatch', { orgId: org, walletId: wanted, detail: 'customer_id_unreadable' });
      throw new WalletScopeError(KIND.customerMissing, `FlexPrice returned no customer id for org ${org}`, {
        orgId: org, walletId: wanted,
      });
    }

    const wallets = rowsOf(await client.listWalletsByCustomer(customerId));
    const ids = walletIdsOf(wallets);
    if (!ids.includes(wanted)) {
      logger.error('billing_flexprice_wallet_org_mismatch', {
        orgId: org,
        walletId: wanted,
        customerId,
        // The org's own wallet ids: enough to spot a swapped record without
        // turning an error log into a tenant directory.
        expectedWalletIds: ids.slice(0, 5),
      });
      throw new WalletScopeError(KIND.mismatch, `wallet ${wanted} is not a wallet of org ${org}`, {
        orgId: org, walletId: wanted, customerId,
      });
    }

    proven.set(claimKey(org, wanted), { orgId: org, customerId, at: now() });
    return { verified: true, cached: false, customerId };
  }

  /** Record a proof made by a resolution that derived the wallet from the customer. */
  function remember(orgId, walletId, customerId) {
    const wanted = String(walletId || '').trim();
    const org = String(orgId || '').trim();
    if (!wanted || !org) return;
    proven.set(claimKey(org, wanted), { orgId: org, customerId: customerId || null, at: now() });
  }

  function forget(orgId = null) {
    if (orgId === null) {
      proven.clear();
      return { cleared: 'all' };
    }
    const org = String(orgId).trim();
    let cleared = 0;
    for (const [key, hit] of [...proven.entries()]) {
      if (hit.orgId === org) {
        proven.delete(key);
        cleared += 1;
      }
    }
    return { cleared, orgId: org };
  }

  return { assertWalletOwnership, remember, forget, size: () => proven.size, KIND };
}

// The process-wide instance: the gate, the read routes and the jobs all ask the
// same question about the same wallet, and two caches of "whose is this" would be
// two answers.
const shared = createWalletScope();

module.exports = {
  KIND,
  WalletScopeError,
  createWalletScope,
  customerIdOf,
  DEFAULT_TTL_MS,
  assertWalletOwnership: shared.assertWalletOwnership,
  rememberOwnership: shared.remember,
  forgetOwnership: shared.forget,
};
