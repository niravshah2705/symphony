'use strict';

/**
 * The recharge settlement path — the only code in this repository that may add
 * spendable credit.
 *
 * Every earlier path failed the same way: the number to credit was taken from
 * whatever the caller presented (a browser-quoted order id, a webhook amount), so
 * one org could credit itself and one forged payload could set its own price.
 * `settle()` inverts that. The intent, written at quote time, is the authority;
 * the provider is asked to confirm the intent, never to define it; and FlexPrice
 * is asked to confirm the credit it applied. In order:
 *
 *   1. the intent exists;
 *   2. it belongs to the caller's org (the org comes from the gateway header, so
 *      it is never a value the client chose);
 *   3. it has not been settled — `QUOTED → SETTLED` happens once;
 *   4. the GST recomputes to the totals the intent carries — a quote that cannot
 *      be reproduced from its own inputs is not a quote we agreed to;
 *   5. the provider says PAID for exactly `totalPaise` (₹590 for a ₹500 recharge);
 *   6. the wallet is credited `paiseToCredits(subtotalPaise)` — the *subtotal*,
 *      so the ₹90 GST never becomes spendable — and the read-back agrees.
 *
 * Two gates are deliberately here rather than in the adapters:
 *
 *   - `BILLING_ALLOW_MOCK_PAYMENTS` is read ONLY in this file. An unconfigured
 *     Cashfree client answers `getOrder` with a fabricated PAID/₹100
 *     (`cashfree-client.js:246-254`); that is a dev affordance, not a payment, so
 *     without the flag it is refused with `mock_payment_not_accepted`. With it,
 *     the *intent* is still the amount authority — the mock's ₹100 is never used.
 *   - `FLEXPRICE_ENABLED` must be on. There is no dual-write fallback (decision
 *     D5): a settlement that could not reach the wallet is a failure to settle,
 *     not a reason to credit the old first-party balance.
 */

const { CONFIG } = require('@ai-fleet/shared-core/config');
const store = require('@ai-fleet/shared-core/store');
const log = require('@ai-fleet/shared-core/logger');
const gst = require('@ai-fleet/shared-core/billing/gst');
const credits = require('@ai-fleet/shared-core/billing/credits');
const moneyWire = require('@ai-fleet/shared-core/billing/money-wire');
const { createFlexpriceClient } = require('@ai-fleet/shared-core/billing/flexprice-client');
const providers = require('./payment-providers');

const CURRENCY = 'INR';
// Credit rows FlexPrice draws on by `priority`: promotional (0) before purchased (1).
const PRIORITY_PURCHASED = 1;

class SettleError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'SettleError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function allowsMockPayments(env = process.env) {
  return String(env.BILLING_ALLOW_MOCK_PAYMENTS || '').trim().toLowerCase() === 'true';
}

/**
 * Re-derive the quote from the intent's own inputs. The intent's `gstPaise` /
 * `totalPaise` are what the customer was shown; this recomputes them from
 * subtotal + coupon + place of supply, and a disagreement is a bug or tampering,
 * not a rounding difference.
 */
function requote(intent, flexpriceConfig) {
  const supplierStateCode = intent.supplierStateCode || (flexpriceConfig && flexpriceConfig.supplierStateCode) || '';
  if (!supplierStateCode) {
    throw new SettleError(503, 'supplier_state_not_configured',
      'FLEXPRICE_SUPPLIER_STATE_CODE is not set, so the GST on this recharge cannot be recomputed.');
  }
  const inputs = { subtotalPaise: intent.subtotalPaise, supplierStateCode };
  if (intent.couponBps) inputs.couponBps = intent.couponBps;
  if (intent.customerGstin) inputs.customerGstin = intent.customerGstin;
  if (intent.customerStateCode) inputs.customerStateCode = intent.customerStateCode;
  try {
    return gst.quote(inputs);
  } catch (err) {
    throw new SettleError(400, 'quote_invalid', `This recharge can no longer be quoted: ${err.message}`);
  }
}

function wholeCredits(paise, label) {
  try {
    return moneyWire.paiseToCredits(paise);
  } catch (err) {
    throw new SettleError(400, 'not_whole_credit',
      `${label} must be a whole number of rupees (1 credit = ₹1): ${err.message}`);
  }
}

async function readCredits(client, walletId) {
  let balance;
  try {
    balance = await client.walletRealTimeBalance(walletId);
  } catch (err) {
    throw new SettleError(502, 'flexprice_balance_unreadable',
      `FlexPrice did not return the wallet balance: ${err.message}`);
  }
  const creditBalance = Number(balance && balance.real_time_credit_balance);
  if (!Number.isFinite(creditBalance)) {
    throw new SettleError(502, 'flexprice_balance_unreadable',
      `FlexPrice returned no readable real_time_credit_balance for wallet ${walletId}.`);
  }
  return { credits: creditBalance, raw: balance };
}

/**
 * Flat `address_*` fields, never the nested `billing_address` — the nested form is
 * accepted at 201 and silently drops every field, and the state in it is what
 * decides CGST/SGST vs IGST on the invoice FlexPrice later renders.
 */
function customerBody(orgId, paymentInfo = {}) {
  const address = paymentInfo.address || {};
  const body = {
    external_id: orgId,
    name: paymentInfo.billingName || orgId,
    address_line1: String(address.line1 || 'Not provided').slice(0, 120),
    address_city: String(address.city || 'Not provided').slice(0, 60),
    address_state: String(address.state || 'Not provided').slice(0, 60),
    address_postal_code: String(address.postalCode || '').slice(0, 20),
    address_country: String(address.country || 'IN').slice(0, 10),
    metadata: { fleet_org_id: orgId, gstin: String(paymentInfo.taxId || '') },
  };
  return body;
}

/**
 * The org's INR prepaid wallet, creating the customer and wallet if the cache on
 * the billing account has been lost. `conversion_rate` is asserted rather than
 * assumed: probe A measured that `credits_to_add` is denominated in credits, so a
 * rate other than 1 would silently change what those credits are *worth*.
 */
async function ensureWallet({ client, orgId, account, storeImpl, now }) {
  const cached = (account && account.flexprice) || {};
  const found = await (async () => {
    let customer = null;
    try {
      customer = await client.getCustomerByExternalId(orgId);
    } catch (err) {
      if (err.status !== 404) {
        throw new SettleError(502, 'flexprice_customer_unreadable', `FlexPrice customer lookup failed: ${err.message}`);
      }
    }
    if (!customer || !customer.id) {
      // `|| {}` and not the default parameter: an org that has never opened the
      // billing page has no account document at all, and `account && account.paymentInfo`
      // is then `null` — which a `= {}` default does not replace.
      customer = await client.createCustomer(customerBody(orgId, (account && account.paymentInfo) || {}));
      if (!customer || !customer.id) {
        throw new SettleError(502, 'flexprice_customer_uncreated', 'FlexPrice accepted no customer for this org.');
      }
    }
    const listed = await client.listWalletsByCustomer(customer.id);
    // `currency` comes back lowercase ('inr') from the route, so the comparison
    // is case-insensitive by necessity, not by taste.
    let wallet = (listed.items || []).find(
      (w) => String(w.currency || '').toUpperCase() === CURRENCY
        && String(w.wallet_type || '').toUpperCase() === 'PRE_PAID',
    );
    if (!wallet) {
      wallet = await client.createWallet({
        external_customer_id: orgId,
        currency: CURRENCY,
        wallet_type: 'PRE_PAID',
        name: `${(account && account.paymentInfo && account.paymentInfo.billingName) || orgId} wallet`,
        conversion_rate: '1',
      });
    }
    if (!wallet || !wallet.id) {
      // Never carry an absent id into the credit call: a wallet we did not resolve
      // means the money has nowhere to go, and the 404 from
      // `/v1/wallets/undefined/...` would read as a FlexPrice outage.
      throw new SettleError(502, 'flexprice_wallet_unresolved',
        `FlexPrice gave no INR prepaid wallet for ${orgId}, so this recharge has nowhere to be credited.`);
    }
    return { customerId: customer.id, wallet };
  })();

  const rate = String(found.wallet.conversion_rate == null ? '1' : found.wallet.conversion_rate);
  if (Number(rate) !== 1) {
    throw new SettleError(500, 'wallet_conversion_rate',
      `Wallet ${found.wallet.id} has conversion_rate ${rate}, not 1: 1 credit is not ₹1 here, so this recharge would credit the wrong value.`);
  }
  // The ids are cached, not invented: the next recharge (and the Phase 3 gate)
  // reads them from the account instead of walking the customer API again.
  storeImpl.upsertBillingAccount(orgId, {
    flexprice: { customerId: found.customerId, walletId: found.wallet.id, conversionRate: rate, cachedAt: now() },
  });
  return { customerId: found.customerId, walletId: found.wallet.id };
}

/**
 * Settle one recharge intent.
 *
 * @param {object} args
 * @param {string} args.orderId      the intent id (`order_<org>_<ts>`)
 * @param {string} [args.orgId]      the caller's org — required from a browser
 *                                   route; omitted only by the webhook, where the
 *                                   provider signature is the authority and the
 *                                   org comes from the intent itself.
 * @param {string} [args.actor]      who/what triggered it, for the audit log
 * @param {object} [deps]            test seams: store, providerSet, flexpriceClient,
 *                                   flexpriceConfig, env, now
 * @returns {object} { status, orderId, credits, balanceCredits, mock, ... }
 */
async function settle({ orderId, orgId: callerOrgId, actor = 'unknown' } = {}, deps = {}) {
  const storeImpl = deps.store || store;
  const providerSet = deps.providers || providers;
  const flexpriceConfig = deps.flexpriceConfig || CONFIG.FLEXPRICE;
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date().toISOString());
  const logImpl = deps.log || log;
  const gateImpl = deps.gate || require('@ai-fleet/shared-core/billing/gate');

  const key = String(orderId || '').trim();
  if (!key) throw new SettleError(400, 'missing_order_id', 'orderId is required.');

  // 1 + 2: exists, and is the caller's.
  const intent = storeImpl.getRechargeIntent(key);
  if (!intent) {
    throw new SettleError(404, 'intent_not_found',
      `No recharge intent for ${key}. Only an order this server quoted can be settled.`);
  }
  if (callerOrgId && intent.orgId !== callerOrgId) {
    logImpl.warn('recharge_settle_cross_org', { orderId: key, ownerOrgId: intent.orgId, callerOrgId, actor });
    throw new SettleError(403, 'order_not_mine',
      'That order belongs to a different organization.');
  }
  const orgId = intent.orgId;

  // 3: once, and only forward.
  if (intent.status === 'SETTLED') {
    return {
      status: 'already_processed',
      orderId: key,
      orgId,
      creditCount: intent.creditCount,
      totalPaise: intent.totalPaise,
      settledAt: intent.settledAt || null,
    };
  }
  if (intent.status !== 'QUOTED') {
    throw new SettleError(409, 'intent_not_settleable', `Intent is ${intent.status}, not QUOTED.`);
  }

  // 4: the money re-derives, or the settlement stops.
  const quote = requote(intent, flexpriceConfig);
  if (quote.gstPaise !== intent.gstPaise || quote.totalPaise !== intent.totalPaise) {
    throw new SettleError(500, 'quote_drift',
      `This order was quoted at ₹${moneyWire.decimalFromPaise(intent.totalPaise)} (tax ₹${moneyWire.decimalFromPaise(intent.gstPaise)}), which no longer recomputes to ₹${moneyWire.decimalFromPaise(quote.totalPaise)} (tax ₹${moneyWire.decimalFromPaise(quote.gstPaise)}). Nothing was credited.`,
      { intent, quote: { gstPaise: quote.gstPaise, totalPaise: quote.totalPaise } });
  }

  const crediting = credits.topUpCrediting({ quote, expiresAt: intent.promoExpiresAt || null });
  const prepaidCredits = wholeCredits(crediting.prepaidPaise, 'the recharge amount');
  const promoCredits = wholeCredits(crediting.promoPaise, 'the coupon bonus');
  if (intent.creditCount != null && intent.creditCount !== prepaidCredits) {
    throw new SettleError(500, 'credit_count_drift',
      `The intent records ${intent.creditCount} credits but ₹${moneyWire.decimalFromPaise(intent.subtotalPaise)} is ${prepaidCredits} credits.`);
  }
  // Before any write: the number about to be credited must not be the taxed total.
  credits.assertNoTaxCredited({ amountPaise: crediting.prepaidPaise, quote });

  if (!flexpriceConfig.enabled) {
    throw new SettleError(503, 'flexprice_disabled',
      'FlexPrice is disabled on this deployment, so there is no wallet to credit. Nothing was credited; re-run once FLEXPRICE_ENABLED is set.');
  }

  // 5: the provider confirms the intent's gross.
  const adapter = providerSet.providerFor(intent.provider, { env });
  let verification;
  if (adapter.isConfigured()) {
    verification = await adapter.verify(intent.providerOrderId || key);
  } else if (allowsMockPayments(env)) {
    verification = {
      status: providers.PAYMENT.PAID,
      // The mock reports the intent's own amount, never its canned ₹100: the
      // amount assertion below is only meaningful if the ask came from us.
      amountDecimal: moneyWire.decimalFromPaise(intent.totalPaise),
      providerOrderId: null,
      mock: true,
    };
  } else {
    throw new SettleError(402, 'mock_payment_not_accepted',
      `${adapter.name} is not configured on this server, so no payment could be verified. Set ${adapter.name.toUpperCase()}_* keys, or BILLING_ALLOW_MOCK_PAYMENTS=true for local development only.`);
  }
  if (verification.status !== providers.PAYMENT.PAID) {
    throw new SettleError(402, 'payment_not_captured',
      `${adapter.name} reports the order as ${verification.status}, not PAID.`,
      { orderId: key, providerStatus: verification.status });
  }
  if (verification.amountDecimal == null || verification.amountDecimal === '') {
    throw new SettleError(502, 'provider_amount_unreadable',
      `${adapter.name} confirmed the order without reporting an amount, so it cannot be compared with the order we quoted.`);
  }
  let collectedPaise;
  try {
    collectedPaise = moneyWire.paiseFromDecimal(verification.amountDecimal);
  } catch (err) {
    throw new SettleError(502, 'provider_amount_unreadable',
      `${adapter.name} reported an amount this server cannot read ("${verification.amountDecimal}"), so it cannot be compared with the order we quoted.`);
  }
  if (collectedPaise !== intent.totalPaise) {
    throw new SettleError(402, 'amount_mismatch',
      `${adapter.name} collected ₹${moneyWire.decimalFromPaise(collectedPaise)} for an order quoted at ₹${moneyWire.decimalFromPaise(intent.totalPaise)}. Nothing was credited — reconcile this order.`,
      { orderId: key, collectedPaise, totalPaise: intent.totalPaise });
  }

  // 6: credit the wallet, then read it back.
  const client = deps.flexpriceClient || createFlexpriceClient({ config: flexpriceConfig });
  const account = storeImpl.getBillingAccount(orgId);
  const { customerId, walletId } = await ensureWallet({ client, orgId, account, storeImpl, now });

  const before = await readCredits(client, walletId);
  const topUp = await client.topUpWallet(walletId, {
    transaction_reason: 'PURCHASED_CREDIT_DIRECT',
    credits_to_add: String(prepaidCredits),
    priority: PRIORITY_PURCHASED,
    description: `Recharge ${key}`,
    metadata: {
      fleet_order_id: key,
      subtotal_paise: String(intent.subtotalPaise),
      gst_paise: String(intent.gstPaise),
      collected_paise: String(intent.totalPaise),
      provider: adapter.name,
    },
  }, { idempotencyKey: `recharge:${key}` });
  const replayTopUp = Boolean(topUp && topUp.alreadyExists);

  let promoGrant = null;
  if (promoCredits > 0) {
    promoGrant = await client.grantPromo(walletId, {
      credits: promoCredits,
      expiresAt: intent.promoExpiresAt || null,
      idempotencyKey: `recharge:${key}:promo`,
      description: `Recharge bonus ${key}`,
    });
  }

  const after = await readCredits(client, walletId);
  const delta = after.credits - before.credits;
  const expectedDelta = prepaidCredits + promoCredits;
  if (!replayTopUp && delta !== expectedDelta) {
    throw new SettleError(502, 'flexprice_credit_readback_mismatch',
      `FlexPrice credited ${delta} credits for an order worth ${expectedDelta}. Nothing was marked settled — reconcile wallet ${walletId}.`,
      { orderId: key, walletId, delta, expectedDelta, before: before.credits, after: after.credits });
  }

  const settled = storeImpl.updateRechargeIntent(key, {
    status: 'SETTLED',
    settledAt: now(),
    providerOrderId: verification.providerOrderId || intent.providerOrderId || null,
    verification: { via: adapter.name, mock: Boolean(verification.mock), collectedPaise, actor },
    flexprice_settlement: {
      customerId,
      walletId,
      prepaidCredits,
      promoCredits,
      replayTopUp,
      balanceBeforeCredits: before.credits,
      balanceAfterCredits: after.credits,
    },
  });
  if (!settled || settled.status !== 'SETTLED') {
    // The credit is already in the wallet, so this is loud on purpose: the money
    // moved and the idempotency record did not.
    logImpl.error('recharge_intent_not_marked', { orderId: key, orgId, walletId, expectedDelta });
    throw new SettleError(500, 'intent_not_marked',
      `The wallet was credited but order ${key} could not be marked settled. Do not retry blindly — reconcile.`);
  }

  // The wallet moved, so whatever this process last believed about this org is
  // now wrong in the direction that matters: an org blocked at zero is not.
  gateImpl.invalidate(orgId);

  logImpl.info('recharge_settled', {
    orderId: key,
    orgId,
    provider: adapter.name,
    subtotalPaise: intent.subtotalPaise,
    gstPaise: intent.gstPaise,
    collectedPaise,
    prepaidCredits,
    promoCredits,
    balanceCredits: after.credits,
    mock: Boolean(verification.mock),
    actor,
  });

  return {
    status: 'settled',
    orderId: key,
    orgId,
    provider: adapter.name,
    subtotalPaise: intent.subtotalPaise,
    gstPaise: intent.gstPaise,
    totalPaise: intent.totalPaise,
    collectedPaise,
    creditCount: prepaidCredits,
    promoCredits,
    balanceCredits: after.credits,
    walletId,
    mock: Boolean(verification.mock),
    settledAt: settled.settledAt,
  };
}

module.exports = {
  settle,
  allowsMockPayments,
  SettleError,
  // exported for tests — these are the steps, not API surface
  _internals: { requote, ensureWallet, customerBody, readCredits },
};
