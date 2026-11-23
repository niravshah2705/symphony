'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const creditRates = require('@software-factory/shared-core/billing/credit-rates');
const job = require('./reconcile-gateway-spend');

const ORG = '7e2ce8ba-57d3-4d80-bdba-ec18a8d2d348';
const OTHER = '11111111-2222-3333-4444-555555555555';

const records = [
  { orgId: ORG, createdAt: '2026-11-05T10:00:00.000Z', costTokenCredits: 4000, billingSource: 'managed', gatewayMode: 'litellm', fxRateToInr: '80.00' },
  { orgId: ORG, createdAt: '2026-11-05T11:00:00.000Z', costTokenCredits: 0, notionalCostTokenCredits: 1500, billingSource: 'customer', gatewayMode: 'litellm', fxRateToInr: '80.00' },
  // A pre-Stage-4 row: no rate of its own, so it is the share the band may widen over.
  { orgId: ORG, createdAt: '2026-11-05T12:00:00.000Z', costTokenCredits: 250, gatewayMode: undefined },
  { orgId: OTHER, createdAt: '2026-11-05T12:30:00.000Z', costTokenCredits: 9999, billingSource: 'managed' },
  // Outside the window on both sides.
  { orgId: ORG, createdAt: '2026-11-01T00:00:00.000Z', costTokenCredits: 77, billingSource: 'managed' },
  { orgId: ORG, createdAt: '2026-11-07T00:00:00.000Z', costTokenCredits: 88, billingSource: 'managed' },
];

// The card row a run is measured against, held in the fixture rather than read from
// deploy/billing/credit-rates.yaml: an operator editing the published rate must not be
// able to move this file's verdict, and every number below is stated against it.
const FX = Object.freeze({
  usdToInr: '87.00', asOf: '2026-11-01', ageDays: 0, stale: false, driftBpsPerDay: 15, toleranceBps: 100,
});

function fakeStore(rows = records) {
  const called = [];
  return {
    called,
    listUsageRecords(filter = {}) {
      called.push(`listUsageRecords:${filter.orgId || '*'}`);
      let out = rows;
      if (filter.orgId) out = out.filter((r) => r.orgId === filter.orgId);
      if (filter.billingSource) out = out.filter((r) => (r.billingSource || 'managed') === filter.billingSource);
      return out;
    },
  };
}

const WINDOW = { since: '2026-11-04T00:00:00.000Z', until: '2026-11-06T00:00:00.000Z' };

test('the window is inclusive and the org filter is applied before slicing', () => {
  const inWindow = job.windowRecords(fakeStore(), { orgId: ORG, ...WINDOW });
  assert.deepEqual(inWindow.map((r) => r.costTokenCredits), [4000, 0, 250]);
  // An org-less sweep is allowed (it is how a stray record on an unknown org shows up).
  assert.equal(job.windowRecords(fakeStore(), { ...WINDOW }).length, 4);
});

test('recorded totals keep BYOK notional cost out of charged money', () => {
  const totals = job.recordedTotals(job.windowRecords(fakeStore(), { orgId: ORG, ...WINDOW }), FX.usdToInr);
  assert.equal(totals.records, 3);
  assert.equal(totals.costTokenCredits, 4250, 'the sweep-debited field, unchanged by the report');
  assert.equal(totals.managedTokenCredits, 4250);
  assert.equal(totals.customerNotionalTokenCredits, 1500);
  assert.equal(totals.notionalCostTokenCredits, 1500);
  // Comparable = what the gateway could have also seen: managed cost + the
  // customer calls that really cost money at the gateway.
  assert.equal(totals.comparableTokenCredits, 5750);
  assert.deepEqual(totals.gatewayModes, { litellm: 2, direct: 1 });
  // The same 5,750 in the gateway's unit, at each row's own rate: 5,500 carried ₹80/USD
  // (= $0.6875) and the 250 that carried none falls to the card's ₹87 (= $0.02873563).
  assert.equal(totals.expectedUsd, '0.71623563');
  assert.deepEqual(totals.coverage, { withRate: 2, without: 1, tokenCreditsWithout: 250 });
});

test('a rate move between the run and the report stops fabricating a delta', () => {
  // The window was priced at ₹80/USD; the card now says ₹87. Converting the gateway's
  // total at the card row — what this job did before Stage 6 — reports 525 credits the
  // platform never charged, in a window where both sides agree perfectly.
  const window100 = job.recordedTotals([
    ...Array.from({ length: 60 }, () => ({ costTokenCredits: 100, fxRateToInr: '80.00' })),
    ...Array.from({ length: 40 }, () => ({ costTokenCredits: 100 })),
  ], FX.usdToInr);
  assert.equal(window100.expectedUsd, '1.20977011');
  const spendUsd = Number(window100.expectedUsd);
  assert.equal(job.platformTokenCredits({ spendUsd, recorded: window100, fxUsdToInr: FX.usdToInr }), 10000,
    'the window’s own rate mix cancels the discrepancy entirely');
  assert.equal(creditRates.tokenCreditsFromUsd(spendUsd, FX.usdToInr), 10525,
    'and the discarded method is what a rate move used to report');
});

test('a gateway response is summed whatever its shape, and never guessed at', () => {
  assert.deepEqual(
    job.summarizeSpendLogs([{ spend: 0.01 }, { spend: 0.02 }, { note: 'no spend field' }]),
    { available: true, requests: 2, spendUsd: 0.03 },
    'the total stays in USD: the rate that turns it into credits belongs to the records, not this response',
  );
  assert.equal(job.summarizeSpendLogs({ results: [{ spend: 1 }] }).requests, 1);
  assert.equal(job.summarizeSpendLogs({ results: [{ spend: 1 }] }).spendUsd, 1);
  // Neither rows nor a wrapped list: say so, rather than reporting a free window.
  assert.deepEqual(job.summarizeSpendLogs('nonsense'), { available: false, reason: 'gateway_response_unshapeled' });
  assert.deepEqual(job.summarizeSpendLogs({ total: 12 }), { available: false, reason: 'gateway_response_unshapeled' });
  assert.deepEqual(job.summarizeSpendLogs([]), { available: true, requests: 0, spendUsd: 0 });
});

test('the gateway read degrades to a reason, and never leaks the key', async () => {
  assert.deepEqual(await job.fetchGatewaySpend({ baseUrl: '', key: 'k', ...WINDOW }), {
    available: false, reason: 'gateway_url_unconfigured',
  });
  assert.deepEqual(await job.fetchGatewaySpend({ baseUrl: 'https://gw.internal', key: '', ...WINDOW }), {
    available: false, reason: 'gateway_key_unavailable',
  });

  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = url;
    seen.headers = init.headers;
    return { ok: true, status: 200, json: async () => [{ spend: 0.5 }] };
  };
  const spend = await job.fetchGatewaySpend({
    baseUrl: 'https://gw.internal/', key: 'sk-litellm-secret', fetchImpl, ...WINDOW,
  });
  assert.equal(spend.available, true);
  assert.equal(spend.requests, 1);
  assert.equal(spend.spendUsd, 0.5);
  assert.match(seen.url, /\/global\/spend\/logs\?start_date=2026-11-04&end_date=2026-11-06$/);
  assert.equal(seen.headers.authorization, 'Bearer sk-litellm-secret');
  // The returned record is what reaches the log line — the key must not ride in it.
  assert.doesNotMatch(JSON.stringify(spend), /sk-litellm-secret/);

  const rejected = await job.fetchGatewaySpend({
    baseUrl: 'https://gw.internal', key: 'k', fetchImpl: async () => ({ ok: false, status: 403 }),
    ...WINDOW,
  });
  assert.deepEqual(rejected, { available: false, reason: 'gateway_key_rejected: 403' });

  const down = await job.fetchGatewaySpend({
    baseUrl: 'https://gw.internal',
    key: 'k',
    fetchImpl: async () => { throw new Error('fetch failed'); },
    ...WINDOW,
  });
  assert.equal(down.available, false);
  assert.match(down.reason, /^gateway_unreachable/);
});

test('the verdict says which side is ahead, and abstains when the gateway is silent', () => {
  // ₹100/USD so the fixture divides without a remainder: 5,750 token credits = $0.575.
  const recorded = job.recordedTotals([{ costTokenCredits: 5750, fxRateToInr: '100.00' }], '100.00');
  const fx = { ...FX, usdToInr: '100.00', toleranceBps: 0 };
  const report = (platform) => job.buildReport({
    orgId: ORG, window: WINDOW, platform, recorded, fx,
  }).delta;
  assert.equal(recorded.expectedUsd, '0.57500000');
  assert.deepEqual(report({ available: false, reason: 'gateway_url_unconfigured' }), { tokenCredits: null, verdict: 'platform_unavailable' });
  assert.deepEqual(report({ available: true, spendUsd: 0.575 }), { tokenCredits: 0, bandTokenCredits: 1, verdict: 'match' });
  assert.deepEqual(report({ available: true, spendUsd: 0.5751 }), { tokenCredits: 1, bandTokenCredits: 1, verdict: 'match' },
    'one token credit is a rounding step, not a discrepancy');
  assert.equal(report({ available: true, spendUsd: 0.7 }).verdict, 'platform_ahead');
  assert.equal(report({ available: true, spendUsd: 0.1 }).verdict, 'we_are_ahead');
});

test('the band widens over the un-stamped share only', () => {
  // 60 rows carry ₹80/USD and 40 carry nothing, so the band is 100 bps of the 4,000 the
  // card had to price — 40 credits — and never 100 bps of the whole 10,000. The last case
  // is the one that matters: 55 credits is inside the whole-window band (60) and outside
  // the share that legitimately needs one, so a pricing error on stamped rows stays visible.
  const recorded = job.recordedTotals([
    ...Array.from({ length: 60 }, () => ({ costTokenCredits: 100, fxRateToInr: '80.00' })),
    ...Array.from({ length: 40 }, () => ({ costTokenCredits: 100 })),
  ], FX.usdToInr);
  const verdict = (spendUsd) => job.buildReport({
    orgId: ORG, window: WINDOW, platform: { available: true, requests: 100, spendUsd }, recorded, fx: FX,
  });
  assert.equal(verdict(1.21321838).delta.verdict, 'match', '29 credits: inside the 40 the un-stamped rows may account for');
  assert.equal(verdict(1.21642385).delta.verdict, 'platform_ahead', '55 credits: past that share, so it is a finding');
  assert.deepEqual(verdict(1.21642385).coverage, { withRate: 60, without: 40, tokenCreditsWithout: 4000 },
    'and the report says how much of the window the band excused');
  assert.deepEqual(verdict(1.21642385).fx, {
    usdToInr: '87.00', asOf: '2026-11-01', ageDays: 0, stale: false, toleranceBps: 100,
  }, 'the row the verdict was reached with travels with the verdict');
});

test('a stale rate row answers fx_stale instead of accusing a side', () => {
  const recorded = job.recordedTotals([{ costTokenCredits: 10000, fxRateToInr: '80.00' }], FX.usdToInr);
  const stale = { ...FX, stale: true, ageDays: 60, toleranceBps: 1000 };
  const report = (platform) => job.buildReport({ orgId: ORG, window: WINDOW, platform, recorded, fx: stale });
  assert.equal(report({ available: true, spendUsd: Number(recorded.expectedUsd) }).delta.verdict, 'match',
    'a stale rate still forgives an exact window — the age is not itself the finding');
  assert.equal(report({ available: true, spendUsd: 1.3 }).delta.verdict, 'fx_stale');
  // A stale rate excuses no drift on the FlexPrice leg: that one is our number against our
  // number, so it names the dropped event instead of the operator.
  const flexprice = { available: true, meterId: 'm', spendTokenCredits: 9999 };
  assert.equal(job.buildReport({ orgId: ORG, window: WINDOW, platform: { available: false, reason: 'x' }, flexprice, recorded, fx: stale }).flexprice_delta.verdict, 'we_are_ahead');
});

test('the FlexPrice leg has no band: one credit of drift is a defect', () => {
  const recorded = job.recordedTotals([{ costTokenCredits: 1000, fxRateToInr: '87.00' }], FX.usdToInr);
  const leg = (value) => job.buildReport({
    orgId: ORG, window: WINDOW,
    platform: { available: false, reason: 'gateway_key_unavailable' },
    flexprice: { available: true, meterId: 'm', spendTokenCredits: value },
    recorded, fx: FX,
  }).flexprice_delta;
  assert.deepEqual(leg(1000), { tokenCredits: 0, bandTokenCredits: 0, verdict: 'match' });
  assert.deepEqual(leg(999), { tokenCredits: -1, bandTokenCredits: 0, verdict: 'we_are_ahead' },
    'a meter one credit short is an event that never arrived, not rounding');
  assert.deepEqual(leg(1001), { tokenCredits: 1, bandTokenCredits: 0, verdict: 'platform_ahead' });
});

test('the band grows with the age of the rate and stops at the cap', () => {
  const reconcile = { baseToleranceBps: 100, maxToleranceBps: 1000 };
  assert.equal(job.toleranceBpsFor(reconcile, { ageDays: 0, driftBpsPerDay: 15 }), 100);
  assert.equal(job.toleranceBpsFor(reconcile, { ageDays: 20, driftBpsPerDay: 15 }), 400,
    'an unconfirmed rate earns 15 bps per day of age, not an unbounded excuse');
  assert.equal(job.toleranceBpsFor(reconcile, { ageDays: 400, driftBpsPerDay: 15 }), 1000,
    'and the cap holds, because a band that reaches 100% is not a band');
  assert.equal(job.toleranceBpsFor(reconcile, { ageDays: -1, driftBpsPerDay: 15 }), 100,
    'a rate row dated in the future widens nothing');
  assert.equal(job.toleranceBpsFor(null, { ageDays: 5, driftBpsPerDay: 15 }), 0,
    'no reconcile block means no band, which is the fail-closed direction');

  // The published card is what a real sweep reads: if `reconcile` or `fx.drift_bps_per_day`
  // stops existing in deploy/billing/credit-rates.yaml, this line is where it shows.
  const fx = job.fxRow();
  assert.equal(fx.usdToInr, '87.00');
  assert.ok(Number.isInteger(fx.toleranceBps) && fx.toleranceBps >= 100 && fx.toleranceBps <= 1000,
    `card tolerance is ${fx.toleranceBps}, outside the published base..cap`);
  assert.equal(fx.stale, fx.ageDays > fx.staleAfterDays);
});

test('a band breach on the platform leg is a pricing question, not a currency one', () => {
  // The remediation the split implies: an un-stamped window has no rate of its own, so the
  // only thing a breach can mean is that the card row used for it is wrong by more than its
  // age allows. Editing the YAML and redeploying fixes it; rotating FX fixes nothing, and the
  // report says which row was in play either way.
  const recorded = job.recordedTotals([{ costTokenCredits: 100000 }], FX.usdToInr);
  assert.equal(recorded.coverage.withRate, 0, 'a fully un-stamped window is exactly the population the band is for');
  const breach = job.buildReport({
    orgId: ORG, window: WINDOW, recorded, fx: { ...FX, ageDays: 40, toleranceBps: 700 },
    platform: { available: true, requests: 1, spendUsd: 11.83908046 },
  });
  assert.equal(breach.delta.bandTokenCredits, 7000, '700 bps of the 100,000 credits the card had to price');
  assert.equal(breach.delta.tokenCredits, 3000);
  assert.equal(breach.delta.verdict, 'match', '$11.84 against a ₹87 row is 3,000 credits, inside what a 40-day-old rate may explain');
  assert.equal(job.buildReport({
    orgId: ORG, window: WINDOW, recorded, fx: { ...FX, ageDays: 40, toleranceBps: 700 },
    platform: { available: true, requests: 1, spendUsd: 12.5 },
  }).delta.verdict, 'platform_ahead', '$12.50 is 8,750 credits past the window the age of the row can account for');
});

test('a row with no usable rate counts as un-stamped, never as free', () => {
  assert.equal(job.stampedRate('87.00'), '87.00');
  assert.equal(job.stampedRate(' 80.5 '), '80.5', 'an engine decimal arrives with whitespace to ignore, not to guess at');
  assert.equal(job.stampedRate(undefined), null);
  assert.equal(job.stampedRate('0'), null, 'a zero rate would turn every credit into an infinite USD figure');
  assert.equal(job.stampedRate('-87'), null);
  assert.equal(job.stampedRate('87abc'), null);
});

test('org selection: a targeted sweep wins, otherwise every real org with usage', () => {
  assert.deepEqual(job.selectOrgs(fakeStore(), { RECONCILE_ORG_IDS: `${OTHER}, ${ORG},${ORG}` }), [OTHER, ORG]);
  assert.deepEqual(job.selectOrgs(fakeStore(), {}), [ORG, OTHER]);
  // The shared-stack pseudo-org has no vault and no tenant report to make.
  assert.deepEqual(job.selectOrgs(fakeStore([{ orgId: '__shared__', createdAt: '2026-11-05T00:00:00.000Z' }]), {}), []);
});

test('a reconcile run writes one report per org and touches no money API', async () => {
  const storeApi = fakeStore();
  const lines = [];
  const meterCalls = [];
  const summary = await job.main({
    env: { RECONCILE_ORG_IDS: ORG, RECONCILE_WINDOW_DAYS: '2' },
    initStoreImpl: async () => {},
    write: (line) => lines.push(line),
    logImpl: { info() {}, warn() {}, error() {} },
    now: new Date('2026-11-06T00:00:00.000Z'),
    deps: {
      storeApi,
      fx: FX,
      baseUrl: 'https://gw.internal',
      fetchS2sSecrets: async () => ({ litellmApiKey: 'virtual-key' }),
      fetchGatewaySpend: async () => ({ available: true, requests: 2, spendUsd: 0.1 }),
      flexpriceClient: {
        listMeters: async () => ({ items: [{ id: 'meter_llm', name: 'llm-token-credits' }] }),
        eventsUsageMeter: async (query) => {
          meterCalls.push(query);
          return { value: 4250 };
        },
      },
    },
  });

  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  assert.equal(report.orgId, ORG);
  assert.equal(report.platform_says.spendUsd, 0.1);
  assert.equal(report.we_recorded.comparableTokenCredits, 5750);
  assert.equal(report.delta.verdict, 'we_are_ahead');
  assert.equal(report.flexprice_says.spendTokenCredits, 4250);
  assert.equal(report.flexprice_delta.verdict, 'match');
  // Both halves of the new verdict travel on the line: the row it used and the share of the
  // window that row was allowed to speak for.
  assert.deepEqual(report.fx, { usdToInr: '87.00', asOf: '2026-11-01', ageDays: 0, stale: false, toleranceBps: 100 });
  assert.deepEqual(report.coverage, { withRate: 2, without: 1, tokenCreditsWithout: 250 });
  assert.equal(report.we_recorded.expectedUsd, '0.71623563');
  assert.deepEqual(meterCalls, [{
    meterId: 'meter_llm',
    externalCustomerId: ORG,
    startTime: '2026-11-04T00:00:00.000Z',
    endTime: '2026-11-06T00:00:00.000Z',
  }]);
  assert.deepEqual(summary.window, { since: '2026-11-04T00:00:00.000Z', until: '2026-11-06T00:00:00.000Z' });
  // The summary line of a scheduled job carries the rate row too: 100 orgs agreeing on a
  // wrong rate is one finding, and it is invisible without it.
  assert.deepEqual(summary.fx, { usdToInr: '87.00', asOf: '2026-11-01', ageDays: 0, stale: false, toleranceBps: 100 });

  // The whole point of the read-only claim: nothing but reads happened.
  assert.deepEqual(storeApi.called, ['listUsageRecords:' + ORG]);
  assert.equal(storeApi.addUsageRecord, undefined);
  const source = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, 'reconcile-gateway-spend.js'), 'utf8')
    // Prose may name the money APIs it refuses to call; code may not.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The wallet ops are named, not substringed: this job reads the RATE card, and a bare
  // /credit/ would ban the module it is allowed to import while a future `.credit(` call
  // spelled differently would slip through. Same list services/billing/src/
  // balance-authority.test.js holds for the repo-wide scan.
  assert.doesNotMatch(source, /addUsageRecord|updateUsageRecord|recordLedgerEntry|postLedger|topUpWallet|grantPromo|debitWallet|balanceTokenCredits\s*=/);
});

test('a dropped FlexPrice event diverges independently while LiteLLM remains intact', async () => {
  let meterLists = 0;
  const lines = [];
  await job.main({
    env: { RECONCILE_ORG_IDS: ORG },
    initStoreImpl: async () => {},
    write: (line) => lines.push(line),
    logImpl: { info() {}, warn() {}, error() {} },
    now: new Date('2026-11-06T00:00:00.000Z'),
    deps: {
      storeApi: fakeStore(),
      fx: FX,
      baseUrl: 'https://gw.internal',
      fetchS2sSecrets: async () => ({ litellmApiKey: 'virtual-key' }),
      // Exactly what this window's own rows say they cost, at their own rates: the platform
      // leg has no delta left over once the rates are the ones the events carried.
      fetchGatewaySpend: async () => ({ available: true, requests: 3, spendUsd: 0.71623563 }),
      flexpriceClient: {
        listMeters: async () => {
          meterLists += 1;
          return { items: [{ id: 'meter_llm', name: 'llm-token-credits' }] };
        },
        eventsUsageMeter: async () => ({ value: 4000 }),
      },
    },
  });

  const report = JSON.parse(lines[0]);
  assert.equal(meterLists, 1);
  assert.equal(report.delta.verdict, 'match');
  assert.equal(report.flexprice_delta.tokenCredits, -250);
  assert.equal(report.flexprice_delta.verdict, 'we_are_ahead');
  assert.equal(report.we_recorded.costTokenCredits, 4250);
  assert.equal(report.we_recorded.comparableTokenCredits, 5750);
});

test('a per-org failure is reported, not swallowed or fatal', async () => {
  const lines = [];
  const summary = await job.main({
    env: { RECONCILE_ORG_IDS: `${ORG},${OTHER}` },
    initStoreImpl: async () => {},
    write: (line) => lines.push(line),
    logImpl: { info() {}, warn() {}, error() {} },
    deps: {
      storeApi: fakeStore(),
      fx: FX,
      baseUrl: 'https://gw.internal',
      fetchS2sSecrets: async ({ organizationId }) => {
        if (organizationId === OTHER) throw new Error('settings s2s timeout');
        return { litellmApiKey: 'virtual-key' };
      },
      fetchGatewaySpend: async () => ({ available: true, requests: 1, spendUsd: 0 }),
    },
  });
  assert.equal(lines.length, 2, 'the healthy org is still answered');
  const failedGateway = JSON.parse(lines[1]);
  assert.equal(failedGateway.delta.verdict, 'platform_unavailable');
  assert.match(failedGateway.platform_says.reason, /^gateway_secrets_unavailable/);
  assert.equal(failedGateway.flexprice_delta.verdict, 'flexprice_unavailable');
  assert.equal(summary.orgs, 2);
  assert.equal(summary.unavailable, 1);
});
