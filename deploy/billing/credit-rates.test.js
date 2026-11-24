'use strict';

// The rate card is the author of every rupee-per-token price, so it has to agree with
// the only other place a model name is authoritative: the LiteLLM gateway's model list.
// Drift here is silent in both directions — a gateway model with no row gets priced from
// `defaults` (a wrong number that looks right), and a card row for a model nobody can
// call is a stale price an operator believes they are charging. So both are CI failures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const YAML = require('yaml');

const rates = require('@software-factory/shared-core/billing/credit-rates');

const ROOT = path.resolve(__dirname, '..', '..');
const CARD_PATH = path.join(ROOT, 'deploy', 'billing', 'credit-rates.yaml');

const card = rates.loadCard({ file: CARD_PATH });
const litellm = YAML.parse(fs.readFileSync(path.join(ROOT, 'deploy', 'litellm', 'config.yaml'), 'utf8'));
const gatewayModels = litellm.model_list.map((entry) => entry.model_name);

test('the shipped card loads from the default path the loader computes', () => {
  assert.equal(rates.DEFAULT_CARD_PATH, CARD_PATH,
    'the Dockerfile COPY target, CREDIT_RATES_FILE and this default are one path');
  assert.equal(rates.rateCard({ file: CARD_PATH }).file, CARD_PATH);
});

test('every model the gateway can serve has its own price row', () => {
  const unpriced = gatewayModels.filter((name) => !card.models[name]);
  assert.deepEqual(unpriced, [], 'a gateway model with no row is priced from defaults — a guess');
});

test('the card prices nothing the gateway refuses to serve', () => {
  const stale = Object.keys(card.models).filter((name) => !gatewayModels.includes(name));
  assert.deepEqual(stale, [], 'a row for an uncallable model is a stale rate card');
});

test('every gateway model resolves by name, not by provider fallback', () => {
  for (const name of gatewayModels) {
    const price = rates.priceFor({ model: name }, { card });
    assert.equal(price.match, 'Card', `${name} must have an explicit row`);
    assert.ok(Number(price.input) >= 0 && Number(price.output) >= 0);
  }
});

test('the claude and gpt rows carry the numbers the provider table produced', () => {
  // The switch to a per-model INR card must not move an existing charge: these are the
  // old USD/1M list prices (claude 3 / 15, codex 2.5 / 10) at this card's own FX.
  const fx = Number(card.fx.usdToInr);
  for (const [family, usd] of [[/claude/, [3, 15]], [/gpt-/, [2.5, 10]]]) {
    for (const name of gatewayModels.filter((m) => family.test(m))) {
      const row = card.models[name];
      assert.equal(Number(row.input) / fx, usd[0], `${name} input rate`);
      assert.equal(Number(row.output) / fx, usd[1], `${name} output rate`);
    }
  }
});

test('the offered packages are the offers, with the credit split the invoice will state', () => {
  const byId = Object.fromEntries(card.packages.map((p) => [p.id, p]));
  assert.deepEqual(
    {
      subtotalPaise: byId['credits-3500'].subtotalPaise,
      couponBps: byId['credits-3500'].couponBps,
      bonusTokenCredits: byId['credits-3500'].bonusTokenCredits,
      bonusValidDays: byId['credits-3500'].bonusValidDays,
      credits: byId['credits-3500'].credits,
    },
    { subtotalPaise: 200000, couponBps: 7500, bonusTokenCredits: 150000, bonusValidDays: 30, credits: 3500 },
  );
  assert.equal(byId['credits-10000'].couponBps, 15000, '₹4000 → 10,000 credits is a 150% bonus');
  assert.equal(byId['credits-10000'].bonusTokenCredits, 600000);
  assert.ok(card.packages.every((p) => p.enabled), 'the shipped card offers everything it lists');
  // 18% GST on the prepaid value only: the bonus is a grant, not a discount.
  assert.equal(rates.tokenCreditsFromTokens({ inputTokens: 1_000_000 }, card.models['claude-sonnet-5']),
    Number(card.models['claude-sonnet-5'].input) * 100,
    '1M input tokens cost exactly the card row, in token credits');
});

// Every image that can meter a run has to ship the card, and no Dockerfile in this repo
// copies anything else from deploy/. A missing COPY is the worst shape of failure here:
// the unit suites all pass because they read the card from the repo, and Cloud Run
// crash-loops the orchestrator on boot — or, if the boot gate were relaxed, prices every
// run from `defaults`. So the three paths that must agree are asserted to agree.
test('each image that meters a run bakes the card in, at the path its own ENV names', () => {
  const consumers = ['Dockerfile.billing', 'Dockerfile.orchestrator', 'Dockerfile.substrate-actor'];
  for (const name of consumers) {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'deploy', 'gcp', name), 'utf8');
    const copy = /^COPY\s+deploy\/billing\/credit-rates\.yaml\s+(\S+)$/m.exec(dockerfile);
    assert.ok(copy, `${name} must COPY deploy/billing/credit-rates.yaml to a single target`);
    const inApp = path.relative(ROOT, CARD_PATH).split(path.sep).join('/');
    assert.equal(copy[1], `./${inApp}`, `${name}: COPY is relative to WORKDIR /app, like every other COPY here`);
    const declared = /^ENV\s+NODE_ENV=production[\s\S]*?CREDIT_RATES_FILE=(\S+)$/m.exec(dockerfile);
    assert.ok(declared, `${name}: the runtime ENV block must pin CREDIT_RATES_FILE, not rely on the default`);
    assert.equal(declared[1], `/app/${inApp}`,
      `${name}: that is the file the COPY just put there — and rates.DEFAULT_CARD_PATH under WORKDIR /app`);
    assert.equal(declared[1], path.resolve('/app', path.relative(ROOT, rates.DEFAULT_CARD_PATH)),
      `${name}: unset, the loader would look at this exact path`);
  }
});

test('the card says where its prices came from, or an editor cannot audit them', () => {
  const source = fs.readFileSync(CARD_PATH, 'utf8');
  assert.match(source, /FX is NOT on the cost path/);
  assert.match(source, /MONEY IS A STRING/);
  assert.match(source, /never reads this file/);
});

// Shipping the file is half of it: an image that never loads it discovers the absence as
// a run that priced to nothing, which reads as a cheap month rather than a broken deploy.
// `recordUsage` is deliberately fail-open, so the refusal has to happen at boot instead.
test('each metering process gates its own boot on the card', () => {
  for (const rel of [
    'services/billing/src/index.js',
    'services/orchestrator/src/index.js',
    'services/orchestrator/src/substrate-actor-entry.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(source, /creditRates\.ensureLoaded\(\{ enabled: CONFIG\.FLEXPRICE\.enabled \}\)/,
      `${rel} must load the card before it serves, fatally when billing is on`);
  }
});
