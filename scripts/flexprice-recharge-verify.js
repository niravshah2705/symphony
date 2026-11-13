#!/usr/bin/env node
'use strict';

// Phase 2 verification: the recharge spine against the LIVE FlexPrice stack.
//
// The unit suites can only prove the REFUSAL half of `settle()` — `CONFIG` is a
// require-time frozen snapshot, so a test that wants FlexPrice enabled must
// inject fakes. This script is the other half: the real client, the real wallet,
// the real credit rows. It answers the plan's Phase 2 exit question — does a ₹500
// recharge collect ₹590 and credit exactly 500 spendable credits, with the ₹90 of
// GST nowhere near the balance — with numbers read back out of FlexPrice rather
// than asserted about a mocked response.
//
// Every step goes through the real Express app (`services/billing/src/app.js`) on
// an ephemeral loopback port, with the context headers the gateway would stamp —
// so the org is server-derived and the admin role is present. Nothing here talks
// to Cashfree or Razorpay: no keys exist in this worktree, so the payment is the
// local mock and the persisted intent is the amount authority (decision D1).
// `BILLING_ALLOW_MOCK_PAYMENTS=true` is set for that reason and only that reason;
// step 8 re-runs the same call with it off and requires a refusal.
//
// The verify org is a throwaway external_id, so the run is repeatable and leaves
// the real orgs alone. Its FlexPrice rows stay behind on purpose: they are the
// artifact to re-read with `node scripts/flexprice-inspect.js balance <wallet>`.
//
// Usage:
//   npm run billing:recharge:verify
//   npm run billing:recharge:verify -- --keep        # leave the local store dir
//   npm run billing:recharge:verify -- --base-url=http://127.0.0.1:18080

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'deploy', 'flexprice', '.env');

// The seed "Production" environment — the same id `flexprice-provision.js` uses,
// because the catalog this recharge reads was created in it.
const SEED_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';
const SUPPLIER_STATE = '24';

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const argv = process.argv.slice(2);
const flags = {
  keep: argv.includes('--keep'),
  baseUrl: (argv.find((a) => a.startsWith('--base-url=')) || '').split('=')[1] || '',
};

const stack = parseEnvFile(ENV_FILE);
const ingestKey = process.env.FLEXPRICE_API_KEY_INGEST || stack.FLEXPRICE_API_KEY_INGEST || '';
const moneyKey = process.env.FLEXPRICE_API_KEY_MONEY || stack.FLEXPRICE_API_KEY_MONEY || '';
const baseUrl = flags.baseUrl || process.env.FLEXPRICE_BASE_URL || stack.FLEXPRICE_BASE_URL || 'http://127.0.0.1:18080';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  [${ok ? 'ok  ' : 'FAIL'}] ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`);
  return Boolean(ok);
}
function section(title) {
  console.log(`\n${title}`);
}

/** One JSON request to the in-process app. Org context is headers, never a body field. */
function request(port, method, urlPath, { body, orgId, admin = true, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        ...(payload === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        }),
        ...(orgId ? {
          'x-ai-fleet-billing-org-id': orgId,
          'x-ai-fleet-billing-user-id': `verify@${orgId}`,
          'x-ai-fleet-billing-org-role': admin ? 'ORG_ADMIN' : 'ORG_MEMBER',
        } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function main() {
  if (!ingestKey || !moneyKey) {
    console.error(`no plane keys in ${ENV_FILE} — run npm run billing:flexprice:provision first`);
    process.exitCode = 1;
    return;
  }

  // Everything the services read must be in the environment BEFORE the first
  // require: `CONFIG` and `FLEXPRICE` are both frozen at require time.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-recharge-verify-'));
  process.env.NODE_ENV = 'test';
  process.env.STORE_BACKEND = 'file';
  process.env.AI_FLEET_DATA_DIR = dataDir;
  process.env.FLEXPRICE_ENABLED = 'true';
  process.env.FLEXPRICE_BASE_URL = baseUrl;
  process.env.FLEXPRICE_ENVIRONMENT_ID = process.env.FLEXPRICE_ENVIRONMENT_ID || stack.FLEXPRICE_ENVIRONMENT_ID || SEED_ENVIRONMENT_ID;
  process.env.FLEXPRICE_API_KEY_INGEST = ingestKey;
  process.env.FLEXPRICE_API_KEY_MONEY = moneyKey;
  process.env.FLEXPRICE_SUPPLIER_STATE_CODE = SUPPLIER_STATE;
  process.env.BILLING_ALLOW_MOCK_PAYMENTS = 'true';
  // This run verifies the spine with the local mock (D1), so a gateway key in the
  // operator's shell would silently change which path is under test — and send a
  // live HTTPS call. Both adapters are unconfigured here by construction.
  for (const name of ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY', 'CASHFREE_ENV',
    'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_BASE_URL']) delete process.env[name];

  const { createApp } = require(path.join(ROOT, 'services/billing/src/app.js'));
  const store = require('@ai-fleet/shared-core/store');
  const flexpriceConfig = require('@ai-fleet/shared-core/billing/flexprice-config');
  const { createFlexpriceClient } = require('@ai-fleet/shared-core/billing/flexprice-client');
  const { FLEXPRICE } = flexpriceConfig;
  const client = createFlexpriceClient({ config: FLEXPRICE });

  const orgId = `org-recharge-verify-${Date.now().toString(36)}`;

  console.log('AI Fleet — Phase 2 recharge spine, verified against the live FlexPrice stack');
  console.log(`  flexprice ${flexpriceConfig.describe(FLEXPRICE)}`);
  console.log(`  org        ${orgId}`);
  console.log(`  store dir  ${dataDir}`);

  section('boot');
  const boot = flexpriceConfig.validateForBoot(FLEXPRICE, flexpriceConfig.configMapKeyValues(ENV_FILE));
  check('validateForBoot accepts this config', boot.mode === 'enforced', `mode=${boot.mode}`);
  check('neither plane key is the stack config-map key', boot.mode === 'enforced',
    `forbidden=${flexpriceConfig.configMapKeyValues(ENV_FILE).size} value(s) in ${path.relative(ROOT, ENV_FILE)}`);
  const temporal = await flexpriceConfig.assertTemporalReachable().then((addr) => addr, (err) => err);
  check('Temporal reachable (credit expiry can run)', typeof temporal === 'string',
    typeof temporal === 'string' ? temporal : temporal.message);
  const health = await client.getHealth().catch((err) => ({ error: err.message }));
  check('FlexPrice API answers /health', Boolean(health) && !health.error, JSON.stringify(health).slice(0, 120));

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const get = (urlPath, opts = {}) => request(port, 'GET', urlPath, opts);
  const post = (urlPath, body, opts = {}) => request(port, 'POST', urlPath, { ...opts, body });
  const call = (urlPath, body) => post(urlPath, body, { orgId });
  const as = (who, urlPath, body) => post(urlPath, body, { orgId: who });

  const readBalance = async (walletId) => {
    const balance = await client.walletRealTimeBalance(walletId);
    return Number(balance.real_time_credit_balance);
  };
  const readCreditRows = async (walletId) => {
    const search = await client.walletTransactionsSearch({ id: walletId, type: 'credit', limit: 50 });
    return search.items || search.data || [];
  };

  try {
    // 1. The quote is pure server-side arithmetic and moves no money.
    section('1. quote ₹500 (POST /recharge — quote only)');
    const quoteRes = await call('/recharge', { amountInr: 500 });
    check('quote returns 200', quoteRes.status === 200, `status=${quoteRes.status} ${quoteRes.text.slice(0, 160)}`);
    const q = quoteRes.body?.quote || {};
    check('settled:false — a quote credits nothing', quoteRes.body?.settled === false, `settled=${quoteRes.body?.settled}`);
    check('subtotal 50000p + gst 9000p = total 59000p',
      q.subtotalPaise === 50000 && q.gstPaise === 9000 && q.totalPaise === 59000,
      `${q.subtotalPaise} + ${q.gstPaise} = ${q.totalPaise}`);
    check('total rendered as the decimal string "590.00"', q.totalInr === '590.00', `totalInr=${q.totalInr}`);
    const heads = (q.components || []).map((c) => c.name).sort().join(',');
    const parts = (q.components || []).map((c) => `${c.name} ${c.paise}`).join(' + ');
    check('CGST 9% 4500p + SGST 9% 4500p', heads === 'CGST,SGST'
      && (q.components || []).every((c) => c.paise === 4500), parts);
    check('credits = 500 = subtotal/100, never total/100', q.credits === 500,
      `credits=${q.credits} (total/100 would be ${Math.floor(q.totalPaise / 100)})`);
    check('place of supply assumed from the supplier state (no GSTIN saved)',
      q.placeOfSupply?.assumed === true, `state=${q.placeOfSupply?.stateCode} assumed=${q.placeOfSupply?.assumed}`);
    check('no wallet exists yet for this org', store.getBillingAccount(orgId) === null
      || !store.getBillingAccount(orgId).flexprice,
      'the wallet is created by settle(), not by a quote');

    // 2. A saved GSTIN decides the split — same state CGST+SGST, other state IGST —
    //    and never the total, which is what makes the tax visible rather than priced in.
    section('2. place of supply from the saved GSTIN (24=Gujarat supplier)');
    const saveGstin = async (taxId, state) => request(port, 'PUT', '/config', {
      orgId,
      body: {
        paymentInfo: {
          billingName: 'Verify Customer Pvt Ltd',
          billingEmail: 'verify@example.com',
          billingPhone: '9000000000',
          taxId,
          address: { line1: '1 Test Road', city: 'Gandhinagar', state, postalCode: '382010', country: 'IN' },
        },
      },
    });
    const cfgHome = await saveGstin('24AAACR1296F1Z5', 'Gujarat');
    check('PUT /config accepts a GSTIN', cfgHome.status === 200, `status=${cfgHome.status} ${cfgHome.text.slice(0, 160)}`);
    const qHome = (await call('/recharge', { amountInr: 500 })).body.quote;
    check('intra-state GSTIN 24 → CGST+SGST, assumed:false, total still 59000p',
      qHome.placeOfSupply?.assumed === false && qHome.totalPaise === 59000
      && qHome.components.map((c) => c.name).join(',') === 'CGST,SGST',
      `${qHome.components.map((c) => `${c.name} ${c.paise}`).join(' + ')} pos=${qHome.placeOfSupply.stateCode}`);
    const cfgAway = await saveGstin('27AAACR1296F1Z5', 'Maharashtra');
    check('PUT /config accepts an out-of-state GSTIN', cfgAway.status === 200, `status=${cfgAway.status}`);
    const qAway = (await call('/recharge', { amountInr: 500 })).body.quote;
    check('inter-state GSTIN 27 → one IGST 9000p, total unchanged at 59000p',
      qAway.components.length === 1 && qAway.components[0].name === 'IGST'
      && qAway.components[0].paise === 9000 && qAway.totalPaise === 59000 && qAway.credits === 500,
      `IGST ${qAway.components[0]?.paise} of ${qAway.totalPaise}, credits=${qAway.credits}`);
    const cfgBad = await saveGstin('NOT_A_GSTIN', 'Gujarat');
    check('a malformed GSTIN is refused at the write, not stored',
      cfgBad.status === 400 && cfgBad.body?.code === 'invalid_gstin',
      `status=${cfgBad.status} code=${cfgBad.body?.code}`);
    const qAfterBad = (await call('/recharge', { amountInr: 500 })).body;
    check('a rejected GSTIN changes nothing — the previously saved 27 still prices the quote',
      qAfterBad.quote.placeOfSupply.stateCode === '27' && qAfterBad.quote.gstPaise === 9000
      && !(qAfterBad.warnings || []).length,
      `pos=${qAfterBad.quote.placeOfSupply.stateCode} gst=${qAfterBad.quote.gstPaise} warnings=${JSON.stringify(qAfterBad.warnings)}`);
    // Settle the spine below on the intra-state case, which is the headline ₹45+₹45.
    await saveGstin('24AAACR1296F1Z5', 'Gujarat');

    // 3. Cashfree path: create-order persists the intent; verify-order settles it.
    section('3. Cashfree — create-order persists, verify-order settles');
    const order = await call('/recharge/create-order', { amountInr: 500, couponBps: 0 });
    check('create-order returns the mock checkout for an unconfigured gateway',
      order.status === 200 && order.body?.checkout?.mode === 'mock',
      `status=${order.status} ${order.text.slice(0, 200)}`);
    check('provider recorded as cashfree (org default) with environment named',
      order.body?.provider === 'cashfree' && typeof order.body?.environment === 'string',
      `provider=${order.body?.provider} env=${order.body?.environment}`);
    check('create-order echoes the gross as "590.00", never a provider number',
      order.body?.amountInr === '590.00', `amountInr=${order.body?.amountInr}`);
    const orderId = order.body?.orderId || '';
    check('order id is derived from the caller org, not the client',
      orderId.startsWith(`order_${orgId.replace(/[^a-zA-Z0-9_-]/g, '_')}`), orderId);

    const intent = store.getRechargeIntent(orderId);
    check('intent persisted with the full quote + provenance', Boolean(intent)
      && intent.orgId === orgId && intent.provider === 'cashfree' && intent.status === 'QUOTED'
      && intent.subtotalPaise === 50000 && intent.gstPaise === 9000 && intent.totalPaise === 59000
      && intent.creditCount === 500 && intent.supplierStateCode === SUPPLIER_STATE
      && intent.customerGstin === '24AAACR1296F1Z5' && intent.placeOfSupply?.assumed === false,
      intent ? `${intent.orgId} ${intent.provider} ${intent.status} ${intent.subtotalPaise}/${intent.gstPaise}/${intent.totalPaise}/${intent.creditCount} gstin=${intent.customerGstin}` : 'no intent');

    const settleRes = await call('/cashfree/verify-order', { orderId });
    const settled = settleRes.body || {};
    check('verify-order settles', settleRes.status === 200 && settled.status === 'settled',
      `status=${settleRes.status} ${settleRes.text.slice(0, 200)}`);
    check('settlement reports 500 credits added, ₹590.00 collected',
      settled.creditsAdded === 500 && settled.totalInr === '590.00' && settled.gstInr === '90.00'
      && settled.mock === true,
      `credits=${settled.creditsAdded} total=${settled.totalInr} gst=${settled.gstInr} mock=${settled.mock}`);

    const settledIntent = store.getRechargeIntent(orderId);
    const walletId = settledIntent.flexprice_settlement?.walletId || '';
    check('intent moved to SETTLED with the FlexPrice wallet recorded',
      settledIntent.status === 'SETTLED' && Boolean(walletId)
      && settledIntent.flexprice_settlement.prepaidCredits === 500
      && settledIntent.verification.collectedPaise === 59000,
      `${settledIntent.status} wallet=${walletId} prepaid=${settledIntent.flexprice_settlement?.prepaidCredits} collected=${settledIntent.verification?.collectedPaise}`);
    check('collected == gst + prepaid×100 + promo×100',
      settledIntent.verification.collectedPaise
        === settledIntent.gstPaise + settledIntent.flexprice_settlement.prepaidCredits * 100
        + settledIntent.flexprice_settlement.promoCredits * 100,
      `${settledIntent.verification.collectedPaise} = ${settledIntent.gstPaise} + ${settledIntent.flexprice_settlement.prepaidCredits}×100 + ${settledIntent.flexprice_settlement.promoCredits}×100`);

    const balance = await readBalance(walletId);
    check('wallet real_time_credit_balance is EXACTLY 500', balance === 500,
      `real_time_credit_balance=${balance}`);

    // 4. Replay must not double-credit — asserted against the real wallet.
    section('4. replay the same order');
    const replay = await call('/cashfree/verify-order', { orderId });
    check('replay is accepted as already-processed, not re-charged',
      replay.status === 200 && replay.body?.alreadyProcessed === true && replay.body?.creditsAdded === 500,
      `status=${replay.status} ${replay.text.slice(0, 200)}`);
    check('balance still EXACTLY 500 after the replay', await readBalance(walletId) === 500,
      `real_time_credit_balance=${await readBalance(walletId)}`);
    const rows = await readCreditRows(walletId);
    check('exactly one credit row for the settled order',
      rows.filter((r) => String(r.description || '').includes(orderId)).length === 1,
      `rows=${rows.length}`);

    // 5. Identity assertions, live.
    section('5. ownership and provenance refusals');
    const crossOrg = await as('org-recharge-verify-intruder', '/cashfree/verify-order', { orderId });
    check('another org cannot settle my order',
      crossOrg.status === 403 && crossOrg.body?.code === 'order_not_mine',
      `status=${crossOrg.status} ${crossOrg.text.slice(0, 160)}`);
    const ghost = await call('/cashfree/verify-order', { orderId: 'order_nobody_quoted' });
    check('an order id with no intent is refused',
      ghost.status === 404 && ghost.body?.code === 'intent_not_found',
      `status=${ghost.status} code=${ghost.body?.code}`);
    const noId = await call('/cashfree/verify-order', {});
    check('a missing order id is refused', noId.status === 400 && noId.body?.code === 'missing_order_id',
      `status=${noId.status} code=${noId.body?.code}`);
    const nonAdmin = await request(port, 'POST', '/cashfree/verify-order', {
      body: { orderId },
      orgId,
      admin: false,
    });
    check('a caller context with no admin role cannot mutate billing',
      nonAdmin.status === 403 && nonAdmin.body?.code === 'access_denied',
      `status=${nonAdmin.status} code=${nonAdmin.body?.code}`);
    check('none of the refusals moved the balance', await readBalance(walletId) === 500,
      `real_time_credit_balance=${await readBalance(walletId)}`);

    // 6. Coupon bonus: the promo row is a separate credit, the collected total is unchanged.
    section('6. 10% coupon bonus on a ₹500 recharge');
    const couponOrder = await call('/recharge/create-order', { amountInr: 500, couponBps: 1000 });
    const couponId = couponOrder.body?.orderId || '';
    const couponSettle = await call('/recharge/settle', { orderId: couponId });
    check('coupon settle reports 500 paid + 50 bonus credits',
      couponSettle.status === 200 && couponSettle.body?.creditsAdded === 500
      && couponSettle.body?.bonusCredits === 50,
      `${couponSettle.status} credits=${couponSettle.body?.creditsAdded} bonus=${couponSettle.body?.bonusCredits} total=${couponSettle.body?.totalInr}`);
    check('charged unchanged at ₹590.00 (the bonus is not a discount)',
      couponSettle.body?.totalInr === '590.00', `totalInr=${couponSettle.body?.totalInr}`);
    check('balance is now 1,050 (500 + 500 + 50)', await readBalance(walletId) === 1050,
      `real_time_credit_balance=${await readBalance(walletId)}`);
    const couponIntent = store.getRechargeIntent(couponId);
    check('the bonus is a FREE_CREDIT_GRANT row, not a bonus field on the purchase',
      (await readCreditRows(walletId)).some((r) => r.transaction_reason === 'FREE_CREDIT_GRANT'
        && Number(r.credits_available) === 50
        && String(r.idempotency_key || '').endsWith(':promo')),
      `bonusPaise=${couponIntent.bonusPaise} rows=${(await readCreditRows(walletId)).map((r) => `${r.transaction_reason}:${r.credits_available}`).join(' ')}`);

    // 7. Razorpay: second gateway, same settle(). ₹1,000 → 18% GST → ₹1,180 → 1,000 credits.
    section('7. Razorpay — second gateway, same settle()');
    const rQuote = await call('/recharge', { amountInr: 1000 });
    check('quote ₹1,000 → 18,000p GST → 118,000p total',
      rQuote.body?.quote?.subtotalPaise === 100000 && rQuote.body?.quote?.gstPaise === 18000
      && rQuote.body?.quote?.totalPaise === 118000,
      `${rQuote.body?.quote?.subtotalPaise}/${rQuote.body?.quote?.gstPaise}/${rQuote.body?.quote?.totalPaise}`);
    const rOrder = await call('/razorpay/create-order', { amountInr: 1000 });
    check('razorpay create-order returns the mock checkout',
      rOrder.status === 200 && rOrder.body?.provider === 'razorpay'
      && rOrder.body?.checkout?.mode === 'mock',
      `status=${rOrder.status} ${rOrder.text.slice(0, 160)}`);
    const rOrderId = rOrder.body?.orderId || '';
    const badSig = await call('/razorpay/verify-order', {
      orderId: rOrderId,
      razorpayOrderId: 'order_fake',
      razorpayPaymentId: 'pay_fake',
      razorpayPaymentSignature: 'deadbeef',
    });
    check('a bad Razorpay signature is refused before any credit',
      badSig.status === 400 && badSig.body?.code === 'payment_signature_invalid',
      `status=${badSig.status} code=${badSig.body?.code}`);
    check('the refused signature left the intent QUOTED',
      store.getRechargeIntent(rOrderId).status === 'QUOTED',
      `status=${store.getRechargeIntent(rOrderId).status}`);
    const rSettle = await call('/razorpay/verify-order', { orderId: rOrderId });
    check('razorpay verify-order settles with no signature fields',
      rSettle.status === 200 && rSettle.body?.status === 'settled' && rSettle.body?.provider === 'razorpay',
      `status=${rSettle.status} ${rSettle.text.slice(0, 200)}`);
    check('wallet balance is now 2,050 credits (1,050 + 1,000)',
      await readBalance(walletId) === 2050, `real_time_credit_balance=${await readBalance(walletId)}`);

    // 8. The credit rows themselves: GST never appears as a credit.
    section('8. credit-row proof');
    const allRows = await readCreditRows(walletId);
    const purchaseRows = allRows.filter((r) => r.transaction_reason === 'PURCHASED_CREDIT_DIRECT');
    const granted = purchaseRows.reduce((sum, r) => sum + Number(r.credit_amount || 0), 0);
    check('three purchase rows totalling 2,000 credits — never 2,270 (₹590+₹590+₹1,180)',
      purchaseRows.length === 3 && granted === 2000,
      `rows=${purchaseRows.length} sum=${granted} reasons=${[...new Set(allRows.map((r) => r.transaction_reason))].join(',')}`);
    check('every purchase row carries priority 1 and the direct type',
      purchaseRows.every((r) => Number(r.priority) === 1 && r.transaction_reason === 'PURCHASED_CREDIT_DIRECT' && r.type === 'credit'),
      [...new Set(purchaseRows.map((r) => `${r.type}/${r.transaction_reason}/${r.priority}`))].join(','));
    check('each row’s idempotency key is the recharge order',
      purchaseRows.every((r) => String(r.idempotency_key || '').startsWith('recharge:order_')),
      purchaseRows.map((r) => r.idempotency_key).join(' | '));
    check('GST metadata on the row is the ₹90, recorded but never credited',
      purchaseRows.every((r) => String(r.metadata?.gst_paise || '') === '9000'
        || String(r.metadata?.gst_paise || '') === '18000'),
      purchaseRows.map((r) => r.metadata?.gst_paise).join(','));

    // 9. With the mock flag off, the same create-order must be refused outright.
    section('9. the mock refusal (BILLING_ALLOW_MOCK_PAYMENTS=false)');
    const savedFlag = process.env.BILLING_ALLOW_MOCK_PAYMENTS;
    process.env.BILLING_ALLOW_MOCK_PAYMENTS = 'false';
    const refused = await call('/recharge/create-order', { amountInr: 500 });
    process.env.BILLING_ALLOW_MOCK_PAYMENTS = savedFlag;
    check('create-order with no gateway and no mock flag is refused',
      refused.status === 400 && refused.body?.code === 'provider_not_configured',
      `status=${refused.status} code=${refused.body?.code}`);
    check('the refusal wrote no intent',
      store.listRechargeIntents({ orgId }).length
        === [orderId, couponId, rOrderId].filter((id) => store.getRechargeIntent(id)).length,
      `intents=${store.listRechargeIntents({ orgId }).length}`);
    check('and left the balance at 2,050', await readBalance(walletId) === 2050,
      `real_time_credit_balance=${await readBalance(walletId)}`);

    section('summary');
    for (const r of results) if (!r.ok) console.log(`  FAIL ${r.name} — ${r.detail}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`  ${results.length - failed}/${results.length} checks passed`);
    console.log(`  org ${orgId} · wallet ${walletId || '(none)'}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (!flags.keep) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`\n  kept ${dataDir}`);
  }
}

main().catch((err) => {
  console.error(`\nrecharge verify crashed: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
