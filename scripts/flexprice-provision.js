#!/usr/bin/env node
// Phase 1 FlexPrice provisioning: two plane keys, the meter catalog, the price
// catalog, and (per org) customer + wallet + opening credit.
//
// Idempotent by lookup rather than by try-and-ignore: every step reads what
// exists first and reports created-vs-existing, because a provisioning run that
// prints "ok" for a 409 cannot tell an operator whether the resource it thinks
// it made is the one the stack is using.
//
// It never prints a secret. The two minted keys go into deploy/flexprice/.env
// (gitignored), the same place the bootstrap script puts the admin key.
//
//   node scripts/flexprice-provision.js --dry-run
//   node scripts/flexprice-provision.js --org acme --org-name "Acme Analytics" --state 27
//   node scripts/flexprice-provision.js --org acme --free-credit   # opening credit for a non-free-tier org
//   node scripts/flexprice-provision.js --rotate-keys   # revoke and re-mint both planes
//   FLEET_ORG_ID=acme node scripts/flexprice-provision.js
//
// Order matters. Keys are minted with the admin key, so that step precedes the
// catalog, and the catalog precedes any wallet: a recharge can only be quoted
// against a customer that has an address (place of supply) and a wallet whose
// conversion_rate defines what a credit means.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createFlexpriceClient } = require('../packages/shared-core/src/billing/flexprice-client');
const { DEFAULT_BASE_URL } = require('../packages/shared-core/src/billing/flexprice-config');
const { PRICE_PER_MTOK_USD } = require('../packages/shared-core/src/billing/pricing');
const { decimalFromPaise, paiseFromDecimal, roundDiv } = require('../packages/shared-core/src/billing/money-wire');
const CONFIG = require('../packages/shared-core/src/config').CONFIG;
// Reused rather than re-implemented: this is the org service's internal
// billing-context read, with its token and IAM-bearer handling already settled,
// and the same one the auto-recharge job trusts before it charges anyone.
const { fetchBillingContext } = require('../services/billing/src/auto-recharge-job');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'deploy', 'flexprice', '.env');

// The seeded Production environment (migrations/postgres/V1__seed.sql). Same
// constant the bootstrap and the spike use; it is seeded, not chosen.
const SEED_ENVIRONMENT_ID = '00000000-0000-0000-0000-000000000001';

const CURRENCY = 'INR';
const CATALOG_PLAN = 'fleet-catalog';

// `amount` is rupees per unit, and for these lines a unit is ₹1 of taxable value,
// so the amount is the rate: 9% is ₹0.09, i.e. 9 paise. A FIXED price of ₹45
// would be right for exactly one recharge size, and tax is not a size.
// `quantity` on the invoice line carries the taxable rupees.
const CATALOG_FLAT_PRICES = [
  { lookup_key: 'recharge-principal', display_name: 'Recharge value', unit_amount_paise: 100, rate_bps: null },
  { lookup_key: 'gst-cgst-9', display_name: 'CGST @ 9%', unit_amount_paise: 9, rate_bps: 900 },
  { lookup_key: 'gst-sgst-9', display_name: 'SGST @ 9%', unit_amount_paise: 9, rate_bps: 900 },
  { lookup_key: 'gst-igst-18', display_name: 'IGST @ 18%', unit_amount_paise: 18, rate_bps: 1800 },
];

const METERS = [
  { name: 'llm-cost', event_name: 'fleet.llm_cost', field: 'cost_paise' },
  { name: 'actor-compute', event_name: 'fleet.actor_compute', field: 'duration_seconds' },
  // Created and deliberately never emitted (decision D8): there is no
  // deployment-duration source yet, and inventing a quantity is worse than
  // showing an inert meter.
  { name: 'deployment-minutes', event_name: 'fleet.deployment_minutes', field: 'minutes' },
];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (flagName, fallback = '') => {
  const inline = args.find((a) => a.startsWith(`--${flagName}=`));
  if (inline) return inline.slice(flagName.length + 3);
  const i = args.indexOf(`--${flagName}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const all = (flagName) => args.reduce((out, a, i) => (a === `--${flagName}` && args[i + 1] ? out.concat(args[i + 1]) : out), []);

const DRY = has('--dry-run');
const QUIET_JSON = has('--json');
// Explicit operator grant for an org the org service does not report as a
// default (free-tier) organization — a promotion, a pilot, a support goodwill
// credit. It exists so the free credit is a decision someone made, in the
// command line, rather than a side effect of a name.
const FREE_CREDIT_OVERRIDE = has('--free-credit');
// After `npm run billing:flexprice:down` the database is new but the .env is not:
// the stored plane keys authenticate as service accounts that no longer exist,
// and a key that only ever 401s is worse than a missing one because every later
// step looks like a permissions bug. `--rotate-keys` discards the stored values
// and mints fresh ones.
const ROTATE_KEYS = has('--rotate-keys');

function readEnvFile() {
  const out = {};
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Write/replace one KEY=value line in the stack's .env without touching the rest. */
function upsertEnvFile(updates) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const remaining = { ...updates };
  const next = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line.trim());
    if (m && remaining[m[1]] !== undefined) {
      const value = remaining[m[1]];
      delete remaining[m[1]];
      return `${m[1]}=${value}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(remaining)) next.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, `${next.join('\n').replace(/\n*$/, '')}\n`, { mode: 0o600 });
}

const rows = [];
function report(kind, name, outcome, detail = '') {
  rows.push({ kind, name, outcome, detail });
  if (!QUIET_JSON) console.log(`  ${outcome.padEnd(9)} ${kind.padEnd(9)} ${name}${detail ? `  (${detail})` : ''}`);
}
function section(title) {
  if (!QUIET_JSON) console.log(`\n== ${title}`);
}

/**
 * The two plane keys, minted as service accounts.
 *
 * `AllowedRoles()` for a service account is super_admin | all_reader |
 * event_ingestor | event_reader — there is no writer role for a machine
 * principal, so the money plane takes super_admin. That is less frightening
 * than it reads: `IsSuperAdminUser()` returns false for any service account, so
 * a leaked money key can move wallet balances but cannot mint or enumerate
 * credentials. The ingest plane gets the narrow role, which the Phase 0 spike
 * measured as refusing meter creation while accepting events.
 */
async function ensureKeys(admin) {
  const wanted = [
    { env: 'FLEXPRICE_API_KEY_INGEST', name: 'fleet ingest plane', role: 'event_ingestor' },
    { env: 'FLEXPRICE_API_KEY_MONEY', name: 'fleet money plane', role: 'super_admin' },
  ];
  if (ROTATE_KEYS && !DRY) {
    upsertEnvFile(Object.fromEntries(wanted.map((spec) => [spec.env, ''])));
    report('key', '(both planes)', 'rotated', 'discarded the stored values before minting');
  }
  const existing = ROTATE_KEYS ? {} : readEnvFile();
  const found = await admin.request({ plane: 'money', method: 'POST', route: '/v1/users/search', body: { limit: 200 } });
  const users = found.items || [];
  const keys = await admin.request({ plane: 'money', method: 'GET', route: '/v1/secrets/api/keys?limit=200' });
  const written = {};

  for (const spec of wanted) {
    if (existing[spec.env]) {
      report('key', spec.env, 'existing', 'already in deploy/flexprice/.env');
      continue;
    }
    let account = users.find((u) => u.name === spec.name && u.type === 'service_account');
    if (!account) {
      if (DRY) {
        report('user', spec.name, 'dry-run', `service_account roles=[${spec.role}]`);
        continue;
      }
      account = await admin.request({
        plane: 'money', method: 'POST', route: '/v1/users',
        body: { name: spec.name, type: 'service_account', roles: [spec.role] },
      });
      report('user', spec.name, 'created', spec.role);
    } else {
      report('user', spec.name, 'existing', spec.role);
    }
    const live = (keys.items || []).find((k) => k.name === `${spec.name} key`);
    if (live && ROTATE_KEYS) {
      // Revoking first is what makes `--rotate-keys` a rotation and not a second
      // live key: two credentials for one plane means the one nobody is using
      // still authenticates.
      await admin.request({ plane: 'money', method: 'DELETE', route: `/v1/secrets/api/keys/${encodeURIComponent(live.id)}` });
      report('key', live.name || live.id, 'rotated', 'previous key revoked');
    } else if (live) {
      // Their display_id is masked (`sk_01***G3`) and the raw secret is returned
      // exactly once, at mint. A key that exists but whose value was lost is an
      // operator problem, not something this script can recover by re-minting:
      // two live keys for one plane is how a rotation silently fails.
      report('key', spec.env, 'failed', `minted key "${spec.name} key" exists but its value is not in .env; rerun with --rotate-keys to revoke and re-mint`);
      continue;
    }
    if (DRY) {
      report('key', spec.env, 'dry-run', `private_key for ${account.id}`);
      continue;
    }
    const minted = await admin.request({
      plane: 'money', method: 'POST', route: '/v1/secrets/api/keys',
      body: { name: `${spec.name} key`, type: 'private_key', service_account_id: account.id },
    });
    if (!minted.api_key) {
      report('key', spec.env, 'failed', 'no api_key in response');
      continue;
    }
    written[spec.env] = minted.api_key;
    report('key', spec.env, 'created', minted.secret?.display_id || 'minted');
  }

  if (!DRY && Object.keys(written).length) upsertEnvFile(written);
  return written;
}

/**
 * Live meters, excluding archived ones.
 *
 * DELETE /v1/meters/:id is an archive: the row keeps `status:"archived"`, still
 * comes back in GET /v1/meters, and still resolves by id. An idempotency check
 * that matches on event_name alone would call that meter present, ingest against
 * it, and get the measured silent-zero — 202 accepted, nothing aggregated.
 */
async function liveMeters(client) {
  const res = await client.request({ plane: 'money', method: 'GET', route: '/v1/meters' });
  return (res.items || []).filter((m) => !m.status || m.status === 'published');
}

async function ensureMeters(client) {
  const existing = await liveMeters(client);
  const byEvent = new Map(existing.map((m) => [m.event_name, m]));
  const out = {};
  for (const meter of METERS) {
    const hit = byEvent.get(meter.event_name);
    if (hit) {
      out[meter.name] = hit.id;
      report('meter', `${meter.name} (${meter.event_name})`, 'existing', hit.id);
      continue;
    }
    if (DRY) {
      report('meter', `${meter.name} (${meter.event_name})`, 'dry-run', `SUM ${meter.field}`);
      continue;
    }
    const created = await client.createMeter({
      name: meter.name,
      event_name: meter.event_name,
      // `field` names a key inside event.properties. Omitting it on a SUM meter
      // is a 400 ("Please specify a field or expression"), and a misspelled one
      // is not: the meter is created and aggregates nothing.
      aggregation: { type: 'SUM', field: meter.field },
      reset_usage: 'DAILY',
    });
    out[meter.name] = created.id;
    report('meter', `${meter.name} (${meter.event_name})`, 'created', created.id);
  }
  return out;
}

async function ensurePlan(client) {
  const res = await client.request({ plane: 'money', method: 'GET', route: '/v1/plans' });
  const hit = (res.items || []).find((p) => p.name === CATALOG_PLAN);
  if (hit) {
    report('plan', CATALOG_PLAN, 'existing', hit.id);
    return hit.id;
  }
  if (DRY) {
    report('plan', CATALOG_PLAN, 'dry-run', 'holds the GST and rate-card prices');
    return 'DRY';
  }
  const created = await client.request({ plane: 'money', method: 'POST', route: '/v1/plans', body: { name: CATALOG_PLAN, description: 'AI Fleet rate card and GST lines' } });
  report('plan', CATALOG_PLAN, 'created', created.id);
  return created.id;
}

/**
 * Prices hang off an entity: `entity_type:"PRICE"` is refused as unsupported and
 * `"SUBSCRIPTION"` needs an existing subscription, so the catalog hangs off a
 * plan and every lookup_key below is unique within the environment.
 */
async function ensurePrice(client, planId, spec) {
  try {
    const hit = await client.request({ plane: 'money', method: 'GET', route: `/v1/prices/lookup/${encodeURIComponent(spec.lookup_key)}` });
    if (hit && hit.id) {
      // Converge rather than skip. A price that exists with the wrong amount is
      // the failure this catches: the first run of this script minted CGST at
      // ₹9.00 per rupee instead of ₹0.09, and a check that only matched on
      // lookup_key would have reported "existing" forever and billed 100x tax.
      const stored = paiseFromDecimal(String(hit.amount ?? '0'));
      const want = paiseFromDecimal(spec.amount);
      if (stored !== want) {
        if (DRY) {
          report('price', spec.lookup_key, 'dry-run', `amount ${hit.amount} -> ${spec.amount}`);
          return hit.id;
        }
        await client.request({ plane: 'money', method: 'PUT', route: `/v1/prices/${encodeURIComponent(hit.id)}`, body: { amount: spec.amount } });
        report('price', spec.lookup_key, 'updated', `${hit.amount} -> ${spec.amount} (${hit.id})`);
      } else {
        report('price', spec.lookup_key, 'existing', hit.id);
      }
      return hit.id;
    }
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (DRY) {
    report('price', spec.lookup_key, 'dry-run', `amount ${spec.amount}`);
    return 'DRY';
  }
  const created = await client.createPrice({
    ...spec,
    entity_type: 'PLAN',
    entity_id: planId,
    currency: CURRENCY,
    billing_period_count: 1,
    // USAGE prices must be ARREAR or the create is refused 400; FIXED catalog
    // lines carry ADVANCE, which is what a prepaid recharge statement wants.
    invoice_cadence: spec.type === 'USAGE' ? 'ARREAR' : 'ADVANCE',
  });
  report('price', spec.lookup_key, 'created', created.id);
  return created.id;
}

async function ensurePrices(client, planId, meterIds) {
  const ids = {};
  for (const flat of CATALOG_FLAT_PRICES) {
    ids[flat.lookup_key] = await ensurePrice(client, planId, {
      lookup_key: flat.lookup_key,
      display_name: flat.display_name,
      type: 'FIXED',
      price_unit_type: 'FIAT',
      billing_model: 'FLAT_FEE',
      billing_period: 'ONETIME',
      amount: decimalFromPaise(flat.unit_amount_paise),
      metadata: {
        fleet_gst: flat.rate_bps ? 'true' : 'false',
        ...(flat.rate_bps ? { gst_rate_bps: String(flat.rate_bps) } : {}),
        // Written on the price so whoever reads the catalog in the FlexPrice UI
        // knows what the quantity column is supposed to mean.
        fleet_quantity: 'taxable rupees',
        fleet_unit: 'rupees per rupee of taxable value',
      },
    });
  }

  // One usage price per meter, so every meter is billable in principle. Per-unit
  // pricing on a SUM meter is PACKAGE + transform_quantity{divide_by:1}: bare
  // FLAT_FEE charges once per window regardless of quantity, and PER_UNIT is not
  // in the allowed list for a SUM aggregation (measured 400).
  const meterPrice = {
    'llm-cost': { unit_paise: 1, note: 'quantity is cost_paise, so 1 paise per unit is exact' },
    'actor-compute': { unit_paise: 0, note: 'D4: actor compute is metered and priced at zero for now' },
    'deployment-minutes': { unit_paise: 0, note: 'D8: no emitter; price exists so the meter is not orphaned' },
  };
  for (const meter of METERS) {
    const spec = meterPrice[meter.name];
    ids[`meter:${meter.name}`] = await ensurePrice(client, planId, {
      lookup_key: `meter-${meter.name}`,
      display_name: `AI Fleet ${meter.name}`,
      type: 'USAGE',
      meter_id: meterIds[meter.name],
      price_unit_type: 'FIAT',
      billing_model: 'PACKAGE',
      transform_quantity: { divide_by: 1, round: 'down' },
      billing_period: 'MONTHLY',
      amount: decimalFromPaise(spec.unit_paise),
      metadata: { fleet_meter: meter.name, fleet_meter_id: String(meterIds[meter.name] || ''), fleet_note: spec.note },
    });
  }

  // Rate card. This is a RECORD, not the money path: Node's pricing.js converts
  // tokens to paise and the wallet is debited from that (D9), because grouping
  // and property filters on a SUM meter are measured to be ignored, so a
  // per-model price could not be evaluated by FlexPrice even if it existed.
  const fx = CONFIG.BILLING.usdToInr;
  for (const [provider, rates] of Object.entries(PRICE_PER_MTOK_USD)) {
    for (const direction of ['input', 'output']) {
      const usd = rates[direction];
      // Exact, and it has to be: this is the one multiplication USD_TO_INR still
      // performs now that it has left the runtime path (D9), and 1.25 * 87 * 100
      // is 10875.000000000002 in binary floats. The rate is scaled to 2 decimals
      // as an integer, then the paise product is divided back on the digits.
      const fxHundredths = BigInt(Math.round(fx * 100));
      const inrPaise = Number(roundDiv(BigInt(paiseFromDecimal(String(usd))) * fxHundredths, 100n));
      ids[`rate:${provider}:${direction}`] = await ensurePrice(client, planId, {
        lookup_key: `rate-${provider}-${direction}`,
        display_name: `${provider} ${direction} (per 1M tokens)`,
        type: 'FIXED',
        price_unit_type: 'FIAT',
        billing_model: 'FLAT_FEE',
        billing_period: 'ONETIME',
        amount: decimalFromPaise(inrPaise),
        metadata: {
          fleet_rate_card: 'true',
          provider,
          direction,
          usd_per_mtok: String(usd),
          fx_usd_inr: String(fx),
          // Dated because the number stops being true the day the rate moves, and
          // an undated FX figure in a billing catalog is an audit question later.
          fx_captured_on: new Date().toISOString().slice(0, 10),
        },
      });
    }
  }
  return ids;
}

/**
 * Is this org the free tier? The answer is the org service's `is_default` flag,
 * which onboarding writes and no request body can. Name and tag equality are
 * not acceptable inputs here: `PUT /orgs/current` edits the name and the tag
 * editor edits the tag, so either one would let a paying org claim ₹500 of free
 * credit — or a free org make itself unchargeable by renaming away from
 * "default".
 *
 * `isDefault: null` means no answer (org service not configured, the id is not a
 * tenant UUID, or the call failed). Callers must treat that as *not* proven,
 * which is why the free credit then needs `--free-credit`.
 */
async function freeTierStatus(orgId) {
  let context;
  try {
    context = await fetchBillingContext(orgId, { baseUrl: val('org-url', '') || undefined });
  } catch (err) {
    return { isDefault: null, why: err.message };
  }
  if (context === null) return { isDefault: null, why: 'the org service has no such organization' };
  return { isDefault: context.is_default === true };
}

/**
 * The opening-credit decision, in one place so the dry run and the real run
 * cannot disagree about it. Free money needs a reason: either the org service
 * says this is the onboarding free tier, or an operator said `--free-credit`.
 */
function openingCreditDecision(tier, opening, already) {
  if (opening <= 0) return { grant: false, why: `opening credit is ${opening}` };
  if (already > 0) return { grant: false, why: `balance ${already}, opening ${opening}` };
  if (tier.isDefault === true || FREE_CREDIT_OVERRIDE) {
    return { grant: true, why: `${opening} credits${FREE_CREDIT_OVERRIDE && tier.isDefault !== true ? ' by --free-credit' : ''}` };
  }
  return {
    grant: false,
    why: tier.isDefault === false
      ? 'not a default (free-tier) org per the org service; pass --free-credit to grant it as a deliberate exception'
      : `free tier unverified (${tier.why}); pass --free-credit to grant it without the org service`,
  };
}

async function ensureOrg(client, orgId, opts) {
  const name = opts.name || orgId;
  const opening = Number(opts.initialCredits) || 0;
  // Asked before anything is written, and itself read-only: a dry run has to
  // show the same free-tier verdict the real run will act on.
  const tier = opening > 0 ? await freeTierStatus(orgId) : { isDefault: null, why: 'opening credit is 0' };
  let customer = null;
  try {
    customer = await client.getCustomerByExternalId(orgId);
    report('customer', orgId, 'existing', customer.id);
  } catch (err) {
    if (err.status !== 404) throw err;
    if (DRY) {
      report('customer', orgId, 'dry-run', `${opts.city}, ${opts.state}`);
      const decision = openingCreditDecision(tier, opening, 0);
      report('credit', orgId, 'dry-run', decision.grant ? `would ${decision.why.toLowerCase()}` : decision.why);
      return { orgId, walletId: 'DRY' };
    }
    // Flat `address_*` names. The nested `billing_address` object is accepted at
    // 201 and silently drops every field, and place of supply is read from this
    // address, so a dropped state means the wrong tax split on every invoice.
    customer = await client.createCustomer({
      external_id: orgId,
      name,
      address_line1: opts.line1,
      address_city: opts.city,
      address_state: opts.stateName,
      address_postal_code: opts.postal,
      address_country: 'IN',
    });
    if (customer.address_country !== 'IN') {
      throw new Error(`customer ${orgId}: address did not round-trip (${JSON.stringify(customer).slice(0, 160)})`);
    }
    report('customer', orgId, 'created', customer.id);
  }

  const wallets = await client.listWalletsByCustomer(customer.id);
  // The wallets route reports `currency` lower-case ('inr'), so an exact match on
  // 'INR' would re-create a wallet on every run and report the 409 as a new id.
  let wallet = (wallets.items || []).find(
    (w) => String(w.currency || '').toUpperCase() === CURRENCY && (w.wallet_type || '').toUpperCase() === 'PRE_PAID',
  );
  if (!wallet) {
    if (DRY) {
      report('wallet', orgId, 'dry-run', 'INR PRE_PAID conversion_rate 1');
      const decision = openingCreditDecision(tier, opening, 0);
      report('credit', orgId, 'dry-run', decision.grant ? `would ${decision.why.toLowerCase()}` : decision.why);
      return { orgId, walletId: 'DRY' };
    }
    wallet = await client.createWallet({
      external_customer_id: orgId,
      currency: CURRENCY,
      wallet_type: 'PRE_PAID',
      name: `${name} wallet`,
      // Measured, from TopUpWalletRequest: amount = credits_to_add *
      // conversion_rate. At 1, one credit is one rupee (decision D6), which is
      // what money-wire's PAISE_PER_CREDIT assumes.
      conversion_rate: '1',
      alert_settings: {
        alert_enabled: true,
        // Conditions are lower-case (`above`|`below`); 'BELOW' is refused 400.
        critical: { threshold: '100', condition: 'below' },
        warning: { threshold: '500', condition: 'below' },
        info: { threshold: '1000', condition: 'below' },
      },
    });
    report('wallet', orgId, 'created', wallet.id);
  } else {
    report('wallet', orgId, 'existing', wallet.id);
  }

  const balance = await client.walletRealTimeBalance(wallet.id);
  const already = Number(balance.real_time_credit_balance || 0);
  const decision = openingCreditDecision(tier, opening, already);
  if (!decision.grant) {
    report('credit', orgId, 'skipped', decision.why);
  } else {
    // FREE_CREDIT_GRANT, never bonus_credits_to_add: a PURCHASED_CREDIT_BONUS row
    // poisons credits_available_breakdown while returning 200.
    const grant = await client.grantPromo(wallet.id, {
      credits: opening,
      idempotencyKey: `initial-credit:${orgId}`,
      description: FREE_CREDIT_OVERRIDE && tier.isDefault !== true
        ? 'AI Fleet opening credit (operator --free-credit)'
        : 'AI Fleet opening credit',
    });
    report('credit', orgId, grant.alreadyExists ? 'existing' : 'created', `${opening} credits`);
  }
  return { orgId, walletId: wallet.id, customerId: customer.id };
}

async function main() {
  const stackEnv = readEnvFile();
  const adminKey = process.env.FLEXPRICE_API_KEY || stackEnv.FLEXPRICE_API_KEY || '';
  if (!adminKey) {
    throw new Error('no FLEXPRICE_API_KEY in the environment or deploy/flexprice/.env — run npm run billing:flexprice:bootstrap first');
  }
  const baseUrl = (process.env.FLEXPRICE_BASE_URL || stackEnv.FLEXPRICE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const environmentId = process.env.FLEXPRICE_ENVIRONMENT_ID || stackEnv.FLEXPRICE_ENVIRONMENT_ID || SEED_ENVIRONMENT_ID;

  const adminConfig = { baseUrl, environmentId, timeoutMs: 15000, keys: { money: adminKey, ingest: adminKey } };
  const admin = createFlexpriceClient({ config: adminConfig });
  const health = await admin.getHealth();
  if (!QUIET_JSON) console.log(`stack ${baseUrl} health=${JSON.stringify(health).slice(0, 60)}`);

  section('plane keys (minted with the admin key; the admin key is then left alone)');
  const minted = await ensureKeys(admin);

  // Catalog writes go through a client whose money plane is the DB-minted key,
  // not the config-map one. If the mint produced nothing (both planes already in
  // .env), read them back so the run exercises the same key the services will.
  const envNow = { ...readEnvFile(), ...minted };
  // In a dry run nothing is written, so the admin key answering the reads is
  // honest; in a real run a missing plane key is a failure, not a fallback.
  const moneyKey = process.env.FLEXPRICE_API_KEY_MONEY || envNow.FLEXPRICE_API_KEY_MONEY;
  const ingestKey = process.env.FLEXPRICE_API_KEY_INGEST || envNow.FLEXPRICE_API_KEY_INGEST;
  if (!DRY && !(moneyKey && ingestKey)) {
    throw new Error('plane keys are missing after the mint step; the catalog must not be written with the config-map key');
  }
  const client = createFlexpriceClient({
    config: { ...adminConfig, keys: { money: moneyKey || adminKey, ingest: ingestKey || adminKey } },
  });

  section('meters');
  const meterIds = await ensureMeters(client);

  section('prices');
  const planId = await ensurePlan(client);
  const priceIds = await ensurePrices(client, planId, meterIds);

  const orgIds = all('org');
  if (!orgIds.length && CONFIG.BILLING.orgId) orgIds.push(CONFIG.BILLING.orgId);
  const orgs = [];
  if (orgIds.length) {
    section('customers, wallets and opening credit');
    for (const orgId of orgIds) {
      orgs.push(await ensureOrg(client, orgId, {
        name: val('org-name'),
        line1: val('address-line1', '1 AI Fleet Road'),
        city: val('city', 'Bengaluru'),
        stateName: val('state-name', 'Karnataka'),
        postal: val('postal', '560001'),
        state: val('state', CONFIG.FLEXPRICE.supplierStateCode || '29'),
        initialCredits: Number(val('initial-credits', CONFIG.BILLING.initialCreditPaise / 100)),
      }));
    }
  } else {
    section('customers');
    report('customer', '(none)', 'skipped', 'pass --org <id> or set FLEET_ORG_ID');
  }

  const failed = rows.filter((r) => r.outcome === 'failed');
  if (QUIET_JSON) {
    console.log(JSON.stringify({ dryRun: DRY, baseUrl, environmentId, meterIds, priceIds, orgs, rows, failed: failed.length }, null, 2));
  } else {
    console.log(`\n${rows.filter((r) => r.outcome === 'created').length} created, ${rows.filter((r) => r.outcome === 'existing').length} existing, ${failed.length} failed${DRY ? ' (dry run: nothing written)' : ''}`);
    if (failed.length) console.log(failed.map((f) => `  FAILED ${f.kind} ${f.name}: ${f.detail}`).join('\n'));
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nprovision aborted: ${err.message}`);
  if (err.body) console.error(JSON.stringify(err.body).slice(0, 400));
  process.exitCode = 1;
});
