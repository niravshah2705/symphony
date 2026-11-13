#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'deploy', 'flexprice', '.env');
const DEFAULT_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_EXPIRY_TIMEOUT_MS = 140 * 60 * 1000;
const MIN_EXPIRY_TIMEOUT_MS = 1_000;
const MAX_EXPIRY_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const PLATFORM_MONTH = '2099-12';

function parseEnvFile(file) {
  const values = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return values;
    throw err;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(rawLine);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      if (end < 0) continue;
      value = value.slice(1, end);
    } else if (value.startsWith('"')) {
      let escaped = false;
      let end = -1;
      for (let i = 1; i < value.length; i += 1) {
        if (!escaped && value[i] === '"') { end = i; break; }
        escaped = !escaped && value[i] === '\\';
        if (value[i] !== '\\') escaped = false;
      }
      if (end < 0) continue;
      value = value.slice(1, end).replace(/\\n/g, '\n').replace(/\\r/g, '\r')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function parseArgs(argv) {
  const flags = { keep: false, baseUrl: '', expiryTimeoutMs: DEFAULT_EXPIRY_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') flags.keep = true;
    else if (arg === '--base-url' || arg === '--expiry-timeout-ms') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      const value = argv[++i];
      if (arg === '--base-url') flags.baseUrl = value;
      else flags.expiryTimeoutMs = Number(value);
    } else if (arg.startsWith('--base-url=')) flags.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--expiry-timeout-ms=')) {
      flags.expiryTimeoutMs = Number(arg.slice('--expiry-timeout-ms='.length));
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(flags.expiryTimeoutMs)
    || flags.expiryTimeoutMs < MIN_EXPIRY_TIMEOUT_MS
    || flags.expiryTimeoutMs > MAX_EXPIRY_TIMEOUT_MS) {
    throw new Error(`--expiry-timeout-ms must be an integer from ${MIN_EXPIRY_TIMEOUT_MS} to ${MAX_EXPIRY_TIMEOUT_MS}`);
  }
  if (flags.baseUrl && !/^https?:\/\//.test(flags.baseUrl)) {
    throw new Error('--base-url must be an http(s) URL');
  }
  return flags;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const stack = parseEnvFile(ENV_FILE);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-phase5-verify-'));
  const results = [];
  const identities = {};

  function check(name, ok, detail = '') {
    const passed = Boolean(ok);
    results.push({ name, ok: passed, ...(detail ? { detail: String(detail) } : {}) });
    console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    return passed;
  }

  function section(name) {
    console.log(`\n${name}`);
  }

  function rowsOf(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.items)) return payload.items;
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
  }

  let fatal = null;
  try {
    const ingestKey = process.env.FLEXPRICE_API_KEY_INGEST || stack.FLEXPRICE_API_KEY_INGEST || '';
    const moneyKey = process.env.FLEXPRICE_API_KEY_MONEY || stack.FLEXPRICE_API_KEY_MONEY || '';
    const baseUrl = (flags.baseUrl || process.env.FLEXPRICE_BASE_URL
      || stack.FLEXPRICE_BASE_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
    const parsedBaseUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)
      || parsedBaseUrl.username || parsedBaseUrl.password) {
      throw new Error('FlexPrice base URL must be an http(s) origin without embedded credentials');
    }

    // Config is frozen at require time, so all service inputs are installed first.
    process.env.NODE_ENV = 'test';
    process.env.STORE_BACKEND = 'file';
    process.env.AI_FLEET_DATA_DIR = dataDir;
    process.env.FLEXPRICE_ENABLED = 'true';
    process.env.FLEXPRICE_BASE_URL = baseUrl;
    process.env.FLEXPRICE_ENVIRONMENT_ID = process.env.FLEXPRICE_ENVIRONMENT_ID
      || stack.FLEXPRICE_ENVIRONMENT_ID || DEFAULT_ENVIRONMENT_ID;
    process.env.FLEXPRICE_API_KEY_INGEST = ingestKey;
    process.env.FLEXPRICE_API_KEY_MONEY = moneyKey;
    process.env.FLEXPRICE_SUPPLIER_STATE_CODE = process.env.FLEXPRICE_SUPPLIER_STATE_CODE
      || stack.FLEXPRICE_SUPPLIER_STATE_CODE || '24';
    if (!process.env.FLEXPRICE_TEMPORAL_ADDR && stack.FLEXPRICE_TEMPORAL_ADDR) {
      process.env.FLEXPRICE_TEMPORAL_ADDR = stack.FLEXPRICE_TEMPORAL_ADDR;
    }
    for (const name of ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY', 'CASHFREE_ENV',
      'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_BASE_URL']) delete process.env[name];

    const store = require('@ai-fleet/shared-core/store');
    const flexpriceConfig = require('@ai-fleet/shared-core/billing/flexprice-config');
    const { createFlexpriceClient } = require('@ai-fleet/shared-core/billing/flexprice-client');
    const { chargeAccount, keysFor, invoiceSearch } = require('../services/billing/src/platform-charge-job');
    const client = createFlexpriceClient({ config: flexpriceConfig.FLEXPRICE });
    const gateApi = { invalidate() {} };

    await store.initStore();
    console.log('AI Fleet — Phase 5 live FlexPrice verification');
    console.log(`FlexPrice enabled; plane keys ${moneyKey && ingestKey ? 'present' : 'missing'}`);
    console.log(`expiry timeout ${flags.expiryTimeoutMs}ms`);

    section('boot');
    check('money and ingest plane keys are configured', Boolean(moneyKey && ingestKey));
    const health = await client.getHealth().then((value) => ({ ok: true, value }), (err) => ({ ok: false, err }));
    check('local FlexPrice /health is reachable', health.ok,
      health.ok ? 'reachable' : health.err.message);
    const temporal = await flexpriceConfig.assertTemporalReachable()
      .then((addr) => ({ ok: true, addr }), (err) => ({ ok: false, err }));
    check('Temporal is reachable', temporal.ok, temporal.ok ? temporal.addr : temporal.err.message);
    if (!moneyKey || !ingestKey || !health.ok || !temporal.ok) {
      throw new Error('boot prerequisites unmet');
    }

    async function balance(walletId) {
      const out = await client.walletRealTimeBalance(walletId);
      const value = Number(out && out.real_time_credit_balance);
      if (!Number.isFinite(value)) throw new Error(`wallet ${walletId} returned no readable balance`);
      return value;
    }

    async function creditRows(walletId) {
      return rowsOf(await client.walletTransactionsSearch({ id: walletId, type: 'credit', limit: 100 }));
    }

    async function debitRows(walletId, idempotencyKey) {
      const out = await client.walletTransactionsSearch({
        id: walletId,
        type: 'debit',
        filters: [{
          field: 'idempotency_key',
          operator: 'eq',
          data_type: 'string',
          value: { string: idempotencyKey },
        }],
        limit: 2,
      });
      return rowsOf(out).filter((row) => row.idempotency_key === idempotencyKey);
    }

    async function ensureAccount(orgId) {
      let customer;
      try {
        customer = await client.getCustomerByExternalId(orgId);
      } catch (err) {
        if (err.status !== 404) throw err;
        customer = await client.createCustomer({
          external_id: orgId,
          name: `Phase 5 verify ${orgId}`,
          address_line1: 'Local verification only',
          address_country: 'IN',
        });
      }
      if (!customer || !customer.id) throw new Error(`customer unresolved for ${orgId}`);
      const listed = await client.listWalletsByCustomer(customer.id);
      let wallet = rowsOf(listed).find((item) => String(item.currency || '').toUpperCase() === 'INR'
        && String(item.wallet_type || '').toUpperCase() === 'PRE_PAID');
      if (!wallet) {
        wallet = await client.createWallet({
          external_customer_id: orgId,
          currency: 'INR',
          wallet_type: 'PRE_PAID',
          name: `Phase 5 verify ${orgId}`,
          conversion_rate: '1',
        });
      }
      const conversionRate = String(wallet && wallet.conversion_rate == null ? '1' : wallet.conversion_rate);
      if (!wallet || !wallet.id) throw new Error(`wallet unresolved for ${orgId}`);
      if (Number(conversionRate) !== 1) throw new Error(`wallet ${wallet.id} conversion_rate is ${conversionRate}`);
      const account = store.upsertBillingAccount(orgId, {
        flexprice: { customerId: customer.id, walletId: wallet.id, conversionRate },
      });
      const saved = store.getBillingAccount(orgId);
      check('customer/wallet identity persisted to temporary store',
        saved?.flexprice?.customerId === customer.id
          && saved?.flexprice?.walletId === wallet.id
          && Number(saved?.flexprice?.conversionRate) === 1,
        `org=${orgId}`);
      return account;
    }

    async function purchasedTopUp(account, credits, key) {
      const walletId = account.flexprice.walletId;
      const before = await balance(walletId);
      await client.topUpWallet(walletId, {
        transaction_reason: 'PURCHASED_CREDIT_DIRECT',
        credits_to_add: String(credits),
        priority: 1,
        description: 'Phase 5 local verification fixture',
      }, { idempotencyKey: key });
      const after = await balance(walletId);
      check(`purchased top-up adds exactly ${credits} credits`, after - before === credits,
        `${before} -> ${after}`);
      return after;
    }

    section('platform charge');
    const chargedOrg = randomUUID();
    const chargedAccount = await ensureAccount(chargedOrg);
    identities.platformOrgId = chargedOrg;
    identities.platformWalletId = chargedAccount.flexprice.walletId;
    const platformTopUpKey = `phase5-platform-topup:${randomUUID()}`;
    const fundedBalance = await purchasedTopUp(chargedAccount, 4000, platformTopUpKey);
    check('platform fixture starts at exactly 4000 credits', fundedBalance === 4000, `balance=${fundedBalance}`);
    const chargeOptions = { client, month: PLATFORM_MONTH, dryRun: false, gateApi };
    const first = await chargeAccount(chargedAccount, chargeOptions);
    const second = await chargeAccount(chargedAccount, chargeOptions);
    check('first platform charge is charged', first.status === 'charged', `status=${first.status}`);
    check('second platform charge is already_charged', second.status === 'already_charged', `status=${second.status}`);
    check('both runs resolve the same invoice identity', Boolean(first.invoiceId)
      && first.invoiceId === second.invoiceId, `invoice=${first.invoiceId || '(none)'}`);
    identities.platformInvoiceId = first.invoiceId || null;
    const chargedBalance = await balance(chargedAccount.flexprice.walletId);
    check('real-time balance falls by exactly 3000', fundedBalance - chargedBalance === 3000
      && chargedBalance === 1000, `${fundedBalance} -> ${chargedBalance}`);

    const platformKeys = keysFor(chargedOrg, PLATFORM_MONTH);
    const invoiceRows = rowsOf(await client.searchInvoices(invoiceSearch(platformKeys.invoice)))
      .filter((invoice) => invoice.idempotency_key === platformKeys.invoice);
    check('exact invoice-key search returns one invoice', invoiceRows.length === 1,
      `matches=${invoiceRows.length}`);
    check('invoice search resolves the charged invoice identity', invoiceRows[0]?.id === first.invoiceId,
      `invoice=${invoiceRows[0]?.id || '(none)'}`);
    const platformDebits = await debitRows(chargedAccount.flexprice.walletId, platformKeys.debit);
    check('exact debit-key search finds one logical 3000-credit manual debit',
      platformDebits.length === 1
        && platformDebits[0].transaction_reason === 'MANUAL_BALANCE_DEBIT'
        && Number(platformDebits[0].amount) === 3000,
      `matches=${platformDebits.length} amount=${platformDebits[0]?.amount || '(none)'}`);

    section('insufficient platform balance');
    const poorOrg = randomUUID();
    const poorAccount = await ensureAccount(poorOrg);
    identities.insufficientOrgId = poorOrg;
    identities.insufficientWalletId = poorAccount.flexprice.walletId;
    const poorBefore = await purchasedTopUp(poorAccount, 2999, `phase5-insufficient-topup:${randomUUID()}`);
    const poorResult = await chargeAccount(poorAccount, chargeOptions);
    check('2999-credit account is insufficient_balance', poorResult.status === 'insufficient_balance',
      `status=${poorResult.status}`);
    const poorKeys = keysFor(poorOrg, PLATFORM_MONTH);
    const poorInvoices = rowsOf(await client.searchInvoices(invoiceSearch(poorKeys.invoice)))
      .filter((invoice) => invoice.idempotency_key === poorKeys.invoice);
    check('insufficient account creates no invoice', poorInvoices.length === 0, `matches=${poorInvoices.length}`);
    const poorDebits = await debitRows(poorAccount.flexprice.walletId, poorKeys.debit);
    check('insufficient account creates no matching debit', poorDebits.length === 0, `matches=${poorDebits.length}`);
    const poorAfter = await balance(poorAccount.flexprice.walletId);
    check('insufficient account balance is unchanged', poorBefore === 2999 && poorAfter === poorBefore,
      `${poorBefore} -> ${poorAfter}`);

    section('expired promotional credit draw');
    const expiryOrg = randomUUID();
    const expiryAccount = await ensureAccount(expiryOrg);
    const expiryWalletId = expiryAccount.flexprice.walletId;
    identities.expiryOrgId = expiryOrg;
    identities.expiryWalletId = expiryWalletId;
    const purchaseKey = `phase5-expiry-purchased:${randomUUID()}`;
    const promoKey = `phase5-expiry-promo:${randomUUID()}`;
    const debitKey = `phase5-expiry-debit:${randomUUID()}`;
    await purchasedTopUp(expiryAccount, 100, purchaseKey);
    const promoExpiresAt = new Date(Date.now() + 3000);
    await client.grantPromo(expiryWalletId, {
      credits: 50,
      expiresAt: promoExpiresAt.toISOString(),
      priority: 0,
      idempotencyKey: promoKey,
      description: 'Phase 5 expiring promotional fixture',
    });

    const beforeRows = await creditRows(expiryWalletId);
    const beforePurchased = beforeRows.find((row) => row.idempotency_key === purchaseKey);
    const beforePromo = beforeRows.find((row) => row.idempotency_key === promoKey);
    check('snapshot contains the 100-credit purchased row', Number(beforePurchased?.credits_available) === 100,
      `available=${beforePurchased?.credits_available || '(missing)'}`);
    check('snapshot contains the expiring FREE_CREDIT_GRANT row', beforePromo?.transaction_reason === 'FREE_CREDIT_GRANT'
      && Number(beforePromo?.credit_amount) === 50, `reason=${beforePromo?.transaction_reason || '(missing)'}`);

    await sleep(Math.max(0, promoExpiresAt.getTime() - Date.now() + 250));
    await client.debitWallet(expiryWalletId, {
      credits: '25',
      idempotencyKey: debitKey,
      description: 'Phase 5 expired-credit draw proof',
    });
    const afterRows = await creditRows(expiryWalletId);
    const afterPurchased = afterRows.find((row) => row.idempotency_key === purchaseKey);
    const afterPromo = afterRows.find((row) => row.idempotency_key === promoKey);
    check('debit reduces purchased row from 100 to 75', Number(beforePurchased?.credits_available) === 100
      && Number(afterPurchased?.credits_available) === 75,
      `${beforePurchased?.credits_available || '(missing)'} -> ${afterPurchased?.credits_available || '(missing)'}`);
    const promoBeforeAvailable = Number(beforePromo?.credits_available);
    const promoAfterAvailable = Number(afterPromo?.credits_available);
    check('expired promo is not drawn by the debit', promoAfterAvailable === promoBeforeAvailable
      || promoAfterAvailable === 0,
    `${beforePromo?.credits_available ?? '(missing)'} -> ${afterPromo?.credits_available ?? '(missing)'}`);

    const deadline = Date.now() + flags.expiryTimeoutMs;
    let expiredRows = [];
    do {
      const transactions = rowsOf(await client.walletTransactionsSearch({ id: expiryWalletId, limit: 100 }));
      expiredRows = transactions.filter((row) => row.transaction_reason === 'CREDIT_EXPIRED');
      if (expiredRows.length) break;
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    check('Temporal materializes one CREDIT_EXPIRED transaction before the deadline', expiredRows.length === 1,
      `matches=${expiredRows.length}`);
  } catch (err) {
    fatal = err;
    if (err.message !== 'boot prerequisites unmet') {
      check('verification completed without an exception', false, err.message);
    }
  } finally {
    const failed = results.filter((result) => !result.ok);
    const summary = {
      ok: failed.length === 0 && fatal === null,
      checks: results.length,
      passed: results.length - failed.length,
      failed: failed.map((result) => result.name),
      month: PLATFORM_MONTH,
      expiryTimeoutMs: flags.expiryTimeoutMs,
      identities,
      storeKept: flags.keep,
    };
    console.log(`\nsummary ${JSON.stringify(summary)}`);
    if (!flags.keep) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`store retained at ${dataDir}`);
    process.exitCode = summary.ok ? 0 : 1;
  }
}

main().catch((err) => {
  console.error(`phase5 verify failed: ${err.message}`);
  process.exitCode = 1;
});
