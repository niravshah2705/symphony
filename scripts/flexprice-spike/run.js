#!/usr/bin/env node
// Phase 0 FlexPrice spike — one probe per open question in docs/FLEXPRICE_FINDINGS.md §9.
//
// Deviation from the plan, stated plainly: the plan said each probe would append
// its verdict to FLEXPRICE_FINDINGS.md. It does not. A script rewriting a document
// whose claims are individually evidence-graded (✅ measured / 🔴 measured and
// falsifying / ◻ deliberately not probed) is how an unverified verdict ends up
// looking verified, and how a rerun duplicates a section. Probes print and write
// docs/flexprice-spike/results.json; a human folds the outcome into the findings,
// and the findings say which probe produced it.
//
// Every probe is read-mostly and idempotent per run: it creates its own customer
// under a unique external_id, so reruns do not collide with the partial-unique
// index on (tenant_id, environment_id, external_id) WHERE status='published'.
// Anything that mutates money state does so on a wallet it created itself.
//
// Throwaway by design. Do not import this from services.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Two levels up: this file lives in scripts/flexprice-spike/, not scripts/.
const ROOT = path.resolve(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, 'deploy', 'flexprice', '.env');
const OUT_DIR = path.join(ROOT, 'docs', 'flexprice-spike');
const OUT_FILE = path.join(OUT_DIR, 'results.json');
const BASE = process.env.FLEXPRICE_SPIKE_URL || 'http://127.0.0.1:18080';

const env = loadEnv();
const API_KEY = env.FLEXPRICE_API_KEY;
// X-Environment-ID is not optional on a FlexPrice data route: a valid key without
// it gets 403 {"error":"Access denied","message":"Invalid or inaccessible
// environment"} — observed on the live stack, and asserted by the bootstrap
// verify step. Defaulting to the seeded Production environment (V1__seed.sql,
// …001; Sandbox is …000) rather than to "no header" is what makes every probe
// below actually run. Override with FLEXPRICE_ENVIRONMENT_ID to spike Sandbox.
const ENVIRONMENT_ID = process.env.FLEXPRICE_ENVIRONMENT_ID || '00000000-0000-0000-0000-000000000001';
if (!API_KEY) {
  console.error('no FLEXPRICE_API_KEY in deploy/flexprice/.env — run npm run billing:flexprice:bootstrap');
  process.exit(2);
}

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1].split(',').map((s) => s.trim())
  : null;

const RUN = `spike-${Date.now()}`;
const results = [];

// ------------------------------------------------------------------ plumbing

function loadEnv() {
  const out = {};
  // A missing .env must reach the "run the bootstrap" message below, not an
  // fs.ENOENT stack trace that names the wrong directory.
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function req(method, p, body, keyOverride = null) {
  const headers = { 'x-api-key': keyOverride === null ? API_KEY : keyOverride, 'Content-Type': 'application/json' };
  if (ENVIRONMENT_ID) headers['X-Environment-ID'] = ENVIRONMENT_ID;
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    return { status: res.status, text, ms: Math.round(performance.now() - t0), json: safeJson(text) };
  } catch (e) {
    return { status: 0, text: String(e.message), ms: Math.round(performance.now() - t0), json: null };
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function verdict(name, item, ok, observed, decision) {
  const rec = { name, item, ok, observed, decision, at: new Date().toISOString() };
  results.push(rec);
  const mark = ok === null ? 'INFO' : ok ? 'OK  ' : 'FAIL';
  console.log(`\n[${mark}] ${name}${item ? ` (item ${item})` : ''}`);
  console.log(`       ${truncate(observed)}`);
  if (decision) console.log(`       -> ${decision}`);
  return rec;
}

function truncate(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 900 ? `${s.slice(0, 900)}…(+${s.length - 900})` : s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Local-container diagnostics for pipeline-health ONLY. These are never part of a
// money verdict — they exist to answer "which half of the pipe is empty", which is
// not observable through the REST API (a 202 and a 0-row table look identical).
// Interpolated names are always `${RUN}.<tag>` (spike-<digits>.<tag>), never input.
function chQuery(sql) {
  const r = spawnSync('docker', ['exec', 'fleet-flexprice-clickhouse-1',
    'clickhouse-client', '--query', sql], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout.trim() : `docker exec failed: ${String(r.stderr || r.error || '').trim().slice(0, 160)}`;
}

function kafkaTopics() {
  const r = spawnSync('docker', ['exec', 'fleet-flexprice-kafka-1',
    'kafka-topics', '--bootstrap-server', 'kafka:9092', '--list'], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) return `kafka-topics failed: ${String(r.stderr || '').trim().slice(0, 160)}`;
  // localhost:9092 does not resolve inside this container — it is the listener
  // name, not the address; `kafka:9092` is the one that works.
  return r.stdout.trim().split('\n').filter(Boolean).sort();
}

// ------------------------------------------------------------------ fixtures

async function makeCustomer(tag) {
  const external_id = `${RUN}-${tag}`;
  // Address fields are FLAT on CreateCustomerRequest (internal/api/dto/customer.go:45-60),
  // NOT a nested `billing_address` object. Sending the nested shape is not an error —
  // the binder accepts the request 201 and silently leaves every address field empty,
  // which was how this fixture ran for two days. That matters beyond tidiness:
  // place of supply is derived from the customer address, and the FlexPrice customer
  // has NO tax_id/GSTIN field at all (grep: zero hits in dto/customer.go and
  // internal/domain/customer), so an empty address means "intra/inter-state unknown"
  // on every invoice we might later want to compare our GST against.
  const res = await req('POST', '/v1/customers', {
    external_id,
    name: `Spike ${tag}`,
    address_line1: '1 Test Street',
    address_city: 'Ahmedabad',
    address_state: 'Gujarat',
    address_postal_code: '380001',
    address_country: 'IN',
  });
  if (res.status >= 400) throw new Error(`customer(${tag}) ${res.status}: ${truncate(res.text)}`);
  // Fail loudly rather than let a dropped address become a silent tax finding.
  if (res.json?.address_country !== 'IN' || res.json?.address_state !== 'Gujarat') {
    throw new Error(`customer(${tag}) address did not round-trip: ${truncate(res.json)}`);
  }
  return { id: res.json?.id, external_id, raw: res.json };
}

// `aggregation.field` names a key in event.properties and is required for the
// value-bearing aggregation types: POST /v1/meters with only `{type:'SUM'}` is
// refused 400 {"code":"validation_error","message":"Please specify a field or
// expression for this aggregation type","details":{"aggregation_type":"SUM"}}
// (internal/domain/meter/model.go:197 — Field OR Expression must be set).
async function makeMeter(eventName, aggregationType = 'SUM', field = 'qty', bucketSize = null) {
  const res = await req('POST', '/v1/meters', {
    name: `${RUN} ${eventName} ${aggregationType}`,
    event_name: eventName,
    aggregation: { type: aggregationType, field, ...(bucketSize ? { bucket_size: bucketSize } : {}) },
    reset_usage: 'DAILY',
  });
  if (res.status >= 400) throw new Error(`meter ${res.status}: ${truncate(res.text)}`);
  return res.json.id;
}

async function makeWallet(customer, opts = {}) {
  const res = await req('POST', '/v1/wallets', {
    external_customer_id: customer.external_id,
    currency: 'INR',
    wallet_type: 'PRE_PAID',
    name: `${RUN} wallet`,
    conversion_rate: '1',
    ...opts,
  });
  if (res.status >= 400) throw new Error(`wallet ${res.status}: ${truncate(res.text)}`);
  return res.json;
}

async function topUp(walletId, body) {
  return req('POST', `/v1/wallets/${walletId}/top-up`, {
    transaction_reason: 'PURCHASED_CREDIT_DIRECT',
    ...body,
  });
}

// `cached`, not `real-time-cached`, is a 404: the routes are
// GET /v1/wallets/:id/balance/real-time and .../balance/real-time-cached
// (internal/api/router.go:498-499). A latency probe that samples a 404 measures
// the router, not the balance read — that is how the first run of
// `balance-realtime-latency` got p95=5ms for six calls that never happened.
async function balance(walletId, realtime = true, expand = null) {
  const q = expand ? `?expand=${encodeURIComponent(expand)}` : '';
  return req('GET', `/v1/wallets/${walletId}/balance/${realtime ? 'real-time' : 'real-time-cached'}${q}`);
}

// Row fields per internal/domain/wallet/transaction.go: `type` is lower-case
// credit|debit, the amount is `credit_amount`, what is left of it is
// `credits_available`, expiry is `expiry_date` (NOT expiry_date_utc — that name is
// only on the *request*), and `priority` is real: internal/repository/ent/wallet.go:279-281
// draws `ASC(priority), ASC(expiry_date), DESC(credit_amount)`.
async function transactions(walletId, params = {}) {
  const q = new URLSearchParams(params).toString();
  return req('GET', `/v1/wallets/${walletId}/transactions${q ? `?${q}` : ''}`);
}

// Wallet transaction collections are keyed `items` (measured on the live stack:
// GET /v1/wallets/:id/transactions -> {"items":[…]}). `data` was the guess, and a
// guess that returns undefined reads as "no transactions exist" — the same class of
// mistake as reading `total` off a response whose field is `value`. Kept as a
// helper so every probe agrees on it, and so a rerun on a version that renames the
// key shows up as an empty row list in ONE place instead of eight.
function txRows(json) {
  return json?.items ?? json?.data ?? [];
}

// The one usage read every ingest probe depends on. Two shapes were wrong here
// for a while and each produced a *plausible-looking* failure, which is why they
// are documented rather than silently fixed:
//
//  1. `period_start`/`period_end` are not the field names — the DTO takes
//     `start_time`/`end_time`, and unknown fields are dropped by the binder, so
//     the window defaulted and the query answered 404 "Event not found in events
//     table for this time range; pass start_time and end_time…" — an error
//     message that names the very fields the caller had spelled wrong.
//  2. The response field is `value`, NOT `total`, and it is `omitempty`
//     (internal/api/dto/events.go:231-236: `Value float64 json:"value,omitempty"`).
//     A SUM of zero therefore returns NO key at all. `json.value === undefined`
//     means "zero rows matched", not "request failed" — and a probe that treats
//     undefined as -1 cannot tell "the meter matched nothing" apart from "the
//     pipeline never delivered the event", which is exactly the distinction
//     items 5, 6 and 12 are about.
async function pollUsage(meterId, customerId, timeoutMs = 60000, expectedValue = null) {
  const now = Date.now();
  const started = Date.now();
  const body = {
    meter_id: meterId,
    external_customer_id: customerId,
    start_time: new Date(now - 6 * 3600 * 1000).toISOString(),
    end_time: new Date(now + 600 * 1000).toISOString(),
  };
  let last = null;
  // `expectedValue` matters: "value > 0" returns on the FIRST event that lands, so a
  // probe that posts three events and then asserts 3695 would race the consumer and
  // read 90. Measured live — the same three-event set came back 90, then 3695.
  const done = (v) => (expectedValue === null ? v > 0 : v >= expectedValue);
  while (Date.now() - started < timeoutMs) {
    const res = await req('POST', '/v1/events/usage/meter', body);
    last = res;
    if (res.status === 200 && done(Number(res.json?.value ?? 0))) {
      return { res, value: Number(res.json.value), waitedMs: Date.now() - started };
    }
    await sleep(3000);
  }
  return { res: last, value: Number(last?.json?.value ?? 0), waitedMs: Date.now() - started, timedOut: true };
}

// Item 5/6/B7 all read usage, and every one of them previously produced a
// misleading verdict because the stack was not delivering events at all (see the
// compose kafka topic finding). This probe runs FIRST and says so loudly: if it
// fails, the ingest-shaped failures below it are infrastructure, not semantics.
// It is the difference between "FlexPrice ignores event_id" and "the producer
// published to a topic no consumer reads" — and only one of those is a design
// constraint we have to build around.

// ------------------------------------------------------------------- probes

const PROBES = [

  // NOT a plan item — the gate that makes the other ingest verdicts mean what
  // they say. Every "usage_total: -1 / items: []" in the first spike runs looked
  // like a FlexPrice semantics finding, and none of them were: the producer
  // published to kafka.topic="staging_events" while the usage consumers subscribe
  // to event_processing.topic="events", so /v1/events returned 202, every health
  // check passed, and ClickHouse never received a row. Two days of verdicts were
  // measuring an empty pipe.
  //
  // So this runs FIRST. If it fails, items 5, 6, 12 and the B7 grouping probes are
  // not evidence about FlexPrice — they are evidence about the compose stack — and
  // the diagnostics below say which half of the pipe is empty.
  {
    name: 'pipeline-health',
    item: null,
    async run() {
      const c = await makeCustomer('pipe');
      const eventName = `${RUN}.pipe`;
      const meterId = await makeMeter(eventName, 'SUM', 'qty');
      const QTY = 424242;
      const post = await req('POST', '/v1/events', {
        event_id: `${RUN}-pipe-1`,
        event_name: eventName,
        external_customer_id: c.external_id,
        timestamp: new Date().toISOString(),
        properties: { qty: QTY },
        source: 'spike',
      });
      const usage = await pollUsage(meterId, c.external_id, 60000, QTY);
      const ok = usage.value === QTY;
      const diagnostics = ok ? null : {
        // Where the event died: accepted but not stored (producer→topic), stored
        // but not aggregated (consumer), or aggregated and only the read is wrong.
        clickhouse_rows_for_this_event: chQuery(
          `SELECT count() FROM flexprice.events WHERE event_name = '${eventName}'`,
        ),
        clickhouse_rows_total: chQuery('SELECT count() FROM flexprice.events'),
        kafka_topics: kafkaTopics(),
      };
      return verdict('pipeline-health', null, ok,
        { post_status: post.status, expected_value: QTY, value: usage.value,
          waited_ms: usage.waitedMs, timed_out: Boolean(usage.timedOut),
          raw_response: truncate(usage.res?.text).slice(0, 300),
          diagnostics },
        ok
          ? 'the ingest pipe is live; the usage-shaped verdicts below are about FlexPrice semantics'
          : 'INGEST PIPE BROKEN — check the FLEXPRICE_KAFKA_TOPIC* alignment block in deploy/flexprice/compose.yaml (producer topic vs the two consumer topics must be one name), then rerun. Do NOT record the failures below as findings',
      );
    },
  },

  // Item 1 + finding 0.3: is money a JSON number or a JSON string, and what does
  // a sub-paise amount do? The client boundary in B1 depends on the answer; a
  // `typeof === 'number'` guard on a quoted decimal is a silent 0.
  {
    name: 'money-wire-shape',
    item: '1',
    async run() {
      const c = await makeCustomer('money');
      const w = await makeWallet(c);
      const cases = [
        { label: 'Rs500.00', credits: '500.00' },
        { label: 'Rs500.50', credits: '500.50' },
        { label: 'Rs0.005 (sub-paise)', credits: '0.005' },
      ];
      const seen = [];
      for (const t of cases) {
        const res = await topUp(w.id, { credits_to_add: t.credits });
        seen.push({ case: t.label, status: res.status, body: truncate(res.text).slice(0, 240) });
      }
      const bal = await balance(w.id);
      const quoted = /"(real_time_credit_balance|credits_available_breakdown)"\s*:\s*"/.test(bal.text);
      const numeric = /"(real_time_credit_balance)"\s*:\s*[0-9]/.test(bal.text);
      const parsed = bal.json || {};
      const sum = cases.reduce((a, t) => a + Number(t.credits), 0);
      return verdict(
        'money-wire-shape', '1',
        quoted && !numeric,
        { decimalMarshalsAs: quoted ? 'JSON string' : numeric ? 'JSON number' : 'unknown',
          requestedTotalCredits: sum,
          real_time_credit_balance: parsed.real_time_credit_balance,
          breakdown: parsed.credits_available_breakdown,
          per_topup: seen },
        quoted
          ? 'B1 parses money as string->exact paise at the boundary; never parseFloat, never Math.round(x*100)'
          : 'B1 must handle numbers too — and then the float64 precision question is live, not theoretical',
      );
    },
  },

  // Item 5: does event_id dedupe, and does a replayed id with a different payload
  // silently win? Decides whether the outbox may retry blindly.
  {
    name: 'ingest-idempotency',
    item: '5',
    async run() {
      const c = await makeCustomer('idem');
      const meterId = await makeMeter(`${RUN}.idem`);
      const eventId = `${RUN}-idem-event`;
      const ev = (qty, tsOffset = 0) => ({
        event_id: eventId,
        event_name: `${RUN}.idem`,
        external_customer_id: c.external_id,
        timestamp: new Date(Date.now() + tsOffset).toISOString(),
        properties: { qty, value: qty },
        source: 'spike',
      });
      const first = await req('POST', '/v1/events', ev(10));
      const replaySame = await req('POST', '/v1/events', ev(10));
      const replayChanged = await req('POST', '/v1/events', ev(999, 1000));
      // 10 is the floor: a replay that is deduped still has to land the first event.
      const usage = await pollUsage(meterId, c.external_id, 45000, 10);
      const total = usage.value;
      // 10 => deduped on event_id; 1010 => last-write-wins on payload; 1009 => first
      // payload kept and only the changed one appended; other => no dedup at all.
      // 0 is NOT an answer to item 5 — it means the events never reached the
      // aggregation, so it is reported as infrastructure rather than semantics.
      const meaning = total === 10 ? 'deduped by event_id'
        : total === 1010 ? 'LAST WRITE WINS - replay with a different payload overwrites'
        : total === 1009 ? 'id kept, payload frozen on first sight'
        : total === 1019 ? 'NO dedup: 10+10+999 all counted'
        : total === 0 ? 'NOT MEASURED - no usage rows reached the meter; trust pipeline-health, not this probe'
        : `uninterpreted (${total})`;
      return verdict('ingest-idempotency', '5', total === 10,
        { first: first.status, replaySame: replaySame.status, replayChanged: replayChanged.status,
          same_id_body: truncate(replaySame.text).slice(0, 200),
          changed_id_body: truncate(replayChanged.text).slice(0, 200),
          usage_value: total, meaning, consumer_wait_ms: usage.waitedMs },
        total === 10
          ? 'the outbox may retry blindly'
          : 'the outbox MUST NOT retry blindly — a drained record can be overwritten or double-counted',
      );
    },
  },

  // Item 6 + §3: 202 proves nothing. How long from accepted to queryable, and what
  // happens for an event whose meter does not exist?
  // The second half is the one that decides B3's alarm: a meter pointing at a
  // property that is not on the events is NOT an error. The aggregation extracts
  // with `JSONExtractFloat(assumeNotNull(properties), ?)`
  // (internal/repository/clickhouse/aggregators.go:347), and a missing or non-numeric
  // key extracts to 0.0 — so a typo in `aggregation.field` prices every session at
  // zero and reads as "usage: 0", which is the exact silent-free-usage failure the
  // plan asked about. Probed, not assumed.
  {
    name: 'ingest-durability',
    item: '6',
    async run() {
      const c = await makeCustomer('dur');
      const eventName = `${RUN}.dur`;
      const meterId = await makeMeter(eventName, 'SUM', 'qty');
      const t0 = Date.now();
      const res = await req('POST', '/v1/events', {
        event_id: `${RUN}-dur-1`,
        event_name: eventName,
        external_customer_id: c.external_id,
        timestamp: new Date().toISOString(),
        properties: { qty: 3600 },
        source: 'spike',
      });
      const usage = await pollUsage(meterId, c.external_id, 90000, 3600);
      const orphan = await req('POST', '/v1/events', {
        event_id: `${RUN}-dur-orphan`,
        event_name: `${RUN}.no-such-meter`,
        external_customer_id: c.external_id,
        timestamp: new Date().toISOString(),
        properties: { qty: 1 },
      });
      const typoMeter = await makeMeter(eventName, 'SUM', 'qtty');
      const typoUsage = await req('POST', '/v1/events/usage/meter', {
        meter_id: typoMeter,
        external_customer_id: c.external_id,
        start_time: new Date(Date.now() - 6 * 3600e3).toISOString(),
        end_time: new Date(Date.now() + 600e3).toISOString(),
      });
      // `value` is omitempty, so the silent-free-usage signature is a 200 whose
      // body has NO value key at all — the events are in the table under this
      // event_name (the good meter just read 3600 of them), but the meter's
      // `qtty` field extracts to 0.0 and the zero is elided from the JSON.
      const silentZero = typoUsage.status === 200
        && (typoUsage.json?.value === undefined || Number(typoUsage.json.value) === 0);
      return verdict('ingest-durability', '6',
        res.status < 300 && usage.value === 3600 && silentZero,
        { accepted_status: res.status, accepted_ms: Date.now() - t0,
          queryable_after_ms: usage.waitedMs, timed_out: Boolean(usage.timedOut),
          value: usage.value,
          meterless_event: { status: orphan.status, body: truncate(orphan.text).slice(0, 300) },
          typo_field_meter: { status: typoUsage.status, value: typoUsage.json?.value ?? '(absent = 0)',
            body: truncate(typoUsage.text).slice(0, 200), silently_free: silentZero },
          bad_field_on_meter_create: 'accepted (POST /v1/meters does not validate the property name against any event)' },
        'B3 drains in bulk and verifies by read-back; and a meter whose field matches nothing is a 200 with total 0, so the reconciliation job must compare FlexPrice usage against LiteLLM/runner counts, not against nothing',
      );
    },
  },

  // Item 12 + B5: the gate reads a computed projection per run, 8 call sites.
  {
    name: 'balance-realtime-latency',
    item: '12',
    async run() {
      const c = await makeCustomer('lat');
      const w = await makeWallet(c);
      await topUp(w.id, { credits_to_add: '50000' });
      const samples = [];
      for (let i = 0; i < 12; i += 1) samples.push((await balance(w.id)).ms);
      for (let i = 0; i < 6; i += 1) samples.push((await balance(w.id, false)).ms);
      samples.sort((a, b) => a - b);
      const p50 = samples[Math.floor(samples.length * 0.5)];
      const p95 = samples[Math.floor(samples.length * 0.95)];
      const last = await balance(w.id);
      return verdict('balance-realtime-latency', '12', p95 < 300,
        { n: samples.length, p50_ms: p50, p95_ms: p95, max_ms: samples[samples.length - 1],
          fields: Object.keys(last.json || {}),
          is_cached_fallback: last.json?.is_cached_fallback },
        p95 < 300 ? 'the 30ms single-flight budget needs revising upward, but the endpoint is not pathological'
          : 'the gate cannot call this synchronously per run — B5 needs the cached accessor and a longer TTL',
      );
    },
  },

  // §2 + item 17: MANUAL_BALANCE_DEBIT is the one operation that can overdraw.
  // §6b: and its replay is a unique-violation error, not the original txn.
  {
    name: 'manual-debit-negative-and-replay',
    item: '12/17',
    async run() {
      const c = await makeCustomer('debit');
      const w = await makeWallet(c);
      await topUp(w.id, { credits_to_add: '100' });
      const key = `${RUN}-platform-2026-11`;
      const first = await req('POST', `/v1/wallets/${w.id}/debit`, {
        credits: '3000', transaction_reason: 'MANUAL_BALANCE_DEBIT',
        idempotency_key: key, description: 'platform charge spike',
        metadata: { fleet_charge: 'platform_subscription' },
      });
      const replay = await req('POST', `/v1/wallets/${w.id}/debit`, {
        credits: '3000', transaction_reason: 'MANUAL_BALANCE_DEBIT', idempotency_key: key,
      });
      const bal = await balance(w.id);
      const missingKey = await req('POST', `/v1/wallets/${w.id}/debit`, {
        credits: '1', transaction_reason: 'MANUAL_BALANCE_DEBIT',
      });
      return verdict('manual-debit-negative-and-replay', '12/17',
        first.status < 300 && replay.status >= 400,
        { first_status: first.status, first_body: truncate(first.text).slice(0, 200),
          replay_status: replay.status, replay_body: truncate(replay.text).slice(0, 300),
          balance_after: bal.json?.real_time_credit_balance,
          went_negative: Number(bal.json?.real_time_credit_balance) < 0,
          missing_idempotency_key: { status: missingKey.status, body: truncate(missingKey.text).slice(0, 200) } },
        'B1 must map that exact replay error to "already charged, success"; and the gate needs a negative state or the charge job needs a pre-check',
      );
    },
  },

  // Item 14: is `metadata.auto_completed` really the only way to a paid statement
  // invoice, and do the fields that look right get dropped silently?
  {
    name: 'statement-invoice-auto-completed',
    item: '14',
    async run() {
      const c = await makeCustomer('inv');
      // `customer_id`, the internal cust_... id: dto.CreateInvoiceRequest has no
      // external_customer_id field at all (internal/api/dto/invoice.go:84,
      // validate:"required"), so encoding/json drops it and the service asks the
      // repo for customer "" — which answers 404 "Customer with ID  was not found".
      // Events and wallets take the external id; invoices do not. That asymmetry is
      // the kind of thing B1's client has to encode once, here.
      const naive = await req('POST', '/v1/invoices', {
        invoice_type: 'ONE_OFF', billing_reason: 'MANUAL', currency: 'INR',
        amount_due: '3000.00', subtotal: '3000.00', total: '3000.00',
        customer_id: c.id,
        invoice_status: 'FINALIZED', payment_status: 'SUCCEEDED', amount_paid: '3000.00',
      });
      const auto = await req('POST', '/v1/invoices', {
        invoice_type: 'ONE_OFF', billing_reason: 'MANUAL', currency: 'INR',
        amount_due: '3000.00', subtotal: '3000.00', total: '3000.00',
        customer_id: c.id,
        invoice_status: 'FINALIZED',
        metadata: { auto_completed: 'true', fleet_charge: 'platform_subscription' },
      });
      const readBack = (r) => ({
        status: r.status,
        id: r.json?.id,
        invoice_status: r.json?.invoice_status,
        payment_status: r.json?.payment_status,
        amount_paid: r.json?.amount_paid,
        amount_remaining: r.json?.amount_remaining,
        tax: r.json?.tax_amount ?? r.json?.tax ?? null,
      });
      const a = readBack(naive); const b = readBack(auto);
      // The field-based "it was already paid" attempt is not the documented path:
      // payment_status/amount_paid are bound but never propagated
      // (dto.ToDraftRequest/ToComputeRequest, internal/api/dto/invoice.go:186-215),
      // and the route that does exist is PUT /v1/invoices/:id/payment. Probing it
      // because B8's Zoho emitter reads statements, and a statement nobody can mark
      // settled is a statement that will get "fixed" by someone at 2am.
      const paid = auto.json?.id
        ? await req('PUT', `/v1/invoices/${auto.json.id}/payment`, {
          payment_status: 'SUCCEEDED', amount: '3000.00',
        })
        : { status: 0, text: 'no invoice id' };
      return verdict('statement-invoice-auto-completed', '14',
        // Measured: the response spells the enum UPPERCASE ("SUCCEEDED"), so a
        // lowercase comparison here read as a product finding for a day.
        String(b.payment_status).toUpperCase() === 'SUCCEEDED' && Number(b.amount_remaining) === 0,
        { payment_status_field_accepted_then_dropped: a,
          metadata_auto_completed: b,
          explicit_payment_route: { status: paid.status, read_back: paid.status < 400
            ? readBack(await req('GET', `/v1/invoices/${auto.json.id}`)) : truncate(paid.text).slice(0, 200) },
          naive_body: truncate(naive.text).slice(0, 400) },
        String(a.payment_status).toUpperCase() === 'SUCCEEDED'
          ? 'source claim WRONG: payment_status is honoured on this path — recheck ToDraftRequest'
          : 'confirms §6b: metadata.auto_completed is the only lever; the request field is silently ignored',
      );
    },
  },

  // §5: GST as line items with no price_id. This is the whole tax posture.
  // Line-item fields per internal/api/dto/invoice.go:815-860: the text is
  // `display_name` (there is no `description` on a line item), `amount` and
  // `quantity` are both validate:"required" — quantity 0 fails it — and `price_id`
  // is required only when invoice_type is SUBSCRIPTION (invoice.go:916). So a
  // price-less ₹45 CGST line should be legal; this probe is the empirical half of
  // the claim "their tax engine stays unconfigured and GST is disclosed lines".
  {
    name: 'invoice-line-item-without-price',
    item: '9/GST',
    async run() {
      const c = await makeCustomer('gst');
      const period = {
        period_start: new Date(Date.now() - 3600e3).toISOString(),
        period_end: new Date().toISOString(),
      };
      const line = (display_name, amount) => ({
        display_name, amount, quantity: 1, price_type: 'FIXED', ...period,
      });
      const body = {
        invoice_type: 'ONE_OFF', billing_reason: 'MANUAL', currency: 'INR',
        amount_due: '590.00', subtotal: '500.00', total: '590.00',
        customer_id: c.id,
        invoice_status: 'FINALIZED',
        metadata: { auto_completed: 'true', fleet_charge: 'recharge_statement' },
        line_items: [
          line('Platform credits', '500.00'),
          line('CGST @ 9%', '45.00'),
          line('SGST @ 9%', '45.00'),
        ],
      };
      const res = await req('POST', '/v1/invoices', body);
      const j = res.json || {};
      const emptyTax = await req('POST', '/v1/invoices', {
        ...body, metadata: { auto_completed: 'true', probe: 'tax_rates_empty_array' },
        line_items: body.line_items, tax_rates: [],
      });
      const e = emptyTax.json || {};
      const lines = (j.line_items || []).map((li) => ({
        price_id: li.price_id ?? null, display_name: li.display_name,
        amount: li.amount, quantity: li.quantity, price_type: li.price_type,
      }));
      // What B actually needs from this probe is two separate things, and the
      // earlier draft conflated them into one assertion on `total`:
      //   (a) are price-less tax lines LEGAL? -> lines accepted at all.
      //   (b) is FlexPrice's `total` the sum of the disclosed lines? -> measured
      //       answer is NO: total came back equal to the subtotal ("500") with
      //       total_tax "0" while three lines of 500 + 45 + 45 were stored. So the
      //       invoice total is NOT a number the recharge UI may render as "charged",
      //       and gst.js's derived-by-addition total is the only authoritative one.
      const lineSum = lines.reduce((a, li) => a + Number(li.amount || 0), 0);
      return verdict('invoice-line-item-without-price', '9/GST',
        res.status < 400 && lines.length === 3,
        { status: res.status, id: j.id,
          totals: { subtotal: j.subtotal, total: j.total, total_tax: j.total_tax, amount_paid: j.amount_paid, amount_remaining: j.amount_remaining },
          // The assertion that matters for B7/B2, kept separate from legality:
          requested_total: '590.00', stored_line_sum: lineSum, reported_total: j.total,
          total_equals_line_sum: Number(j.total) === lineSum,
          total_ignores_tax_lines: Number(j.total) === Number(j.subtotal),
          payment_status: j.payment_status, invoice_status: j.invoice_status,
          taxes_applied: j.taxes ?? null, tax_summary: j.tax_summary ?? null,
          line_items: lines,
          with_explicit_empty_tax_rates: { status: emptyTax.status, total: e.total, total_tax: e.total_tax },
          error_body: truncate(res.text).slice(0, 400) },
        res.status < 400
          ? 'price-less tax lines are LEGAL, but the invoice total does not include them — B2/B7 must render the GST breakdown from gst.js (total derived by addition) and never present FlexPrice `total` as the amount charged; sum(tax)==0 on period invoices still holds by construction'
          : 'fallback needed: ONE_OFF prices per tax component, or a second exempt customer record for statements',
      );
    },
  },

  // Item 3/15: promo-then-prepaid draw order, and whether the drawn source is
  // reported per line (the Usage page column).
  // Their ORDER BY is internal/repository/ent/wallet.go:279-281 —
  // ASC(priority), ASC(expiry_date), DESC(credit_amount) — and `priority` is
  // lower-is-first, so prepaid must be seeded with the HIGHER number for our policy
  // (promo first) to be what their sort does rather than what we hope for.
  {
    name: 'draw-order-and-source',
    item: '3/15',
    async run() {
      const c = await makeCustomer('draw');
      const w = await makeWallet(c);
      const far = new Date(Date.now() + 365 * 864e5).toISOString();
      const soon = new Date(Date.now() + 7 * 864e5).toISOString();
      await topUp(w.id, { credits_to_add: '1000', transaction_reason: 'PURCHASED_CREDIT_DIRECT', priority: 1, expiry_date_utc: far });
      await topUp(w.id, { credits_to_add: '500', transaction_reason: 'FREE_CREDIT_GRANT', priority: 0, expiry_date_utc: soon });
      const debit = await req('POST', `/v1/wallets/${w.id}/debit`, {
        // ManualBalanceDebitRequest validates transaction_reason against a
        // single-value allow-list: INVOICE_PAYMENT is refused 400 with
        // {"details":{"allowed_reasons":["MANUAL_BALANCE_DEBIT"]}} (measured).
        // That IS the item-17 answer for the Rs3000/month platform charge — the
        // manual debit route can only ever stamp MANUAL_BALANCE_DEBIT, so the
        // charge is identifiable in the ledger by route, not by reason, and a
        // reason of its own would have to come from an invoice/usage path.
        credits: '700', transaction_reason: 'MANUAL_BALANCE_DEBIT', idempotency_key: `${RUN}-draw-debit`,
      });
      const credits = await transactions(w.id, { type: 'credit' });
      const debits = await transactions(w.id, { type: 'debit' });
      const rows = txRows(credits.json).map((t) => ({
        reason: t.transaction_reason, issued: t.credit_amount, available: t.credits_available,
        expiry: t.expiry_date, priority: t.priority, id: t.id,
      }));
      const promo = rows.find((r) => r.reason === 'FREE_CREDIT_GRANT');
      const prepaid = rows.find((r) => r.reason === 'PURCHASED_CREDIT_DIRECT');
      const promoEaten = promo && Number(promo.available) === 0;
      const debitRows = txRows(debits.json).map((t) => ({
        reason: t.transaction_reason, amount: t.credit_amount,
        ref: t.reference_type ?? null, ref_id: t.reference_id ?? null,
        parent: t.parent_transaction_id ?? null,
      }));
      return verdict('draw-order-and-source', '3/15', promoEaten && Number(prepaid?.available) === 800,
        { debit_status: debit.status, debit_body: truncate(debit.text).slice(0, 240),
          // The spendable figure is `real_time_credit_balance`; `credits_available`
          // is a per-ROW field on a transaction and does not exist on the balance
          // response, which is why this read used to report 0 on a funded wallet.
          balance: (await balance(w.id)).json?.real_time_credit_balance,
          credit_type_filter_honored: txRows(credits.json).every((t) => t.type === 'credit')
            && txRows(debits.json).every((t) => t.type === 'debit'),
          per_credit_row_remaining: rows.map((r) => `${r.reason}: ${r.available}/${r.issued} (prio ${r.priority}, exp ${r.expiry})`),
          // Item 15's actual question: is the drawn SOURCE reported? One debit row
          // for a 700 draw means the answer is no, and the Usage column has to come
          // from us; N rows referencing N credit rows means it is theirs to give.
          debit_rows: debitRows,
          drawn_source_reported: debitRows.some((d) => d.parent),
          credit_row_fields: Object.keys(txRows(credits.json)[0] || {}) },
        promoEaten
          ? 'their ORDER BY does our policy: seed promo with the LOWER priority number at credit time, and the per-row remaining+expiry is the Usage column'
          : 'our draw policy is NOT what ran — check whether priority or expiry won',
      );
    },
  },

  // Item 19: no promo bucket in the breakdown; remaining + next expiry must come
  // from the transactions search.
  // `credits_available_breakdown` is omitempty AND expand-gated
  // (internal/api/v1/wallet.go:364-373, internal/types/expand.go:39) — asking for
  // the balance without ?expand=credits_available_breakdown yields a response with
  // the key simply absent, which is exactly what the first run of this probe saw and
  // what would otherwise read as "the field does not exist". Its two keys are
  // `purchased` and `free` (internal/types/wallet.go:398-401), and the populating
  // SQL (internal/repository/ent/wallet.go:1825) ignores expiry_date entirely and
  // files PURCHASED_CREDIT_BONUS rows in NEITHER bucket. Both halves are asserted
  // below, because the plan's expiry UI depends on which of them is true.
  {
    name: 'promo-bucket-and-expiry-search',
    item: '19',
    async run() {
      const c = await makeCustomer('promo');
      const soon = new Date(Date.now() + 3 * 864e5);
      const w = await makeWallet(c, {
        initial_credits_to_load: '500',
        initial_credits_expiry_date_utc: soon.toISOString(),
      });
      const top = await topUp(w.id, {
        credits_to_add: '5000', transaction_reason: 'PURCHASED_CREDIT_DIRECT',
        bonus_credits_to_add: '500', bonus_credits_expiry_date_utc: soon.toISOString(),
      });
      const plain = await balance(w.id);
      const expanded = await balance(w.id, true, 'credits_available_breakdown');
      const breakdown = expanded.json?.credits_available_breakdown || null;
      const search = await req('POST', '/v1/wallets/transactions/search', {
        id: w.id, type: 'credit', credits_available_gt: '0',
        expiry_date_before: new Date(Date.now() + 30 * 864e5).toISOString(),
      });
      const rows = txRows(search.json).map((t) => ({
        reason: t.transaction_reason, available: t.credits_available,
        expiry: t.expiry_date, priority: t.priority, parent: t.parent_transaction_id ?? null,
      }));
      // Measured live: the spendable number is `real_time_credit_balance` (a quoted
      // decimal), `credits_available` is a per-TRANSACTION-row field and is absent
      // from the balance response. Reading it there yields undefined -> 0, which is
      // how this probe first reported an empty wallet that actually held 1500.
      const total = Number(plain.json?.real_time_credit_balance ?? 0);
      const bucketed = breakdown ? Number(breakdown.purchased || 0) + Number(breakdown.free || 0) : null;
      // 🔴 MEASURED BUG, and it is not "the promo is missing from a bucket" — it is
      // that the bucket read does not exist at all once a bonus row is present.
      // GetCreditsAvailableBreakdown (internal/repository/ent/wallet.go:1826-1856)
      // classifies rows with a CASE that has NO ELSE branch:
      //     WHEN reason IN ('PURCHASED_CREDIT_INVOICED','PURCHASED_CREDIT_DIRECT') THEN 'PURCHASED'
      //     WHEN reason IN ('FREE_CREDIT_GRANT','SUBSCRIPTION_CREDIT_GRANT')       THEN 'FREE'
      // every other reason -> credit_type NULL, and the scan target is a non-nullable
      // Go string, so the query fails with
      //     sql: Scan error on column index 0, name "credit_type":
      //     converting NULL to string is unsupported
      // and the handler SWALLOWS it (internal/api/v1/wallet.go:363-375: "Don't fail
      // the request, just log the error") — HTTP 200, field simply absent. Verified
      // directly against postgres: PURCHASED_CREDIT_BONUS groups to NULL.
      //
      // The consequence for the coupon design is first-order: `bonus_credits_to_add` —
      // FlexPrice's OWN bonus mechanism, the one B2's coupon path would use — mints a
      // PURCHASED_CREDIT_BONUS row that poisons the entire breakdown for that wallet.
      // So the promo/purchased split must come from the transaction ROWS (reason is
      // carried there), and anything we want to appear in a bucket must be minted with
      // a reason inside the CASE's covered set — FREE_CREDIT_GRANT for coupon bonus,
      // which is also what `initial_credits_to_load` already produces (item 20).
      // `docker logs` sends the container's own stderr to OUR stderr, and FlexPrice
      // writes error-level JSON lines to stderr — reading only stdout found nothing
      // and the verdict said "(none in window)" about a log line that was there.
      const breakdownLog = spawnSync('docker', ['logs', '--since', '3m',
        'fleet-flexprice-api-1'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const breakdownError = `${breakdownLog.stdout || ''}\n${breakdownLog.stderr || ''}`
        .split('\n').filter((l) => l.includes('failed to get credits available breakdown')).pop() || null;
      return verdict('promo-bucket-and-expiry-search', '19',
        search.status < 400 && rows.length >= 2
          && rows.every((r) => r.expiry && r.available !== undefined),
        { breakdown_requested_via_expand: true,
          breakdown_returned: Boolean(breakdown), breakdown_keys: Object.keys(breakdown || {}),
          breakdown_poisoned_by_bonus_row: breakdown === null && rows.some((r) => r.reason === 'PURCHASED_CREDIT_BONUS'),
          api_log_evidence: breakdownError ? truncate(breakdownError).slice(0, 200) : '(none in window)',
          credits_available_total: total, bucketed_sum: bucketed,
          bonus_topup: { status: top.status, rows_created: (top.json ? 1 : 0) + (top.json?.wallet_transaction?.parent_transaction_id ? 1 : 0) },
          initial_credits_accepted: w?.credit_balance ?? null,
          search_response_keys: Object.keys(search.json || {}),
          // The usable answer for the expiry UI: per-row remaining + per-row expiry.
          search_response: { status: search.status, rows,
            fields: Object.keys(txRows(search.json)[0] || {}) } },
        'item 19 answered twice over: the transactions search (type=credit, credits_available_gt=0, expiry_date_before) DOES report remaining + next-expiry per row and is the only reliable source, while credits_available_breakdown is unusable on any wallet holding a PURCHASED_CREDIT_BONUS row — so mint coupon bonus as FREE_CREDIT_GRANT and read rows, never the expand',
      );
    },
  },

  // The B7 grouping question: can the Usage page be served per project / per user
  // from FlexPrice, or do we group in our own read model? Measured on one event set
  // (alpha 90 + 3600, beta 5 => 3695 total), five candidate mechanisms:
  //
  //  1. `group_by` on POST /v1/events/usage — IGNORED for SUM. Grouped and ungrouped
  //     responses are byte-identical ({"value":3695}), because the bucketed group
  //     path is gated on the MAX aggregator only: `hasGroupBy := params.AggregationType
  //     == types.AggregationMax && ...` (internal/repository/clickhouse/event.go:310).
  //     No error, no warning: a Usage page built on this shows every project the
  //     tenant total.
  //  2. `group_by` on POST /v1/events/usage/meter — the field does not exist.
  //     GetUsageByMeterRequest (internal/api/dto/events.go:142-176) has no GroupBy at
  //     all, so the binder drops it. The meter-scoped route can never group.
  //  3. MAX + bucket_size on /v1/events/usage — returns per-BUCKET rows (two rows of
  //     3600 and 5 here) but the HTTP DTO drops the group key
  //     (dto/events.go:231-241 vs internal/domain/events/repository.go:171), so the
  //     rows are not attributable to a project anyway.
  //  4. POST /v1/meter-usage/detailed-analytics — the query builder that DOES write SUM
  //     over per_group CTEs (internal/repository/clickhouse/meter_usage_query_builder.go:293-343).
  //     Measured: {"subtotal":"0","items":[]} under EVERY variant — grouped, ungrouped,
  //     window_size, expand=meter, group_by=source — while /v1/events/usage/meter on the
  //     same meter and customer returns 3695. So it is not a group_by problem: this
  //     endpoint has a structural prerequisite a bare meter does not satisfy (it builds
  //     cost over priced usage lines), and it answers 200-with-nothing rather than
  //     explaining. B7 cannot be served from it as configured.
  //  5. `filters` on POST /v1/events/usage — WORKS, and this is the answer.
  //     {project_id:["alpha"]} -> 3690, {project_id:["beta"]} -> 5,
  //     {user_id:["u1"]} -> 95. Exact, per dimension value.
  //     Two footguns inside it, both silent, both probed:
  //       - the DOTTED form `{"properties.project_id":[...]}` (which is the correct
  //         spelling for group_by) matches nothing and returns a response with no
  //         `value` key at all — indistinguishable from "this project used nothing".
  //       - `property_filters` (a real field on GetEventsRequest, dto/events.go:195) is
  //         IGNORED by this route: the full 3695 came back. So a caller who reaches for
  //         the plausible-looking field gets the tenant total for every project.
  //  6. POST /v1/meter-usage/properties -> {"keys":["project_id","user_id"]} — the
  //     dimension VALUES can be discovered, so the N+1 shape is enumerable rather than
  //     hardcoded. (properties/values 400s on this commit; the value list comes from
  //     our own org/project table regardless, which is the safer source anyway.)
  //
  // Net for B7: one filtered usage query per project/user per period, `filters` keyed
  // on the BARE property name, and never `group_by` on a SUM meter.
  {
    name: 'group-by-event-property',
    item: 'B7',
    async run() {
      const c = await makeCustomer('grp');
      const eventName = `${RUN}.grp`;
      const sumMeter = await makeMeter(eventName, 'SUM', 'qty');
      const rows = [
        { project: 'alpha', user: 'u1', seconds: 90 },
        { project: 'alpha', user: 'u2', seconds: 3600 },
        { project: 'beta', user: 'u1', seconds: 5 },
      ];
      const bulk = await req('POST', '/v1/events/bulk', {
        events: rows.map((r, i) => ({
          event_id: `${RUN}-grp-${i}`,
          event_name: eventName,
          external_customer_id: c.external_id,
          timestamp: new Date().toISOString(),
          source: 'spike',
          properties: { qty: r.seconds, project_id: r.project, user_id: r.user },
        })),
      });
      const waited = await pollUsage(sumMeter, c.external_id, 90000, 3695);
      // GetUsageRequest: `event_name` + `aggregation_type` are binding:"required" and
      // MeterID is json:"-" — a meter_id here is silently discarded. Bounds are
      // start_time/end_time.
      const period = {
        external_customer_id: c.external_id,
        event_name: eventName,
        property_name: 'qty',
        aggregation_type: 'SUM',
        start_time: new Date(Date.now() - 6 * 3600e3).toISOString(),
        end_time: new Date(Date.now() + 600e3).toISOString(),
      };
      const sumUngrouped = await req('POST', '/v1/events/usage', period);
      const sumGrouped = await req('POST', '/v1/events/usage', {
        ...period, group_by: ['properties.project_id'],
      });
      const meterGrouped = await req('POST', '/v1/events/usage/meter', {
        meter_id: sumMeter,
        external_customer_id: c.external_id,
        start_time: period.start_time,
        end_time: period.end_time,
        group_by: ['properties.project_id'],
      });
      const detailed = await req('POST', '/v1/meter-usage/detailed-analytics', {
        external_customer_id: c.external_id,
        meter_ids: [sumMeter],
        group_by: ['properties.project_id'],
        start_time: period.start_time,
        end_time: period.end_time,
      });
      const props = await req('POST', '/v1/meter-usage/properties', {
        meter_id: sumMeter, start_time: period.start_time, end_time: period.end_time,
      });
      // The mechanism B7 will actually use, asserted on exact numbers.
      const byProject = {};
      for (const project of ['alpha', 'beta']) {
        const r = await req('POST', '/v1/events/usage', { ...period, filters: { project_id: [project] } });
        byProject[project] = { value: r.json?.value ?? '(absent = 0)', status: r.status };
      }
      const byUser = await req('POST', '/v1/events/usage', { ...period, filters: { user_id: ['u1'] } });
      const dotted = await req('POST', '/v1/events/usage', { ...period, filters: { 'properties.project_id': ['alpha'] } });
      const propertyFilters = await req('POST', '/v1/events/usage', { ...period, property_filters: { project_id: ['alpha'] } });
      const expect = { alpha: 3690, beta: 5 };
      const exact = Object.entries(expect).every(([k, v]) => Number(byProject[k]?.value) === v)
        && Number(byUser.json?.value) === 95;
      return verdict('group-by-event-property', 'B7', exact,
        { bulk_status: bulk.status, rolled_total: waited.value,
          group_by_sum_ignored: JSON.stringify(sumGrouped.json) === JSON.stringify(sumUngrouped.json),
          group_by_on_meter_route_dropped: JSON.stringify(meterGrouped.json) === JSON.stringify(await req('POST', '/v1/events/usage/meter', {
            meter_id: sumMeter, external_customer_id: c.external_id,
            start_time: period.start_time, end_time: period.end_time,
          }).then((r) => r.json)),
          detailed_analytics_items: (detailed.json?.items ?? []).length,
          detailed_analytics_body: truncate(detailed.text).slice(0, 240),
          discoverable_property_keys: props.json?.keys ?? null,
          filters_per_project: byProject,
          filters_user_u1: byUser.json?.value ?? '(absent = 0)',
          expected_per_project: expect,
          // Both silent failure modes, recorded rather than merely avoided:
          dotted_filter_returns_nothing: dotted.json?.value === undefined,
          property_filters_ignored: Number(propertyFilters.json?.value) === 3695 },
        exact
          ? 'B7 serves per-project/per-user with one POST /v1/events/usage per dimension value using `filters` on the BARE property name; group_by on a SUM meter and the detailed-analytics route must not be used'
          : 'B7 must group in our own read model after all',
      );
    },
  },

  // Item 10 + B1's key plan: can a key be confined to one plane at all?
  // Source says three things that have to be observed rather than trusted, because
  // B1's "writer key / reader key" split is the security control the whole design
  // leans on:
  //   1. Our local config-map key is NOT confineable by design —
  //      internal/rest/middleware/auth.go:26-32 returns
  //      []string{RoleSuperAdmin} for any key found in FLEXPRICE_AUTH_API_KEY_KEYS,
  //      with environmentID returned as "", which is why X-Environment-ID is
  //      caller-chosen for it (auth.go:63-97).
  //   2. A DB-minted key does carry roles (copied from its service account,
  //      internal/ee/service/secret.go:143) and IS environment-bound.
  //   3. Read RBAC is shadow-only: internal/api/router.go:150-152 registers reads
  //      through `observe()` = RequirePermission(..., Shadow()), and
  //      internal/rest/middleware/permission.go:104-121 logs "rbac shadow: request
  //      would be denied" and then calls c.Next(). 136 routes are shadow-read, 26 are
  //      enforced reads; every wallet balance read is in the shadow set.
  // A FAIL from this probe means the environment/tenant boundary is NOT real — that
  // is the re-plan trigger the plan named. When it passes, read the observed block
  // anyway: `reads_confined_by_role: false` is a separate, still-binding finding
  // about where the key may be mounted.
  {
    name: 'key-planes-and-shadow-rbac',
    item: '10',
    async run() {
      const c = await makeCustomer('rbac');
      const w = await makeWallet(c);
      await topUp(w.id, { credits_to_add: '100', transaction_reason: 'PURCHASED_CREDIT_DIRECT' });
      // The mint sequence, as measured on the live stack (both 201):
      //   POST /v1/users            {name, type:"service_account", roles:[…]}
      //       -> {id:"user_…", roles:["event_ingestor"], tenant:{…}}
      //      `email` must be OMITTED — a service account with an email is rejected,
      //      and roles are inherited by the key rather than set on it.
      //   POST /v1/secrets/api/keys {name, type:"private_key", service_account_id}
      //      -> {secret:{id, display_id:"sk_01***…", roles:[…], user_id}, api_key:"sk_…"}
      //      `type` is `binding:"required"` and the only accepted values are
      //      private_key|publishable_key|integration — "api_key" is not one of them,
      //      which is the 400 this probe used to report as "no key minted".
      // Note what is NOT in the response: no environment_id. So confinement of a
      // DB-minted key is only observable behaviorally, via the foreign-header test.
      const sa = await req('POST', '/v1/users', {
        name: `${RUN} ingestor`, type: 'service_account', roles: ['event_ingestor'],
      });
      const saId = sa.json?.id ?? sa.json?.user?.id ?? null;
      const minted = saId
        ? await req('POST', '/v1/secrets/api/keys', {
          name: `${RUN} ingest key`, type: 'private_key', service_account_id: saId,
        })
        : { status: 0, json: null, text: 'no service account id' };
      const scoped = minted.json?.api_key || null;
      const eventName = `${RUN}.rbac`;
      const meterBody = { name: `${RUN} rbac meter`, event_name: eventName, aggregation: { type: 'SUM', field: 'qty' } };

      const ownWrite = scoped ? await req('POST', '/v1/events', {
        event_id: `${RUN}-rbac-1`, event_name: eventName, external_customer_id: c.external_id,
        timestamp: new Date().toISOString(), properties: { qty: 1 }, source: 'spike',
      }, scoped) : { status: 0, text: 'no key minted' };
      const crossWrite = scoped ? await req('POST', '/v1/meters', meterBody, scoped)
        : { status: 0, text: 'no key minted' };
      const shadowRead = scoped ? await req('GET', `/v1/wallets/${w.id}/balance/real-time`, undefined, scoped)
        : { status: 0, text: 'no key minted' };
      // Environment confinement: the wallet lives in the seeded Production
      // environment. If a foreign X-Environment-ID still returns it, the bound
      // environment won and the header was ignored (confined). A 404 would mean the
      // caller picks its own environment.
      const foreign = scoped ? await (async () => {
        try {
          const res = await fetch(`${BASE}/v1/wallets/${w.id}/balance/real-time`, {
            headers: { 'x-api-key': scoped, 'X-Environment-ID': '00000000-0000-0000-0000-000000000000' },
            signal: AbortSignal.timeout(8000),
          });
          const text = await res.text();
          return { status: res.status, same_wallet_returned: text.includes(w.id), body: truncate(text).slice(0, 160) };
        } catch (e) { return { status: 0, body: e.message }; }
      })() : { status: 0, body: 'no key minted' };
      // And the control: does our OWN config-map key follow the header? It must,
      // because that is the seam the bootstrap asserts and the reason the two key
      // kinds are not interchangeable.
      const configKeyForeignEnv = await (async () => {
        try {
          const res = await fetch(`${BASE}/v1/wallets/${w.id}/balance/real-time`, {
            headers: { 'x-api-key': API_KEY, 'X-Environment-ID': '00000000-0000-0000-0000-000000000000' },
            signal: AbortSignal.timeout(8000),
          });
          return { status: res.status, body: truncate(await res.text()).slice(0, 160) };
        } catch (e) { return { status: 0, body: e.message }; }
      })();

      // What "ok" means here, because the plan made item 10 a re-plan trigger and
      // the honest answer is two-tone. `ok` answers the question as the plan asked it:
      // is org=customer separation REAL SCOPING or merely a filter under one bearer
      // key? Measured: real — an environment-bound key cannot cross environments even
      // when the caller sends a foreign X-Environment-ID (the binding wins and the
      // header is ignored), and a lesser role is refused writes outright.
      // `reads_confined` is the second half and is FALSE: RBAC on reads is
      // shadow-only, so an event_ingestor key reads any wallet in the tenant. That is
      // not a broken probe and it is not a reason to re-plan — it is a constraint on
      // where the FlexPrice key may be mounted (services/billing only) and on how the
      // two-plane split may be described (a write boundary, never a read boundary).
      const readsConfined = shadowRead.status >= 400;
      // A foreign header that returns the SAME wallet means the key's own environment
      // won and the header was ignored. A different wallet or a 404 would mean the
      // caller picks its environment, i.e. no confinement.
      const environmentConfinementHolds = foreign.status < 400
        ? foreign.same_wallet_returned === true
        : foreign.status === 403;
      return verdict('key-planes-and-shadow-rbac', '10',
        Boolean(scoped) && ownWrite.status < 300 && crossWrite.status >= 400
          && environmentConfinementHolds,
        { // The raw secret is deliberately absent from every field below: this
          // verdict is written to docs/flexprice-spike/results.json.
          minted: { sa_status: sa.status, key_status: minted.status,
            roles_on_key: minted.json?.secret?.roles ?? null,
            // No environment_id is returned on the secret, so binding is only
            // observable behaviorally — the foreign-header test below.
            env_bound: minted.json?.secret?.environment_id ?? 'not in response',
            api_key_chars: scoped ? scoped.length : 0 },
          scoping_is_real_not_a_filter: environmentConfinementHolds,
          writes_confined_by_role: crossWrite.status >= 400,
          reads_confined_by_role: readsConfined,
          config_map_key_follows_caller_header: configKeyForeignEnv.status < 400,
          own_plane_write_event: { status: ownWrite.status, body: truncate(ownWrite.text).slice(0, 160) },
          other_plane_write_meter: { status: crossWrite.status, body: truncate(crossWrite.text).slice(0, 200) },
          shadow_read_of_wallet_balance: { status: shadowRead.status,
            body: truncate(shadowRead.text).slice(0, 200) },
          db_key_with_foreign_env_header: foreign,
          config_map_key_with_foreign_env_header: configKeyForeignEnv },
        readsConfined
          ? 'role enforcement holds on reads too: B1 may treat the writer key as write-only'
          : 'WRITES are confined and the environment binding is real, but READS ARE NOT — shadow RBAC means a lesser key still reads any wallet in its tenant/environment. B1 must not present the two-plane key split as a read boundary; keep every FlexPrice read inside services/billing, and note that the config-map key (super_admin, caller-chosen environment) can NEVER be the plane key: B1 must use a DB-minted key.',
      );
    },
  },

  // §6: the unsigned-transport claim, observed from the client side.
  {
    name: 'webhook-transport-shape',
    item: '§6',
    async run() {
      const listed = await req('GET', '/v1/webhooks');
      const settings = await req('GET', '/v1/config');
      return verdict('webhook-transport-shape', '§6', null,
        { get_webhooks: { status: listed.status, body: truncate(listed.text).slice(0, 260) },
          config_read: { status: settings.status, body: truncate(settings.text).slice(0, 260) } },
        listed.status >= 400
          ? 'confirms endpoints come from operator YAML, not tenant input: no user-settable URL, and no per-tenant management without Svix'
          : 'tenant-manageable webhook endpoints exist over the API — revisit the "no user-settable URL" claim',
      );
    },
  },

  // Item 13: what this stack actually costs in RAM. The number the plan needs
  // before anyone believes "runs locally".
  {
    name: 'resource-footprint',
    item: '13',
    async run() {
      const out = spawnSync('docker', ['stats', '--no-stream', '--format',
        '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'], { encoding: 'utf8' });
      const lines = (out.stdout || '').trim().split('\n')
        .filter((l) => /fleet-flexprice|flexprice/.test(l));
      const parseMiB = (usage) => {
        const m = /([\d.]+)\s*(GiB|MiB|KiB)/.exec(usage);
        if (!m) return 0;
        const v = Number(m[1]);
        return m[2] === 'GiB' ? v * 1024 : m[2] === 'KiB' ? v / 1024 : v;
      };
      const rows = lines.map((l) => {
        const [name, mem, cpu] = l.split('\t');
        return { name, mem, cpu, mib: Math.round(parseMiB(mem)) };
      });
      const total = rows.reduce((a, r) => a + r.mib, 0);
      const vm = spawnSync('docker', ['run', '--rm', 'alpine', 'free', '-m'], { encoding: 'utf8' });
      const freeLine = (vm.stdout || '').split('\n').find((l) => l.startsWith('Mem:')) || '';
      return verdict('resource-footprint', '13', total > 0 && total < 6000,
        { containers: rows, total_mib: total, total_gib: (total / 1024).toFixed(2),
          docker_vm_mem_line: freeLine.replace(/\s+/g, ' ').trim() },
        total > 4500
          ? `~${(total / 1024).toFixed(1)} GiB for FlexPrice alone: it does not fit alongside kind in an 8 GiB Docker VM. Either raise Docker memory for the spike or run the metrics stack down first — this is the item-13 answer the plan asked for.`
          : `fits with ~${((4300 - total) / 1024).toFixed(1)} GiB of the currently-available headroom to spare`,
      );
    },
  },
];

// --------------------------------------------------------------------- main

(async function main() {
  console.log(`flexprice spike -> ${BASE}  run=${RUN}`);
  const probeList = only ? PROBES.filter((p) => only.includes(p.name)) : PROBES;
  if (only && probeList.length === 0) {
    console.error(`--only matched nothing. probes: ${PROBES.map((p) => p.name).join(', ')}`);
    process.exit(2);
  }
  for (const p of probeList) {
    try {
      await p.run();
    } catch (e) {
      verdict(p.name, p.item, false, `probe threw: ${e.message}`, 'fix the probe or the assumption it tests');
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ run: RUN, base: BASE, results }, null, 2));
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n${results.length} probes, ${failed} failing verdicts -> ${path.relative(ROOT, OUT_FILE)}`);
  console.log('fold these into docs/FLEXPRICE_FINDINGS.md §9 by hand; the doc grades each claim by evidence and a script cannot do that.');
  process.exitCode = failed ? 1 : 0;
})();
