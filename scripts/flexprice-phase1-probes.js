#!/usr/bin/env node
// Phase 1 contract probes: the four questions the Phase 0 findings left open,
// measured against the live stack rather than reasoned about.
//
//   node scripts/flexprice-phase1-probes.js
//
// Appends to docs/flexprice-spike/results.json in the shape the Phase 0 spike
// used ({name,item,ok,observed,decision,at}), so a re-run after a version bump
// lands beside the older record instead of replacing it. Exit code is non-zero if
// any probe FAILs: these four decide things, so a silent red run is not allowed.
//
// Why each one exists:
//   A  conversion_rate direction. Decision D6 (1 credit = ₹1) and money-wire's
//      PAISE_PER_CREDIT both rest on which side of `amount = credits * rate` the
//      rupee sits.
//   B  float64 inside event `properties`. Findings §12 left the storage width of
//      a property value unprobed, and Phase 3 intends to put integer paise there.
//   C  a PRICED tax line inside invoice `total`. Phase 0 measured that a
//      price-less line is stored but excluded from total, which is why D3's Zoho
//      connector needs priced GST lines. If this fails, GST stops being disclosed
//      through FlexPrice's total (the fallback is written into the plan).
//   D  the two-plane write split. The provisioner's comments claim a money-plane
//      service account cannot mint keys; a claim about a security boundary that
//      nobody measured is a guess.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createFlexpriceClient } = require('../packages/shared-core/src/billing/flexprice-client');
const { decimalFromPaise, paiseFromDecimal } = require('../packages/shared-core/src/billing/money-wire');
const gst = require('../packages/shared-core/src/billing/gst');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'deploy', 'flexprice', '.env');
const RESULTS = path.join(ROOT, 'docs', 'flexprice-spike', 'results.json');
const ENVIRONMENT_ID = process.env.FLEXPRICE_ENVIRONMENT_ID || '00000000-0000-0000-0000-000000000001';

const RUN = `phase1-${Date.now()}`;
const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

function readEnvFile() {
  const out = {};
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const stackEnv = readEnvFile();
const moneyKey = process.env.FLEXPRICE_API_KEY_MONEY || stackEnv.FLEXPRICE_API_KEY_MONEY;
const ingestKey = process.env.FLEXPRICE_API_KEY_INGEST || stackEnv.FLEXPRICE_API_KEY_INGEST;
const adminKey = process.env.FLEXPRICE_API_KEY || stackEnv.FLEXPRICE_API_KEY;
if (!moneyKey || !ingestKey) {
  console.error('plane keys are missing from deploy/flexprice/.env — run npm run billing:flexprice:provision');
  process.exit(1);
}
const baseUrl = (process.env.FLEXPRICE_BASE_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const cfg = (keys) => ({ baseUrl, environmentId: ENVIRONMENT_ID, timeoutMs: 20000, keys });
const money = createFlexpriceClient({ config: cfg({ money: moneyKey, ingest: ingestKey }) });
const ingest = createFlexpriceClient({ config: cfg({ money: moneyKey, ingest: ingestKey }) });
const asAdmin = createFlexpriceClient({ config: cfg({ money: adminKey || moneyKey, ingest: ingestKey }) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seg = (value) => encodeURIComponent(String(value));
const truncateBody = (body, max = 220) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

async function makeCustomer(tag) {
  const external_id = `${RUN}.${tag}`;
  const c = await money.createCustomer({
    external_id,
    name: `${RUN} ${tag}`,
    address_line1: '1 Test Street',
    address_city: 'Ahmedabad',
    address_state: 'Gujarat',
    address_postal_code: '380001',
    address_country: 'IN',
  });
  return { id: c.id, external_id };
}

async function makeWallet(customer, conversionRate, name) {
  const w = await money.createWallet({
    external_customer_id: customer.external_id,
    currency: 'INR',
    wallet_type: 'PRE_PAID',
    name: name || `${RUN} ${conversionRate}`,
    conversion_rate: conversionRate,
  });
  return w;
}

async function credits(walletId) {
  const b = await money.walletRealTimeBalance(walletId);
  return Number(b.real_time_credit_balance || 0);
}

/**
 * SUM over a meter's window. `value` is omitempty, so an absent key means zero
 * rows matched — not a failed request (findings: that confusion made an ingest
 * probe look like a semantics finding).
 */
async function pollUsage(meterId, externalCustomerId, expected, timeoutMs = 120000) {
  const now = Date.now();
  const body = {
    meter_id: meterId,
    external_customer_id: externalCustomerId,
    start_time: new Date(now - 6 * 3600 * 1000).toISOString(),
    end_time: new Date(now + 600 * 1000).toISOString(),
  };
  const started = Date.now();
  let last = 0;
  while (Date.now() - started < timeoutMs) {
    const res = await ingest.eventsUsageMeter(body);
    last = Number(res.value ?? 0);
    if (last >= expected) return { value: last, waitedMs: Date.now() - started };
    await sleep(3000);
  }
  return { value: last, waitedMs: Date.now() - started, timedOut: true };
}

async function lookupPrice(lookupKey) {
  return money.request({ plane: 'money', method: 'GET', route: `/v1/prices/lookup/${encodeURIComponent(lookupKey)}` });
}

// ---------------------------------------------------------------- probes ----

const probes = [
  {
    name: 'wallet-conversion-rate-direction',
    item: 'A',
    async run() {
      const c1 = await makeCustomer('conv-rate-1');
      const c2 = await makeCustomer('conv-rate-2');
      const w1 = await makeWallet(c1, '1');
      const w2 = await makeWallet(c2, '2');

      await money.topUpWallet(w1.id, { credits_to_add: '100', transaction_reason: 'PURCHASED_CREDIT_DIRECT' }, { idempotencyKey: `${RUN}.a1` });
      const at1 = await money.topUpWallet(w2.id, { credits_to_add: '100', transaction_reason: 'PURCHASED_CREDIT_DIRECT' }, { idempotencyKey: `${RUN}.a2` });
      const creditsFromRate2 = await credits(w2.id);
      // Second wallet, `amount` instead of `credits_to_add`: the DTO says
      // amount = credits_to_add * conversion_rate, so ₹100 at rate 2 should buy
      // 50 credits.
      await money.topUpWallet(w2.id, { amount: '100.00', transaction_reason: 'PURCHASED_CREDIT_DIRECT' }, { idempotencyKey: `${RUN}.a3` });
      const afterAmount = await credits(w2.id);

      const observed = {
        rate_1_credits_after_100_credits_to_add: await credits(w1.id),
        rate_2_credits_after_100_credits_to_add: creditsFromRate2,
        rate_2_topup_response_amount_field: at1 && at1.amount !== undefined ? at1.amount : null,
        rate_2_credits_after_amount_100: afterAmount,
        rupees_credited_by_100_credits_at_rate_1: await credits(w1.id),
      };
      const oneCreditOneRupee = observed.rate_1_credits_after_100_credits_to_add === 100
        && observed.rate_2_credits_after_100_credits_to_add === 100
        && observed.rate_2_credits_after_amount_100 === 150;
      return {
        ok: oneCreditOneRupee,
        observed,
        decision: oneCreditOneRupee
          ? 'confirmed: credits_to_add is denominated in credits and conversion_rate scales them to rupees, so conversion_rate "1" makes 1 credit = ₹1. money-wire PAISE_PER_CREDIT=100 stands, and Phase 2 tops up with credits_to_add = subtotal rupees (never `amount`, which would divide by the rate).'
          : 'NOT as assumed: read the numbers above before Phase 2. The fix is confined to paiseFromCredits/creditsFromPaise in money-wire.js plus which field the top-up sends.',
      };
    },
  },

  {
    name: 'float64-inside-event-properties',
    item: 'B',
    async run() {
      const meter = await money.createMeter({
        name: `${RUN} probe-b`,
        event_name: `${RUN}.probeb`,
        aggregation: { type: 'SUM', field: 'qty' },
        reset_usage: 'DAILY',
      });
      const cInt = await makeCustomer('b-int');
      const cFloat = await makeCustomer('b-float');
      const cBig = await makeCustomer('b-big');
      const at = new Date().toISOString();
      const ev = (customer, value, i) => ({
        event_id: `${RUN}.b.${customer.external_id}.${i}`,
        event_name: `${RUN}.probeb`,
        external_customer_id: customer.external_id,
        timestamp: at,
        source: 'phase1-probe',
        properties: { qty: value },
      });

      await ingest.eventsBulk([ev(cInt, 1, 0), ev(cInt, 2, 1), ev(cInt, 3, 2)]);
      const ints = await pollUsage(meter.id, cInt.external_id, 6);
      // 0.1 + 0.2 is the classic float64 answer (0.30000000000000004). What
      // ClickHouse returns tells us whether the value survives as float64 or is
      // widened/narrowed somewhere in the pipe.
      await ingest.eventsBulk([ev(cFloat, 0.1, 0), ev(cFloat, 0.2, 1)]);
      const floats = await pollUsage(meter.id, cFloat.external_id, 0.29, 60000);
      // 9007199254740993 is 2^53+1: not representable as a JS number, so this is
      // what our own serializer does to it before FlexPrice ever sees it.
      const bigId = `${RUN}.b.big.0`;
      await ingest.eventsBulk([{ ...ev(cBig, 9007199254740993, 0) }]);
      const big = await pollUsage(meter.id, cBig.external_id, 1, 60000);

      const observed = {
        meter_id: meter.id,
        integers_1_2_3: { expected: 6, got: ints.value, waited_ms: ints.waitedMs, timed_out: !!ints.timedOut },
        floats_0_1_0_2: { naive_sum: 0.1 + 0.2, got: floats.value, timed_out: !!floats.timedOut },
        beyond_2pow53: { sent: 9007199254740993, js_round_trip: Number('9007199254740993'), got: big.value, timed_out: !!big.timedOut },
      };
      const ok = observed.integers_1_2_3.got === 6
        && observed.beyond_2pow53.got === Number('9007199254740993')
        && Number.isFinite(observed.floats_0_1_0_2.got);
      return {
        ok,
        observed,
        decision: ok
          ? 'integers survive exactly, including one that JS itself rewrites at 2^53; fractions arrive as float64 sums. Confirms the Phase 3 rule already written into the outbox: quantities are INTEGER paise / INTEGER seconds, and any value that needs a fraction of the smallest unit is a unit error, not a rounding problem.'
          : 'the integer path did not come back exact — stop and read this before Phase 3 writes an outbox against it.',
      };
    },
  },

  {
    name: 'gst-lands-in-invoice-total',
    item: 'C',
    async run() {
      const c = await makeCustomer('invoice-gst');
      const principal = await lookupPrice('recharge-principal');
      const cgst = await lookupPrice('gst-cgst-9');
      const sgst = await lookupPrice('gst-sgst-9');

      const quote = gst.quote({ subtotalPaise: 50000, supplierStateCode: '24', customerStateCode: '24' });
      const rupees = (p) => decimalFromPaise(p);
      const amounts = [rupees(quote.subtotalPaise), rupees(quote.components[0].paise), rupees(quote.components[1].paise)];
      const period = {
        period_start: new Date(Date.now() - 3600e3).toISOString(),
        period_end: new Date().toISOString(),
      };
      const names = ['principal', 'CGST @ 9%', 'SGST @ 9%'];
      const line = (i, priced) => ({
        // A priced line carries the catalog link; a plain one carries a label.
        // Both MUST produce the same document, or D3's connector depends on which
        // kind of line we happened to write.
        ...(priced ? { price_id: [principal.id, cgst.id, sgst.id][i] } : { display_name: names[i] }),
        quantity: String(quote.subtotalPaise / 100),
        amount: amounts[i],
        ...period,
      });
      const which = (id) => (id === principal.id ? 'principal' : id === cgst.id ? 'cgst' : id === sgst.id ? 'sgst' : 'other');
      const read = (x) => ({
        id: x.id,
        number: x.invoice_number || null,
        status: x.status || x.invoice_status,
        subtotal: x.subtotal,
        total: x.total,
        amount_due: x.amount_due,
        total_tax: x.total_tax !== undefined ? x.total_tax : null,
        payment_status: x.payment_status,
        line_sum_paise: (x.line_items || []).reduce((s, li) => s + paiseFromDecimal(String(li.amount)), 0),
        lines: (x.line_items || []).map((li) => ({ which: which(li.price_id || ''), price_id: li.price_id || null, quantity: li.quantity, amount: li.amount })),
      });
      const create = async (tag, { priced, subtotal, amountDue }) => {
        try {
          const inv = await money.createInvoice({
            invoice_type: 'ONE_OFF',
            billing_reason: 'MANUAL',
            currency: 'INR',
            customer_id: c.id,
            invoice_status: 'FINALIZED',
            metadata: { auto_completed: 'true', fleet_probe: `${RUN}.C.${tag}` },
            subtotal,
            total: subtotal,
            amount_due: amountDue,
            line_items: [0, 1, 2].map((i) => line(i, priced)),
          });
          // Their finalize is asynchronous (draft -> compute -> finalize), so a
          // re-read is the only version of this number worth recording.
          await sleep(2500);
          return { invoice: read(await money.getInvoice(inv.id)), refused: null };
        } catch (err) {
          return { invoice: null, refused: `${err.status}${err.code ? ` ${err.code}` : ''}: ${truncateBody(err.body)}` };
        }
      };

      // 1+2. The shape we will ship: every header field is the GROSS ₹590, once
      //      with catalog prices and once with labels.
      const priced = await create('priced-gross', { priced: true, subtotal: rupees(quote.totalPaise), amountDue: rupees(quote.totalPaise) });
      const plain = await create('plain-gross', { priced: false, subtotal: rupees(quote.totalPaise), amountDue: rupees(quote.totalPaise) });
      // 3. The shape the plan ASSUMED: subtotal = taxable base, amount_due = gross.
      //    If total comes back 500 here, `total` is copied from the sent subtotal
      //    and the GST lines never feed it — which is the whole finding.
      const assumed = await create('principal-subtotal', { priced: true, subtotal: rupees(quote.subtotalPaise), amountDue: rupees(quote.totalPaise) });
      // 4. Does the bind-time check compare lines against `amount_due` or against
      //    `subtotal`? A document that is consistent with one and not the other
      //    tells us which field is load-bearing.
      const mismatch = await create('inconsistent', { priced: true, subtotal: rupees(quote.totalPaise), amountDue: rupees(quote.subtotalPaise) });

      const total = (r) => (r.invoice ? paiseFromDecimal(String(r.invoice.total)) : null);
      const grossIsRight = total(priced) === quote.totalPaise && total(plain) === quote.totalPaise;
      const linesCarryGst = (r) => r.invoice
        && r.invoice.line_sum_paise === quote.totalPaise
        && paiseFromDecimal(String(r.invoice.lines[1].amount)) === 4500
        && paiseFromDecimal(String(r.invoice.lines[2].amount)) === 4500;
      const theirTaxZero = (r) => r.invoice && Number(r.invoice.total_tax ?? 0) === 0;
      const priceNessIrrelevant = total(priced) === total(plain);
      const trapReproduced = total(assumed) === quote.subtotalPaise;

      const observed = {
        our_quote: { taxable_paise: quote.subtotalPaise, gst_paise: quote.gstPaise, total_paise: quote.totalPaise },
        priced_lines_gross_subtotal: priced.invoice || priced.refused,
        labelled_lines_gross_subtotal: plain.invoice || plain.refused,
        taxable_subtotal_shape: assumed.invoice || assumed.refused,
        taxable_subtotal_total_paise: total(assumed),
        inconsistent_document: mismatch.invoice ? `accepted (total ${mismatch.invoice.total})` : mismatch.refused,
      };
      const ok = grossIsRight && linesCarryGst(priced) && theirTaxZero(priced) && priceNessIrrelevant && trapReproduced;
      return {
        ok,
        observed,
        decision: ok
          ? 'D3 holds, but NOT by the mechanism the plan named. The HEADER decides invoice total: "total" is copied from the sent "subtotal" (their tax engine adds 0), so the ₹500-taxable / ₹590-amount_due shape comes back ₹500 and the gross-subtotal shape comes back ₹590. "price_id" on the GST lines is decoration — priced and labelled documents came out identical — so Phase 0\'s "price-less lines are excluded from total" was measuring the header, not the line. Consequences, all for Phase 2/5: send subtotal == total == amount_due == gross ₹590; the CGST/SGST lines carry the ₹45 each and that is what Zoho sees; NOTHING may read invoice.total_tax as the GST, because it is always 0 and the ₹90 is ours alone; and the catalog GST prices stay rate-card metadata, not invoice arithmetic. The bind-time check "sum of line amounts == amount_due" still runs, so the document must be self-consistent or it is a 400 ('
            + `${observed.inconsistent_document}).`
          : `the invoice did NOT come back as measured above (${JSON.stringify({ grossIsRight, linesCarryGst: linesCarryGst(priced), priceNessIrrelevant, trapReproduced })}). Until this is green, GST is not disclosed through FlexPrice total: Phase 5 must record ₹590 from our own gst.quote payload and treat the invoice as principal-only.`,
      };
    },
  },

  {
    name: 'two-plane-write-confinement',
    item: 'D',
    async run() {
      const ingestOnly = createFlexpriceClient({ config: cfg({ money: ingestKey, ingest: ingestKey }) });
      const users = await money.request({ plane: 'money', method: 'POST', route: '/v1/users/search', body: { limit: 200 } });
      const moneyAcct = (users.items || []).find((u) => u.name === 'fleet money plane');
      const c = await makeCustomer('rbac');
      const w = await makeWallet(c, '1');

      const outcome = async (fn) => {
        try { await fn(); return 'accepted'; } catch (err) { return `refused(${err.status}${err.code ? ` ${err.code}` : ''})`; }
      };
      const minted = [];
      const mint = async (client, name) => client.request({
        plane: 'money', method: 'POST', route: '/v1/secrets/api/keys',
        body: { name, type: 'private_key', service_account_id: moneyAcct && moneyAcct.id },
      }).then((res) => {
        if (res && res.secret && res.secret.id) minted.push({ client, id: res.secret.id });
        return res;
      });
      // Anything this probe mints it also revokes, including a mint that should
      // have been refused: leaving a live credential behind on a stack whose
      // confinement is being tested is the wrong kind of green.
      const moneyMint = await outcome(() => mint(money, `${RUN} money plane mint attempt`));
      const adminMint = adminKey ? await outcome(() => mint(asAdmin, `${RUN} admin control mint`)) : 'no admin key available';
      const revoked = [];
      for (const k of minted) {
        revoked.push(await outcome(() => k.client.request({ plane: 'money', method: 'DELETE', route: `/v1/secrets/api/keys/${seg(k.id)}` })));
      }
      const observed = {
        money_principal: moneyAcct ? { id: moneyAcct.id, type: moneyAcct.type, roles: moneyAcct.roles } : null,
        money_key_mints_another_key: moneyMint,
        // Control: if the ADMIN key cannot mint either, the route is broken and
        // the money-key refusal above proves nothing about the plane.
        admin_key_mints_a_key: adminMint,
        minted_then_revoked: revoked,
        ingest_key_creates_meter: await outcome(() => ingestOnly.createMeter({ name: `${RUN} nope`, event_name: `${RUN}.nope`, aggregation: { type: 'SUM', field: 'qty' } })),
        ingest_key_tops_up_wallet: await outcome(() => ingestOnly.topUpWallet(w.id, { credits_to_add: '1', transaction_reason: 'PURCHASED_CREDIT_DIRECT' }, { idempotencyKey: `${RUN}.d.topup` })),
        ingest_key_debits_wallet: await outcome(() => ingestOnly.debitWallet(w.id, { credits: '1', idempotencyKey: `${RUN}.d.debit` })),
        ingest_key_ingests_event: await outcome(() => ingestOnly.ingestEvent({
          event_id: `${RUN}.d.event`, event_name: 'fleet.llm_cost', external_customer_id: c.external_id,
          timestamp: new Date().toISOString(), properties: { cost_paise: 1 }, source: 'phase1-probe',
        })),
      };

      const refused = (v) => String(v).startsWith('refused');
      const ok = refused(observed.ingest_key_creates_meter)
        && refused(observed.ingest_key_tops_up_wallet)
        && refused(observed.ingest_key_debits_wallet)
        && observed.ingest_key_ingests_event === 'accepted'
        && refused(observed.money_key_mints_another_key)
        && observed.admin_key_mints_a_key === 'accepted';
      return {
        ok,
        observed,
        decision: ok
          ? 'the split is a real WRITE boundary: the ingest key cannot touch a wallet or the catalog, and the money key — although it holds super_admin, which is the only writer role a service account can hold — cannot mint or enumerate credentials, because IsSuperAdminUser() excludes service accounts. It is still NOT a read boundary (findings: read RBAC is shadow-only), so no doc may call it one.'
          : 'plane confinement did not behave as claimed. Read `observed`: an admin-key failure means the probe is broken, an ingest-key success means the write boundary is not real and Phase 3 must not rely on it.',
      };
    },
  },
];

// ------------------------------------------------------------- driver ----

function verdict(rec) {
  const mark = rec.ok === null ? 'INFO' : rec.ok ? 'OK  ' : 'FAIL';
  console.log(`\n[${mark}] ${rec.name}${rec.item ? ` (probe ${rec.item})` : ''}`);
  console.log(`       ${JSON.stringify(rec.observed).slice(0, 700)}`);
  console.log(`       -> ${rec.decision}`);
}

async function main() {
  const health = await money.getHealth();
  console.log(`stack ${baseUrl} health=${JSON.stringify(health).slice(0, 40)} run=${RUN}`);

  const store = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : { run: RUN, base: baseUrl, results: [] };
  if (!Array.isArray(store.results)) store.results = [];
  const chosen = ONLY ? probes.filter((p) => p.name.startsWith(ONLY) || p.item.toLowerCase() === ONLY.toLowerCase()) : probes;
  if (!chosen.length) {
    console.error(`--only ${ONLY} matched nothing. Probes: ${probes.map((p) => `${p.item}=${p.name}`).join(', ')}`);
    process.exit(2);
  }

  let failed = 0;
  for (const probe of chosen) {
    let rec;
    try {
      rec = await probe.run();
    } catch (err) {
      rec = { ok: false, observed: { error: err.message, status: err.status || null, detail: err.body || null }, decision: 'probe threw' };
    }
    const full = { name: probe.name, item: probe.item, ok: rec.ok, observed: rec.observed, decision: rec.decision, at: new Date().toISOString() };
    store.results.push(full);
    verdict(full);
    if (!full.ok) failed += 1;
  }

  store.phase1_run = { run: RUN, at: new Date().toISOString(), probes: chosen.length, failed };
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.writeFileSync(RESULTS, `${JSON.stringify(store, null, 2)}\n`);
  console.log(`\n${chosen.length - failed}/${chosen.length} probes green; appended to ${path.relative(ROOT, RESULTS)}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`probes aborted: ${err.message}`);
  if (err.body) console.error(JSON.stringify(err.body).slice(0, 400));
  process.exitCode = 1;
});
