#!/usr/bin/env node
// Read-back for the Phase 0 / Phase 1 FlexPrice stack, for people reviewing without
// a dashboard (the plan's A1 has none on purpose).
//
// It prints whatever the API returned, verbatim. That is not laziness: FlexPrice
// marshals money as shopspring/decimal quoted strings ("500.5"), so any re-format
// through a JS number would round exactly the thing under review. If a value looks
// like a string here, that is the wire, not this tool.
//
// The transport is the SDK, like everything else since the migration: each command
// rides either the client's raw seam (which returns the response body as parsed
// JSON, unmodelled, so the verbatim promise above still holds) or the façade method
// the product itself would call. No URL and no header is built here, so the
// environment id and the plane key are config the tool cannot get wrong, and a
// usage read cannot leave without its `external_customer_id`.
//
// It reads the plane keys out of deploy/flexprice/.env and never prints a key, the
// .env, or any header. Give it a command; it gives you JSON.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createFlexpriceClient } = require('../packages/shared-core/src/billing/flexprice-client');

// One level up: this file is scripts/flexprice-inspect.js, not in a subdirectory.
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'deploy', 'flexprice', '.env');

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
const pick = (key) => process.env[key] || stackEnv[key] || '';
const moneyKey = pick('FLEXPRICE_API_KEY_MONEY');
const ingestKey = pick('FLEXPRICE_API_KEY_INGEST');
// The stack's own base URL lives in deploy/flexprice/.env (the kind install is
// reached through the ingress host, not the 18080 default), so the file is a
// first-class source here — otherwise every command silently targets a port
// nothing listens on and reads as an outage.
const baseUrl = (pick('FLEXPRICE_BASE_URL') || 'http://127.0.0.1:18080').replace(/\/+$/, '');

// Same default as the bootstrap and the spike: the seeded Production environment
// from migrations/postgres/V1__seed.sql. Not optional — every data route answers
// 403 {"message":"Invalid or inaccessible environment"} without it. Sandbox is the
// …000 id; both are seeded, which is what makes hardcoding them safe.
const SANDBOX_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000000';
const PRODUCTION_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';

function environmentId() {
  const raw = pick('FLEXPRICE_ENVIRONMENT_ID') || 'production';
  if (raw === 'sandbox') return SANDBOX_ENVIRONMENT_ID;
  if (raw === 'production') return PRODUCTION_ENVIRONMENT_ID;
  return raw;
}

const config = {
  baseUrl,
  environmentId: environmentId(),
  timeoutMs: 15000,
  keys: { money: moneyKey, ingest: ingestKey },
};
const client = createFlexpriceClient({ config });

// Routes the façade does not model — they are read-only and operator-facing, so
// they take the transport's raw seam and print the body exactly as it arrived.
const wire = (method, route, body) => client.request({
  plane: 'money',
  method,
  route: `/v1/${route.split('/').map(encodeURIComponent).join('/')}`,
  ...(body === undefined ? {} : { body }),
});

function flag(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const now = () => Math.floor(Date.now() / 1000);
const iso = (epochSec) => new Date(epochSec * 1000).toISOString();

const need = (arg, what) => {
  if (!arg) throw new Error(`${what} is required (see --help)`);
  return String(arg);
};

/** `/v1/wallets/<id>/…`: the caller-supplied id is one encoded path segment. */
const walletPath = (id, suffix = '') => `wallets/${need(id, 'a wallet id')}${suffix}`;

const COMMANDS = {
  health: () => client.getHealth(),
  environments: () => client.listEnvironments(),
  meters: () => client.listMeters(),
  customers: () => wire('GET', 'customers'),
  customer: (arg) => wire('GET', `customers/${need(arg, 'a customer id')}`),
  wallet: (arg) => wire('GET', walletPath(arg)),
  balance: (arg) => wire('GET', walletPath(arg, '/balance/real-time')),
  ledger: (arg) => client.walletTransactionsSearch({
    walletId: need(arg, 'a wallet id'),
    ...(flag('type') ? { type: String(flag('type')).toUpperCase() } : {}),
    limit: Number(flag('limit', 20)),
  }),
  // The metered quantity as FlexPrice computed it — the number the invoice should
  // match. Window defaults to the last 24h because a period that does not contain
  // the events reads as "0 usage", which looks like a billing bug and is not one.
  //
  // Two routes, because they bind different DTOs (measured; findings §7c):
  //   --meter  -> eventsUsageMeter   meter_id; has NO group_by and NO filters
  //   --event  -> eventsUsage        event_name + aggregation_type are required
  //    and `filters` keyed on the BARE property name is the only working per-dimension
  //    read. `group_by` is silently ignored on a SUM meter, and a `meter_id` sent to
  //    this route is dropped by the binder (`json:"-"`) — both read as "no usage".
  //
  // These are the façade methods rather than the raw seam, so what is printed is
  // what the Usage page asks for — and so the client's scope rule applies to a
  // hand-run read too: no `external_customer_id`, no request.
  usage: () => {
    const window = {
      externalCustomerId: flag('customer'),
      startTime: iso(now() - Number(flag('hours', 24)) * 3600),
      endTime: iso(now() + 60),
    };
    if (flag('meter')) {
      return client.eventsUsageMeter({ meterId: flag('meter'), ...window });
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
    return client.eventsUsage({
      eventName: flag('event'),
      aggregationType: String(flag('agg', 'SUM')).toUpperCase(),
      ...window,
      ...(filters ? { filters } : {}),
    });
  },
};

const HELP = `usage: npm run billing:flexprice:inspect -- <command> [id] [flags]

  health                          api /health
  environments                    the two seeded environments (ids are not secret)
  meters | customers              lists
  customer <id>                   one customer (accepts cust_... id)
  wallet <id>                     wallet row: balance, currency, config
  balance <id>                    real-time balance (what the gate would read)
  ledger <walletId> [--type credit|debit] [--limit N]
  usage --meter <id> --customer <externalId> [--hours N]
  usage --event <name> --agg SUM|COUNT --customer <externalId> [--filter prop:v1,v2]

  FLEXPRICE_ENVIRONMENT_ID=sandbox|production|<uuid> selects the environment
  (default production); FLEXPRICE_BASE_URL overrides the base URL.`;

function show(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

(async function main() {
  const cmd = process.argv[2];
  const help = !cmd || cmd === '-h' || cmd === '--help';
  if (help || !COMMANDS[cmd]) {
    if (!help) console.error(`unknown command: ${cmd}\n`);
    console.error(HELP);
    process.exitCode = help ? 0 : 2;
    return;
  }
  if (!moneyKey || (cmd === 'usage' && !ingestKey)) {
    console.error(`no ${cmd === 'usage' ? 'FLEXPRICE_API_KEY_INGEST' : 'FLEXPRICE_API_KEY_MONEY'} `
      + '— run npm run billing:flexprice:provision first');
    process.exitCode = 2;
    return;
  }
  try {
    show(await COMMANDS[cmd](process.argv[3]));
  } catch (err) {
    // An upstream 4xx/5xx is still an answer: print the status and the body the
    // service sent, then fail, so a reviewer sees "403 Invalid or inaccessible
    // environment" rather than a stack trace.
    if (typeof err.status === 'number') {
      console.log(`${err.status} ${err.code || ''}`.trim());
      show(err.body === undefined ? err.message : err.body);
    } else {
      console.error(`inspect failed: ${err.message}`);
    }
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error(`inspect failed: ${e.message}`);
  process.exitCode = 1;
});
