'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const job = require('./reconcile-gateway-spend');

const ORG = '7e2ce8ba-57d3-4d80-bdba-ec18a8d2d348';
const OTHER = '11111111-2222-3333-4444-555555555555';

const records = [
  { orgId: ORG, createdAt: '2026-11-05T10:00:00.000Z', costPaise: 4000, billingSource: 'managed', gatewayMode: 'litellm' },
  { orgId: ORG, createdAt: '2026-11-05T11:00:00.000Z', costPaise: 0, notionalCostPaise: 1500, billingSource: 'customer', gatewayMode: 'litellm' },
  { orgId: ORG, createdAt: '2026-11-05T12:00:00.000Z', costPaise: 250, gatewayMode: undefined },
  { orgId: OTHER, createdAt: '2026-11-05T12:30:00.000Z', costPaise: 9999, billingSource: 'managed' },
  // Outside the window on both sides.
  { orgId: ORG, createdAt: '2026-11-01T00:00:00.000Z', costPaise: 77, billingSource: 'managed' },
  { orgId: ORG, createdAt: '2026-11-07T00:00:00.000Z', costPaise: 88, billingSource: 'managed' },
];

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
  assert.deepEqual(inWindow.map((r) => r.costPaise), [4000, 0, 250]);
  // An org-less sweep is allowed (it is how a stray record on an unknown org shows up).
  assert.equal(job.windowRecords(fakeStore(), { ...WINDOW }).length, 4);
});

test('recorded totals keep BYOK notional cost out of charged money', () => {
  const totals = job.recordedTotals(job.windowRecords(fakeStore(), { orgId: ORG, ...WINDOW }));
  assert.equal(totals.records, 3);
  assert.equal(totals.costPaise, 4250, 'the sweep-debited field, unchanged by the report');
  assert.equal(totals.managedPaise, 4250);
  assert.equal(totals.customerNotionalPaise, 1500);
  assert.equal(totals.notionalCostPaise, 1500);
  // Comparable = what the gateway could have also seen: managed cost + the
  // customer calls that really cost money at the gateway.
  assert.equal(totals.comparablePaise, 5750);
  assert.deepEqual(totals.gatewayModes, { litellm: 2, direct: 1 });
});

test('a gateway response is summed whatever its shape, and never guessed at', () => {
  assert.deepEqual(
    { ...job.summarizeSpendLogs([{ spend: 0.01 }, { spend: 0.02 }, { note: 'no spend field' }]), available: true },
    { available: true, requests: 2, spendUsd: 0.03, spendPaise: job.summarizeSpendLogs([{ spend: 0.03 }]).spendPaise },
  );
  assert.equal(job.summarizeSpendLogs({ results: [{ spend: 1 }] }).requests, 1);
  assert.equal(job.summarizeSpendLogs({ results: [{ spend: 1 }] }).spendUsd, 1);
  // Neither rows nor a wrapped list: say so, rather than reporting a free window.
  assert.deepEqual(job.summarizeSpendLogs('nonsense'), { available: false, reason: 'gateway_response_unshapeled' });
  assert.deepEqual(job.summarizeSpendLogs({ total: 12 }), { available: false, reason: 'gateway_response_unshapeled' });
  assert.deepEqual(job.summarizeSpendLogs([]), { available: true, requests: 0, spendUsd: 0, spendPaise: 0 });
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
  const recorded = { comparablePaise: 5750, records: 3 };
  const report = (platform) => job.buildReport({
    orgId: ORG, window: WINDOW, platform, recorded,
  }).delta;
  assert.deepEqual(report({ available: false, reason: 'gateway_url_unconfigured' }), { paise: null, verdict: 'platform_unavailable' });
  assert.deepEqual(report({ available: true, spendPaise: 5750 }), { paise: 0, verdict: 'match' });
  assert.deepEqual(report({ available: true, spendPaise: 5751 }), { paise: 1, verdict: 'match' }, 'sub-paise rounding is not a discrepancy');
  assert.equal(report({ available: true, spendPaise: 7000 }).verdict, 'platform_ahead');
  assert.equal(report({ available: true, spendPaise: 1000 }).verdict, 'we_are_ahead');
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
      baseUrl: 'https://gw.internal',
      fetchS2sSecrets: async () => ({ litellmApiKey: 'virtual-key' }),
      fetchGatewaySpend: async () => ({ available: true, requests: 2, spendUsd: 0.1, spendPaise: 1000 }),
      flexpriceClient: {
        listMeters: async () => ({ items: [{ id: 'meter_llm', name: 'llm-cost' }] }),
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
  assert.equal(report.platform_says.spendPaise, 1000);
  assert.equal(report.we_recorded.comparablePaise, 5750);
  assert.equal(report.delta.verdict, 'we_are_ahead');
  assert.equal(report.flexprice_says.spendPaise, 4250);
  assert.equal(report.flexprice_delta.verdict, 'match');
  assert.deepEqual(meterCalls, [{
    meter_id: 'meter_llm',
    external_customer_id: ORG,
    start_time: '2026-11-04T00:00:00.000Z',
    end_time: '2026-11-06T00:00:00.000Z',
  }]);
  assert.deepEqual(summary.window, { since: '2026-11-04T00:00:00.000Z', until: '2026-11-06T00:00:00.000Z' });

  // The whole point of the read-only claim: nothing but reads happened.
  assert.deepEqual(storeApi.called, ['listUsageRecords:' + ORG]);
  assert.equal(storeApi.addUsageRecord, undefined);
  const source = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, 'reconcile-gateway-spend.js'), 'utf8')
    // Prose may name the money APIs it refuses to call; code may not.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /addUsageRecord|updateUsageRecord|recordLedgerEntry|postLedger|debit|credit|balancePaise\s*=/);
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
      baseUrl: 'https://gw.internal',
      fetchS2sSecrets: async () => ({ litellmApiKey: 'virtual-key' }),
      fetchGatewaySpend: async () => ({ available: true, spendPaise: 5750 }),
      flexpriceClient: {
        listMeters: async () => {
          meterLists += 1;
          return { items: [{ id: 'meter_llm', name: 'llm-cost' }] };
        },
        eventsUsageMeter: async () => ({ value: 4000 }),
      },
    },
  });

  const report = JSON.parse(lines[0]);
  assert.equal(meterLists, 1);
  assert.equal(report.delta.verdict, 'match');
  assert.equal(report.flexprice_delta.paise, -250);
  assert.equal(report.flexprice_delta.verdict, 'we_are_ahead');
  assert.equal(report.we_recorded.costPaise, 4250);
  assert.equal(report.we_recorded.comparablePaise, 5750);
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
      baseUrl: 'https://gw.internal',
      fetchS2sSecrets: async ({ organizationId }) => {
        if (organizationId === OTHER) throw new Error('settings s2s timeout');
        return { litellmApiKey: 'virtual-key' };
      },
      fetchGatewaySpend: async () => ({ available: true, requests: 1, spendUsd: 0, spendPaise: 0 }),
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
