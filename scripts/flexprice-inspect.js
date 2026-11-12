#!/usr/bin/env node
// Read-back for the Phase 0 / Phase 1 FlexPrice stack, for people reviewing without
// a dashboard (the plan's A1 has none on purpose).
//
// It prints whatever the API returned, verbatim. That is not laziness: FlexPrice
// marshals money as shopspring/decimal quoted strings ("500.5"), so any re-format
// through a JS number would round exactly the thing under review. If a value looks
// like a string here, that is the wire, not this tool.
//
// It reads the API key out of deploy/flexprice/.env and never prints the key, the
// .env, or any header. Give it a command; it gives you JSON.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// One level up: this file is scripts/flexprice-inspect.js, not in a subdirectory.
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'deploy', 'flexprice', '.env');
const BASE = process.env.FLEXPRICE_URL || 'http://127.0.0.1:18080';

function envValue(key) {
  if (process.env[key]) return process.env[key];
  if (!fs.existsSync(ENV_FILE)) return null;
  const line = fs.readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : null;
}

const API_KEY = envValue('FLEXPRICE_API_KEY');
// Same default as the bootstrap and the spike: the seeded Production environment
// from migrations/postgres/V1__seed.sql. Not optional — every data route answers
// 403 {"message":"Invalid or inaccessible environment"} without it. Sandbox is the
// …000 id; both are seeded, which is what makes hardcoding them safe.
const SANDBOX_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000000';
const PRODUCTION_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';

function environmentId() {
  const raw = envValue('FLEXPRICE_ENVIRONMENT_ID') || 'production';
  if (raw === 'sandbox') return SANDBOX_ENVIRONMENT_ID;
  if (raw === 'production') return PRODUCTION_ENVIRONMENT_ID;
  return raw;
}

function flag(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function call(method, p, body) {
  const headers = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };
  headers['X-Environment-ID'] = environmentId();
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a non-JSON body is itself the answer */ }
  return { status: res.status, parsed, text };
}

function show(res) {
  if (res.parsed !== null) console.log(JSON.stringify(res.parsed, null, 2));
  else console.log(`${res.status} (not JSON)\n${res.text.slice(0, 2000)}`);
  if (res.status >= 400) process.exitCode = 1;
}

const now = () => Math.floor(Date.now() / 1000);
const iso = (epochSec) => new Date(epochSec * 1000).toISOString();

const COMMANDS = {
  health: () => call('GET', '/health'),
  environments: () => call('GET', '/v1/environments'),
  meters: () => call('GET', '/v1/meters'),
  customers: () => call('GET', '/v1/customers'),
  customer: (arg) => call('GET', `/v1/customers/${encodeURIComponent(arg)}`),
  wallet: (arg) => call('GET', `/v1/wallets/${encodeURIComponent(arg)}`),
  balance: (arg) => call('GET', `/v1/wallets/${encodeURIComponent(arg)}/balance/real-time`),
  balance_cached: (arg) => call('GET', `/v1/wallets/${encodeURIComponent(arg)}/balance/cached`),
  // The metered quantity as FlexPrice computed it — the number the invoice should
  // match. Window defaults to the last 24h because a period that does not contain
  // the events reads as "0 usage", which looks like a billing bug and is not one.
  //
  // Two routes, because they bind different DTOs (measured; findings §7c):
  //   --meter  -> /v1/events/usage/meter   meter_id; has NO group_by and NO filters
  //   --event  -> /v1/events/usage         event_name + aggregation_type are required
  //    and `filters` keyed on the BARE property name is the only working per-dimension
  //    read. `group_by` is silently ignored on a SUM meter, and a `meter_id` sent to
  //    this route is dropped by the binder (`json:"-"`) — both read as "no usage".
  usage: () => {
    const window = {
      external_customer_id: flag('customer'),
      start_time: iso(now() - Number(flag('hours', 24)) * 3600),
      end_time: iso(now() + 60),
    };
    if (flag('meter')) {
      return call('POST', '/v1/events/usage/meter', { meter_id: flag('meter'), ...window });
    }
    if (!flag('event')) {
      throw new Error('usage needs --meter <wallet_…/meter id> or --event <event_name> '
        + '(a meter_id sent to /v1/events/usage is ignored by the API)');
    }
    let filters;
    if (flag('filter')) {
      const [key, values] = String(flag('filter')).split(':');
      if (!values) throw new Error(`--filter wants name:v1,v2 (got "${flag('filter')}")`);
      filters = { [key]: values.split(',') };
    }
    return call('POST', '/v1/events/usage', {
      event_name: flag('event'),
      aggregation_type: String(flag('agg', 'SUM')).toUpperCase(),
      ...window,
      ...(filters ? { filters } : {}),
    });
  },
};

// `balance-cached` is spelled with a dash on the command line, with an underscore
// in the table, because JS identifier rules and CLI ergonomics disagree.
COMMANDS['balance-cached'] = COMMANDS.balance_cached;

const HELP = `usage: npm run billing:flexprice:inspect -- <command> [id] [flags]

  health                          api /health
  environments                    the two seeded environments (ids are not secret)
  meters | customers              lists
  customer <id>                   one customer (accepts cust_... id)
  wallet <id>                     wallet row: balance, currency, config
  balance <id>                    real-time balance (what the gate would read)
  balance-cached <id>             cached projection (what a stale read looks like)
  usage --meter <id> --customer <externalId> [--hours N] [--group-by a,b]

  FLEXPRICE_ENVIRONMENT_ID=sandbox|production|<uuid> selects the environment
  (default production); FLEXPRICE_URL overrides the base URL.`;

(async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '-h' || cmd === '--help' || !COMMANDS[cmd]) {
    console.error(cmd ? `unknown command: ${cmd}\n` : '');
    console.error(HELP);
    process.exitCode = cmd && cmd !== '-h' && cmd !== '--help' ? 2 : 0;
    return;
  }
  if (!API_KEY) {
    console.error('no FLEXPRICE_API_KEY — run npm run billing:flexprice:bootstrap first');
    process.exitCode = 2;
    return;
  }
  show(await COMMANDS[cmd](process.argv[3]));
})().catch((e) => {
  console.error(`inspect failed: ${e.message}`);
  process.exitCode = 1;
});
