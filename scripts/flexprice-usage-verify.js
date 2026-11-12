#!/usr/bin/env node
'use strict';

// Phase 3 verification: usage → outbox → FlexPrice ingest → gate, against the LIVE
// stack.
//
// The unit suites stub the transport, so between them they can prove that a row is
// written, that a batch is sent, and that a mismatch is reported. What none of them
// can prove is the claim the whole phase rests on: that the number FlexPrice sums
// for a meter equals the number we computed for the run, at zero tolerance — because
// a 202 proves nothing (findings §3), an event naming no meter contributes nothing
// silently, and `value` is omitted when it is 0 (findings §12). This script reads the
// answers back out of the engine.
//
// It deliberately does NOT assert that the wallet balance falls. findings §2 measured
// that consumption does not debit at ingest: events accumulate into meter usage and
// the balance moves when an invoice finalizes. So the money-correct assertion is on
// the METER sum, and the credit balance is asserted NOT to have moved — if it ever
// does, the gate would be double-counting the same usage. The other half of that
// expectation, that the real-time projection's `current_period_usage` would show the
// accrued amount, measured FALSE (§14): it answers "0" on every wallet in this
// stack, even one a manual debit drove to −2900, because it is anchored to the
// invoice cycle. Step 6 asserts that it is still zero and that the gate therefore
// carries no usage number at all.
//
// Nothing here reaches Cashfree or Razorpay, and no container is restarted: the ingest
// outage is a closed port, which produces the same connection-refused the api
// container produces when it is down. `--keep` leaves the temp store so the rows can
// be re-read.
//
// Usage:
//   npm run billing:usage:verify
//   npm run billing:usage:verify -- --keep
//   npm run billing:usage:verify -- --base-url=http://127.0.0.1:18080

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'deploy', 'flexprice', '.env');
const SEED_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';
const SUPPLIER_STATE = '24';

// The fixture, in the two units the money path actually speaks. FX is pinned to 100
// for the run so every expected figure below is a multiplication a human can check:
// 0.10 USD → 1000p, and 1000p of ₹1-per-credit usage is ₹10.
const FX = 100;
const RUNS = [
  { label: 'planner triage', provider: 'claude', costUsd: 0.10, inputTokens: 100000, outputTokens: 20000, expectPaise: 1000 },
  { label: 'coder build', provider: 'claude', costUsd: 0.25, inputTokens: 250000, outputTokens: 50000, expectPaise: 2500 },
  { label: 'tiny run', provider: 'claude', costUsd: 0.005, inputTokens: 5000, outputTokens: 500, expectPaise: 50 },
  // A BYOK run: recorded, worth money to the org, and charged nothing (usage.js sets
  // costPaise 0 and the outbox queues no zero).
  { label: 'on the org’s own key', provider: 'claude', costUsd: 0.40, inputTokens: 400000, outputTokens: 80000, expectPaise: 0, providerSource: 'customer' },
];
const EXPECTED_PAISE = RUNS.reduce((sum, r) => sum + r.expectPaise, 0); // 3550p = ₹35.50

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
  gateOff: argv.includes('--gate-off-boot'),
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
function section(title) { console.log(`\n${title}`); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One JSON request to the in-process app, with the context headers the gateway stamps. */
function request(port, method, urlPath, { body, orgId, admin = true } = {}) {
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

// Every FlexPrice read that can lag the write is polled rather than slept on once:
// ingest goes through Kafka and the clickhouse writer, so "eventually" is the contract.
async function until(read, want, { tries = 40, gapMs = 750 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (String(last) === String(want)) return { value: last, attempts: i + 1 };
    await sleep(gapMs);
  }
  return { value: last, attempts: tries, timedOut: true };
}

/**
 * The one check that needs a second process: with every FLEXPRICE_* unset, does the
 * fleet boot and SAY that nothing is enforced? `CONFIG` is a require-time snapshot, so
 * in-process is not a clean environment — hence a child with a scrubbed env.
 */
function bootWithNoFlexprice() {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith('FLEXPRICE_')) delete env[name];
    }
    // The point is the DEFAULT following the money source, so an operator's explicit
    // choice in the shell would be answering a different question.
    delete env.BILLING_GATE_POLICY;
    env.LOG_FORMAT = 'json';
    const child = spawn(process.execPath, [__filename, '--gate-off-boot'], {
      env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 30000);
  });
}

// The child half of the above: require the gate with no FlexPrice and print what boot
// would log. Nothing else runs, so no port is opened and no service is disturbed.
async function gateOffBootProbe() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gate-off-'));
  process.env.NODE_ENV = 'test';
  process.env.STORE_BACKEND = 'file';
  process.env.AI_FLEET_DATA_DIR = dataDir;
  try {
    const gate = require(path.join(ROOT, 'packages/shared-core/src/billing/gate'));
    const policy = gate.reportBoot();
    const fund = await gate.ensureFundStatus('org-gate-off-probe');
    console.log(`PROBE policy=${policy} balancePaise=${String(fund.balancePaise)} `
      + `fundsAvailable=${fund.fundsAvailable} state=${fund.state} gatePolicy=${fund.gatePolicy}`);
    return 0;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  if (flags.gateOff) {
    process.exitCode = await gateOffBootProbe();
    return;
  }
  if (!ingestKey || !moneyKey) {
    console.error(`no plane keys in ${ENV_FILE} — run npm run billing:flexprice:provision first`);
    process.exitCode = 1;
    return;
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-usage-verify-'));
  process.env.NODE_ENV = 'test';
  process.env.STORE_BACKEND = 'file';
  process.env.AI_FLEET_DATA_DIR = dataDir;
  process.env.FLEXPRICE_ENABLED = 'true';
  process.env.FLEXPRICE_BASE_URL = baseUrl;
  process.env.FLEXPRICE_ENVIRONMENT_ID = process.env.FLEXPRICE_ENVIRONMENT_ID || stack.FLEXPRICE_ENVIRONMENT_ID || SEED_ENVIRONMENT_ID;
  process.env.FLEXPRICE_API_KEY_INGEST = ingestKey;
  process.env.FLEXPRICE_API_KEY_MONEY = moneyKey;
  process.env.FLEXPRICE_SUPPLIER_STATE_CODE = SUPPLIER_STATE;
  process.env.USD_TO_INR = String(FX);
  process.env.BILLING_ALLOW_MOCK_PAYMENTS = 'true';
  process.env.LOG_FORMAT = 'json';
  for (const name of ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY', 'CASHFREE_ENV',
    'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_BASE_URL']) delete process.env[name];

  const { createApp } = require(path.join(ROOT, 'services/billing/src/app.js'));
  const store = require('@ai-fleet/shared-core/store');
  const flexpriceConfig = require('@ai-fleet/shared-core/billing/flexprice-config');
  const { createFlexpriceClient } = require('@ai-fleet/shared-core/billing/flexprice-client');
  const outbox = require('@ai-fleet/shared-core/billing/billing-outbox');
  const drain = require('@ai-fleet/shared-core/billing/outbox-drain');
  const gate = require('@ai-fleet/shared-core/billing/gate');
  const { recordUsage } = require('@ai-fleet/shared-core/billing/usage');
  const { FLEXPRICE } = flexpriceConfig;
  const client = createFlexpriceClient({ config: FLEXPRICE });

  const stamp = Date.now().toString(36);
  const orgId = `org-usage-verify-${stamp}`;
  const typoOrg = `org-usage-typo-${stamp}`;

  console.log('AI Fleet — Phase 3 usage→outbox→gate, verified against the live FlexPrice stack');
  console.log(`  flexprice ${flexpriceConfig.describe(FLEXPRICE)}`);
  console.log(`  org        ${orgId}`);
  console.log(`  fixture    ${RUNS.length} runs, ${EXPECTED_PAISE}p hand-computed at ₹${FX}/USD`);
  console.log(`  store dir  ${dataDir}`);

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (urlPath, body) => request(port, 'POST', urlPath, { body, orgId });
  const rowById = (id) => store.listBillingOutboxRows({}).find((row) => row.id === id) || { status: '(gone)' };

  try {
    section('boot');
    const boot = flexpriceConfig.validateForBoot(FLEXPRICE, flexpriceConfig.configMapKeyValues(ENV_FILE));
    check('validateForBoot accepts this config', boot.mode === 'enforced', `mode=${boot.mode}`);
    check('the gate boots enforced when FlexPrice is configured', gate.reportBoot() === 'enforced');
    const health = await client.getHealth().catch((err) => ({ error: err.message }));
    check('FlexPrice API answers /health', Boolean(health) && !health.error, JSON.stringify(health).slice(0, 120));
    const meterIds = await drain.resolveMeterIds(client);
    check('all three provisioned meters exist', ['llm-cost', 'actor-compute', 'deployment-minutes']
      .every((name) => meterIds.has(name)), [...meterIds.keys()].join(','));

    // 1. Fund the org through the real spine, so there is a customer, a wallet and a
    //    known credit total. 500 credits is the denominator for everything below.
    section('1. fund ₹500 (500 credits) through settle()');
    const order = await call('/recharge/create-order', { amountInr: 500, couponBps: 0 });
    check('create-order wrote an intent', order.status === 200 && Boolean(order.body?.orderId),
      `status=${order.status} ${order.text.slice(0, 160)}`);
    const settleRes = await call('/cashfree/verify-order', { orderId: order.body?.orderId });
    const intent = store.getRechargeIntent(order.body?.orderId) || {};
    const walletId = intent.flexprice_settlement?.walletId || '';
    check('settled into a wallet', settleRes.status === 200 && Boolean(walletId),
      `status=${settleRes.status} wallet=${walletId || '(none)'}`);
    const fundedCredits = await until(async () => Number((await client.walletRealTimeBalance(walletId)).real_time_credit_balance), 500);
    check('wallet holds exactly 500 credits', fundedCredits.value === 500,
      `real_time_credit_balance=${fundedCredits.value} after ${fundedCredits.attempts} reads`);

    // 2. The fixed event set, recorded through the one function a run calls.
    section('2. recordUsage → outbox rows (nothing on the network yet)');
    const occurredAt = new Date().toISOString();
    const records = RUNS.map((run) => recordUsage({
      orgId,
      projectId: `proj-${stamp}`,
      userId: `verify-user-${stamp}`,
      taskId: `task-${stamp}`,
      source: 'coder',
      runId: `run-${run.label.replace(/[^a-z0-9]/gi, '-')}-${stamp}`,
      providerSource: run.providerSource || 'managed',
    }, {
      usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens, totalTokens: run.inputTokens + run.outputTokens },
      costUsd: run.costUsd,
    }, { provider: run.provider, model: 'verify-fixture' }));
    check('every run produced a usage record', records.every((r) => r && r.id),
      `${records.filter(Boolean).length}/${RUNS.length}`);
    const pairs = RUNS.map((run, i) => ({ run, record: records[i] }));
    check('each run’s paise equals the hand figure',
      pairs.every(({ run, record }) => record && record.costPaise === run.expectPaise),
      pairs.map(({ run, record }) => `${run.costUsd}USD→${record && record.costPaise}p(want ${run.expectPaise})`).join(' '));
    check('the BYOK run charged nothing and kept its notional value',
      records[3].costPaise === 0 && records[3].notionalCostPaise === 4000,
      `costPaise=${records[3].costPaise} notional=${records[3].notionalCostPaise}`);
    const rows = store.listBillingOutboxRows({ orgId });
    check('three outbox rows, the BYOK run queued nothing', rows.length === 3,
      `rows=${rows.length} statuses=${[...new Set(rows.map((r) => r.status))].join(',')}`);
    check('every row is pending and keyed ev:{org}:{run}:{meter}',
      rows.every((r) => r.status === 'pending' && r.idempotencyKey === `ev:${orgId}:${r.runId}:llm-cost`),
      rows.map((r) => r.idempotencyKey).join(' | '));
    const queuedPaise = rows.reduce((sum, r) => sum + r.quantityPaise, 0);
    check('the queued quantity is the hand total, no more and no less', queuedPaise === EXPECTED_PAISE,
      `${queuedPaise}p vs ${EXPECTED_PAISE}p`);
    check('no event reached FlexPrice while the outbox filled',
      Number((await meterRead(client, meterIds, orgId, occurredAt)).value) === 0,
      'the meter is still empty — recording a run never calls the network');

    // 3. The outage first, because that is the case the outbox exists for.
    section('3. ingest outage (a closed port, the same failure a stopped api container gives)');
    const dead = createFlexpriceClient({
      config: { ...FLEXPRICE, baseUrl: 'http://127.0.0.1:1' },
      fetchImpl: (url, init) => { throw new Error(`connect ECONNREFUSED ${url}`); },
    });
    const outcome = await drain.drainOnce({ client: dead, meterIds, now: new Date().toISOString() });
    check('the drain failed without throwing', outcome.stopped && !outcome.skipped, String(outcome.stopped).slice(0, 80));
    check('every row stayed pending, so nothing is believed delivered',
      outbox.counts().pending === 3 && outbox.counts().sent === 0,
      JSON.stringify(outbox.counts()));
    check('a failed attempt did not consume the retry ceiling',
      store.listBillingOutboxRows({ orgId }).every((r) => r.attempts === 1),
      `attempts=${store.listBillingOutboxRows({ orgId }).map((r) => r.attempts).join(',')}`);
    check('the runs themselves are untouched', store.listUsageRecords({ orgId }).length === 4,
      `records=${store.listUsageRecords({ orgId }).length}`);

    // 4. Now the real drain: deliver, then prove it by reading the meter back.
    section('4. drain to the live stack, with the meter read-back');
    const drained = await drain.drainOnce({ client, meterIds, now: new Date().toISOString() });
    check('all three rows delivered', drained.delivered === 3 && !drained.stopped,
      `delivered=${drained.delivered} batches=${drained.batches} stopped=${drained.stopped}`);
    check('delivery moved them to sent, which is all a 202 earns',
      outbox.counts().pending === 0 && (outbox.counts().sent + outbox.counts().verified) === 3,
      JSON.stringify(outbox.counts()));
    // The read-back is a query against ClickHouse, and ingest reaches it through
    // Kafka, so the proof normally lands on a LATER pass than the send. Counting the
    // passes is the operator-relevant number: it is how long a tenant's usage is
    // unaccounted for after FlexPrice has already said 202.
    let lastPass = drained;
    let passes = 1;
    while (passes < 12 && (outbox.counts().verified || 0) < 3) {
      await sleep(1500);
      passes += 1;
      lastPass = await drain.drainOnce({ client, meterIds, now: new Date().toISOString() });
    }
    check(`the read-back verified all three (after ${passes} pass${passes === 1 ? '' : 'es'})`,
      outbox.counts().verified === 3, `verified=${outbox.counts().verified} drift=${JSON.stringify(lastPass.drift)}`);
    check('nothing is left believed-but-unproved',
      outbox.counts().sent === 0 && outbox.counts().failed === 0, JSON.stringify(outbox.counts()));
    const meter = await until(async () => (await meterRead(client, meterIds, orgId, occurredAt)).value, EXPECTED_PAISE);
    check(`the meter holds exactly ${EXPECTED_PAISE}p`, Number(meter.value) === EXPECTED_PAISE,
      `value=${meter.value} after ${meter.attempts} reads`);

    // 5. A blind retry of the same batch is the operation that would double-bill if
    //    FlexPrice did not dedup first-wins on event_id (findings §3).
    section('5. a blind retry is safe');
    await client.eventsBulk(rows.map((row) => outbox.toEvent(row)));
    await client.eventsBulk(rows.map((row) => outbox.toEvent(row)));
    const afterRetry = await until(async () => (await meterRead(client, meterIds, orgId, occurredAt)).value, EXPECTED_PAISE, { tries: 8 });
    check('two re-sends of the same event ids did not move the total',
      Number(afterRetry.value) === EXPECTED_PAISE, `value=${afterRetry.value}`);

    // 6. What the gate sees. findings §2: usage does not debit at ingest, so the
    //    credit balance is expected NOT to have moved. The other half of that
    //    expectation — that the projection's `current_period_usage` would carry the
    //    accrued ₹35.50 — measured FALSE: it reads 0.00 for every wallet in this
    //    stack, including one that really has been debited, because it is anchored
    //    to the invoice cycle that Phase 5 creates. So the meter sum asserted above
    //    is the only usage authority, and the gate exposes no usage number at all.
    //    Both halves are checked here so the finding is embodied, not remembered.
    section('6. the gate reads the wallet, not the store');
    const projection = await client.walletRealTimeBalance(walletId);
    check('the wallet projection still reports no period usage',
      Number(projection.current_period_usage || 0) === 0,
      `current_period_usage=${projection.current_period_usage} with ${EXPECTED_PAISE}p metered`);
    const afterUsage = Number((await client.walletRealTimeBalance(walletId)).real_time_credit_balance);
    check('the credit balance has NOT moved (billing, not finalization)', afterUsage === 500,
      `real_time_credit_balance=${afterUsage}`);
    const fund = await gate.ensureFundStatus(orgId);
    check('the gate reports the wallet in paise', fund.balancePaise === 50000 && fund.state === 'available',
      `balancePaise=${fund.balancePaise} state=${fund.state} wallet=${fund.walletId}`);
    check('and reports money only — no usage figure a caller could read as accrued spend',
      !('currentPeriodUsagePaise' in fund), `view keys=${Object.keys(fund).join(',')}`);
    const sync = gate.getOrgFundStatus(orgId);
    check('the synchronous accessor serves the cached view', Boolean(sync) && sync.balancePaise === 50000,
      sync ? `balancePaise=${sync.balancePaise} gatePolicy=${sync.gatePolicy}` : 'null — nothing was ever read');
    check('nothing in the store holds a balance any more',
      !Object.keys(store.getBillingAccount(orgId) || {}).includes('balancePaise'),
      `account keys=${Object.keys(store.getBillingAccount(orgId) || {}).join(',')}`);
    check('an unknown org is unknown, not zero',
      (await gate.ensureFundStatus(`org-never-provisioned-${stamp}`)).balancePaise === null);

    // 7. The silent-freeze case: an event_name that no meter aggregates. Delivered
    //    under a second org so its window stays alone, exactly as a bad build would
    //    do it — the row exists, the payload is wrong, the 202 says nothing.
    section('7. a typo’d event_name complains instead of freezing');
    const typoRow = outbox.enqueue({
      kind: 'llmCost', orgId: typoOrg, runId: `run-typo-${stamp}`, quantity: 700, occurredAt: new Date().toISOString(),
    });
    check('a row for the typo org queued', Boolean(typoRow) && typoRow.quantityPaise === 700, typoRow && typoRow.idempotencyKey);
    const broken = { ...outbox.toEvent(typoRow), event_name: 'fleet.llm_cost_typo' };
    await client.eventsBulk([broken]);
    outbox.markSent(typoRow);
    const proof = await drain.verify({ client, meterIds, nowIso: new Date().toISOString() });
    check('the read-back reports the group as drift', proof.drift.length === 1
      && proof.drift[0].orgId === typoOrg && proof.drift[0].expected === 700 && proof.drift[0].observed === 0,
      JSON.stringify(proof.drift));
    check('the row stays sent — delivered, but never believed',
      rowById(typoRow.id).status === 'sent', `status=${rowById(typoRow.id).status}`);
    // Pretending the clock moved 31 minutes, because the alternative is an operator
    // waiting half an hour to learn that an alarm fires. The threshold is the drain's
    // own STALE_SENT_MS: six ticks, long enough that ingest lag has resolved itself.
    const stale = drain.staleSent(Date.now() + 31 * 60 * 1000, 30 * 60 * 1000);
    check('and is old enough to be the standing alarm', stale.length === 1, `stale rows=${stale.length}`);
    // Re-sending it correctly is the repair, and the loop has to close on its own.
    await client.eventsBulk([outbox.toEvent(rowById(typoRow.id))]);
    const repaired = await until(async () => (await meterRead(client, meterIds, typoOrg, typoRow.occurredAt)).value, 700);
    check('the correct event_name is aggregated', Number(repaired.value) === 700, `value=${repaired.value}`);
    const afterRepair = await drain.drainOnce({ client, meterIds, now: new Date().toISOString() });
    check('the next pass verifies it and the drift clears',
      rowById(typoRow.id).status === 'verified' && !afterRepair.drift.length,
      `status=${rowById(typoRow.id).status} drift=${JSON.stringify(afterRepair.drift)}`);

    section('8. a fleet with no FlexPrice at all');
    const off = await bootWithNoFlexprice();
    const offLine = off.out.split('\n').find((line) => line.includes('PROBE policy=')) || '';
    check('boot with every FLEXPRICE_* unset reports the gate as off',
      off.code === 0 && /policy=off/.test(offLine), offLine.trim() || `exit ${off.code}`);
    check('and says where the decision came from', /"policy":"off"/.test(off.out)
      && /flexprice_disabled|BILLING_GATE_POLICY=off/.test(off.out),
      (off.out.match(/billing_gate_policy.*/) || [''])[0].slice(0, 160));
    check('the unconfigured gate admits rather than blocking',
      /balancePaise=null fundsAvailable=true/.test(offLine), offLine.trim());

    section('summary');
    for (const r of results) if (!r.ok) console.log(`  FAIL ${r.name} — ${r.detail}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`  ${results.length - failed}/${results.length} checks passed`);
    console.log(`  org ${orgId} · wallet ${walletId || '(none)'} · meter ${meterIds.get('llm-cost') || '(none)'}`);
    console.log(`  re-read: node scripts/flexprice-inspect.js balance ${walletId || '<wallet>'}`);
    console.log(`           node scripts/flexprice-inspect.js usage --meter ${meterIds.get('llm-cost') || '<meter>'} --customer ${orgId} --hours 1`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (!flags.keep) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`\n  kept ${dataDir}`);
  }
}

/** The meter sum FlexPrice computed for one org, or 0 when the route omits `value`. */
async function meterRead(client, meterIds, orgId, fromIso) {
  const end = new Date(Date.now() + 60_000).toISOString();
  const out = await client.eventsUsageMeter({
    meter_id: meterIds.get('llm-cost'),
    external_customer_id: orgId,
    start_time: fromIso,
    end_time: end,
  });
  const value = Number(out && out.value !== undefined ? out.value : 0);
  const rows = out && out.items ? out.items : undefined;
  return { value, raw: rows === undefined ? out : rows };
}

main().catch((err) => {
  console.error(`\nusage verify crashed: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
