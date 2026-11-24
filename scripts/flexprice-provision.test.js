'use strict';

/**
 * What the provisioner writes to a stack that already has the old catalog on it.
 *
 * Stage 8 retired the second rate card from this script, but `ensurePrice` converges and
 * never deletes, so a stack provisioned before Stage 4 still carries 14 `rate-*` prices
 * and a `meter-llm-cost` USAGE line minted at ₹0.01 per unit. Both are money-shaped
 * records in the one place an auditor reads: the 0.01 line is a live double charge for
 * any tenant attached to a subscription (the debit already came from the rate card through
 * the usage record), and the rate rows are a stale copy of a table that no longer exists.
 *
 * So this is a full provisioning run against a stub FlexPrice, which is the only way to
 * ask the question: the script runs `main()` at load, so its functions cannot be required
 * and driven. The stub records every request, and the assertions are about the request log
 * — a PUT whose body merges instead of replaces, and the absence of any DELETE, which is
 * the half that cannot be asserted from the source at all.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'flexprice-provision.js');
const PLAN_ID = 'plan_fleet_catalog';

/** The catalog as it stood on a stack provisioned before the rate card moved to YAML. */
function stubState() {
  return {
    meters: [
      // The retired meter, published. No aggregation field is named here on purpose:
      // the property the old events carried is the pre-rename spelling the naming gate
      // forbids, and `ensureMeters` prints what the STACK reports for a retired meter
      // rather than what this file remembers it used to — so the field is its business.
      { id: 'meter_llm_cost', name: 'llm-cost', status: 'published', aggregation: { type: 'SUM' } },
      { id: 'meter_actor', name: 'actor-compute', status: 'published', aggregation: { type: 'SUM', field: 'duration_seconds' } },
      { id: 'meter_deploy', name: 'deployment-minutes', status: 'published', aggregation: { type: 'SUM', field: 'minutes' } },
    ],
    // The new meter is absent (so the run proves it is created), and the retired meter's
    // price is present at the wrong amount with the metadata a real run wrote.
    prices: {
      'meter-llm-cost': {
        id: 'price_llm_cost',
        lookup_key: 'meter-llm-cost',
        amount: '0.01',
        metadata: { fleet_meter: 'llm-cost', fleet_meter_id: 'meter_llm_cost' },
      },
      'recharge-principal': { id: 'price_principal', lookup_key: 'recharge-principal', amount: '1.00', metadata: { fleet_gst: 'false' } },
      'gst-cgst-9': { id: 'price_cgst', lookup_key: 'gst-cgst-9', amount: '0.09', metadata: { fleet_gst: 'true', gst_rate_bps: '900' } },
      'gst-sgst-9': { id: 'price_sgst', lookup_key: 'gst-sgst-9', amount: '0.09', metadata: { fleet_gst: 'true', gst_rate_bps: '900' } },
      'gst-igst-18': { id: 'price_igst', lookup_key: 'gst-igst-18', amount: '0.18', metadata: { fleet_gst: 'true', gst_rate_bps: '1800' } },
    },
    rateRows: [
      {
        id: 'price_rate_anthropic_input',
        lookup_key: 'rate-anthropic-input',
        amount: '261.00',
        metadata: {
          fleet_rate_card: 'true', provider: 'anthropic', direction: 'input',
          usd_per_mtok: '3', fx_usd_inr: '87', fx_captured_on: '2026-01-01',
        },
      },
      { id: 'price_rate_openai_output', lookup_key: 'rate-openai-output', amount: '17.40', metadata: {} },
      // Two near-misses: a catalog line that is not a rate row at all, and a name that
      // shares the prefix but is not one of the 14 this script published.
      { id: 'price_llm_token_credits', lookup_key: 'meter-llm-token-credits', amount: '0.00', metadata: { fleet_meter: 'llm-token-credits' } },
      { id: 'price_rate_decoy', lookup_key: 'rate-anthropic-cache-read', amount: '5.22', metadata: {} },
    ],
  };
}

function startStub(state) {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = raw; }
      const url = new URL(req.url, 'http://flexprice.stub');
      const route = `${req.method} ${url.pathname}`;
      log.push({ method: req.method, path: url.pathname, search: url.search, route, body });
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (route === 'GET /health') return send(200, { status: 'OK' });
      if (route === 'POST /v1/users/search') return send(200, { items: [] });
      if (route === 'GET /v1/secrets/api/keys') return send(200, { items: [] });
      if (route === 'GET /v1/meters') return send(200, { items: state.meters });
      if (route === 'POST /v1/meters') return send(200, { id: 'meter_created' });
      if (route === 'GET /v1/plans') return send(200, { items: [{ id: PLAN_ID, name: 'fleet-catalog' }] });
      if (req.method === 'GET' && url.pathname.startsWith('/v1/prices/lookup/')) {
        const key = decodeURIComponent(url.pathname.split('/').pop());
        return state.prices[key] ? send(200, state.prices[key]) : send(404, { message: 'price not found' });
      }
      if (route === 'POST /v1/prices/search') return send(200, { items: state.rateRows });
            // 201, not 200: the generated model matches `M.json(201, PriceResponse)`, and an
      // unmatched status is a response-validation error rather than a created row.
      if (route === 'POST /v1/prices') return send(201, { id: 'price_created' });
      if (req.method === 'PUT' && url.pathname.startsWith('/v1/prices/')) {
        const id = url.pathname.split('/').pop();
        // The stub keeps what it was told, so a second run reads back a converged
        // catalog instead of the original one — which is what an idempotence check
        // has to run against.
        const patch = (body && typeof body === 'object') ? body : {};
        const stored = Object.values(state.prices).find((p) => p.id === id) || state.rateRows.find((p) => p.id === id);
        if (stored) {
          if (patch.amount !== undefined) stored.amount = patch.amount;
          if (patch.metadata) stored.metadata = patch.metadata;
        }
        return send(200, { id, ...(patch || {}) });
      }
      return send(501, { message: `stub: unhandled ${route}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      log,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

/** One provisioning run, against the stub and a throwaway .env. */
async function provision(stub, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexprice-provision-'));
  const envFile = path.join(dir, '.env');
  // Both plane keys present: the run then reads the catalog with the same credentials the
  // services will, and nothing about the mint step depends on the machine this runs on.
  fs.writeFileSync(envFile, 'FLEXPRICE_API_KEY_MONEY=money-stub\nFLEXPRICE_API_KEY_INGEST=ingest-stub\n', { mode: 0o600 });
  try {
    const child = spawn(process.execPath, [SCRIPT, '--json', ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        FLEXPRICE_ENV_FILE: envFile,
        FLEXPRICE_BASE_URL: stub.baseUrl,
        FLEXPRICE_API_KEY: 'admin-stub',
        FLEXPRICE_API_KEY_MONEY: 'money-stub',
        FLEXPRICE_API_KEY_INGEST: 'ingest-stub',
        // No org: the customer/wallet half is covered by the live verifies, and an
        // ambient FLEET_ORG_ID here would make this test depend on the developer's shell.
        FLEET_ORG_ID: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('provisioner did not finish in 30s')); }, 30000);
      child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(stderr, '', `the provisioner wrote to stderr: ${stderr}`);
    assert.equal(code, 0, `exit ${code}: ${stdout}`);
    const out = JSON.parse(stdout);
    assert.equal(out.failed, 0, `failed rows: ${JSON.stringify(out.rows.filter((r) => r.outcome === 'failed'))}`);
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rowFor = (out, kind, name) => out.rows.find((r) => r.kind === kind && r.name === name);

test('a dry run projects the retired meter price going to zero and writes nothing', async () => {
  const stub = await startStub(stubState());
  try {
    const out = await provision(stub, ['--dry-run', '--retire-rate-rows']);
    assert.equal(out.dryRun, true);

    const llmCost = rowFor(out, 'price', 'meter-llm-cost');
    assert.ok(llmCost, 'the retired meter price was not reported at all');
    assert.equal(llmCost.outcome, 'dry-run');
    // The whole point of Stage 8's provisioner change: the 0.01 is caught, and it is
    // caught as an amount change rather than "existing" (an older check matched on
    // lookup_key alone and would have left a live double charge in place forever).
    assert.match(llmCost.detail, /amount 0\.01 -> 0\.00/, llmCost.detail);
    assert.match(llmCost.detail, /fleet_retired/, llmCost.detail);
    assert.match(llmCost.detail, /fleet_note/, llmCost.detail);

    assert.equal(rowFor(out, 'meter', 'llm-token-credits (fleet.llm_cost)').outcome, 'dry-run');
    assert.equal(rowFor(out, 'meter', 'llm-cost (fleet.llm_cost)').outcome, 'existing (retired)');
    for (const key of ['rate-anthropic-input', 'rate-openai-output']) {
      const row = rowFor(out, 'price', key);
      assert.ok(row && row.outcome === 'dry-run', `${key} was not projected for retirement: ${JSON.stringify(row)}`);
    }
    // The matcher works on names, and two near-misses must not be swept up: the new
    // meter's own price line (a create, not a retirement) and a `rate-` name that is not
    // one of the published `{provider}-{direction}` rows.
    const creditsPrice = rowFor(out, 'price', 'meter-llm-token-credits');
    assert.match(creditsPrice.detail, /amount 0\.00/, creditsPrice.detail);
    assert.doesNotMatch(creditsPrice.detail, /fleet_retired/, creditsPrice.detail);
    assert.equal(rowFor(out, 'price', 'rate-anthropic-cache-read'), undefined);

    const writes = stub.log.filter((r) => r.method === 'PUT' || r.method === 'POST' && !r.path.endsWith('/search'));
    assert.deepEqual(writes.map((r) => r.route), [], 'a dry run wrote to the stack');
  } finally {
    await stub.close();
  }
});

test('the retired meter price is zeroed with its metadata kept', async () => {
  const stub = await startStub(stubState());
  try {
    await provision(stub, ['--retire-rate-rows']);
    const put = stub.log.filter((r) => r.method === 'PUT');
    const zeroed = put.find((r) => r.path === '/v1/prices/price_llm_cost');
    assert.ok(zeroed, `no PUT of the retired price: ${put.map((r) => r.route).join(', ')}`);
    assert.equal(zeroed.body.amount, '0.00');
    // Merged, not replaced: a body that carried only this run's spec would drop the
    // binding that says which meter the line bills.
    assert.equal(zeroed.body.metadata.fleet_meter, 'llm-cost');
    assert.equal(zeroed.body.metadata.fleet_meter_id, 'meter_llm_cost');
    assert.equal(zeroed.body.metadata.fleet_retired, 'true');
    assert.match(zeroed.body.metadata.fleet_note, /usage records/);
  } finally {
    await stub.close();
  }
});

test('rate rows are retired by metadata and never deleted', async () => {
  const stub = await startStub(stubState());
  try {
    const out = await provision(stub, ['--retire-rate-rows']);
    const retired = stub.log.filter((r) => r.method === 'PUT' && /price_rate_/.test(r.path));
    assert.deepEqual(retired.map((r) => r.path).sort(), [
      '/v1/prices/price_rate_anthropic_input',
      '/v1/prices/price_rate_openai_output',
    ].sort(), 'the rate rows this run could see were not the rows it retired');

    for (const call of retired) {
      assert.equal(call.body.amount, undefined, 'retiring a row must not reprice it');
      assert.equal(call.body.metadata.fleet_retired, 'true');
      assert.ok(call.body.metadata.fleet_retired_on, 'a retirement with no date is an open question later');
      // The FX pair is what made these rows go stale; the rate now lives in
      // deploy/billing/credit-rates.yaml with its own `as_of`.
      assert.equal(call.body.metadata.fx_usd_inr, undefined);
      assert.equal(call.body.metadata.fx_captured_on, undefined);
    }
    // What the provider reported is kept: the row remains a record of the old card.
    const anthropic = retired.find((r) => r.path.endsWith('price_rate_anthropic_input'));
    assert.equal(anthropic.body.metadata.provider, 'anthropic');
    assert.equal(anthropic.body.metadata.usd_per_mtok, '3');

    assert.deepEqual(stub.log.filter((r) => r.method === 'DELETE'), [],
      'the provisioner deleted a catalog row; retiring is the reversible half');
    for (const key of ['rate-anthropic-input', 'rate-openai-output']) {
      assert.equal(rowFor(out, 'price', key).outcome, 'retired', `${key} was not reported as retired`);
    }
  } finally {
    await stub.close();
  }
});

test('a second run reports the rows as already retired', async () => {
  const stub = await startStub(stubState());
  try {
    await provision(stub, ['--retire-rate-rows']);
    // The stub applied the PUTs, so the second run reads back the converged catalog —
    // which is the condition an idempotence claim actually has to be tested against.
    stub.log.length = 0;
    const out = await provision(stub, ['--retire-rate-rows']);
    assert.deepEqual(stub.log.filter((r) => r.method === 'PUT'), [], 'a converged catalog was written to again');
    for (const key of ['rate-anthropic-input', 'rate-openai-output']) {
      assert.equal(rowFor(out, 'price', key).outcome, 'existing (retired)', `${key} is not idempotent`);
    }
    assert.equal(rowFor(out, 'price', 'meter-llm-cost').outcome, 'existing',
      'the zeroed price was PUT again — the amount comparison is not on token credits');
  } finally {
    await stub.close();
  }
});
