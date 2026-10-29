'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cashfreeClient = require('./cashfree-client');
const { getEffectiveThresholdPaise } = require('./recharge');

test('getEffectiveThresholdPaise calculates percentage threshold correctly', () => {
  const account = { initialCreditPaise: 100000 };

  const amountCfg = {
    mode: 'amount',
    thresholdPaise: 5000,
    thresholdPercent: 20
  };
  assert.equal(getEffectiveThresholdPaise(account, amountCfg), 5000);

  const percentCfg = {
    mode: 'percentage',
    thresholdPaise: 5000,
    thresholdPercent: 20
  };
  // 20% of 100,000 paise = 20,000 paise
  assert.equal(getEffectiveThresholdPaise(account, percentCfg), 20000);
});

test('cashfreeClient verifies webhook signatures', () => {
  const secretKey = 'test_secret_12345';
  process.env.CASHFREE_SECRET_KEY = secretKey;

  const rawBody = JSON.stringify({ event: 'SUBSCRIPTION_ACTIVE' });
  const timestamp = '1700000000';
  const dataToSign = `${timestamp}${rawBody}`;
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(dataToSign)
    .digest('base64');

  const headers = {
    'x-webhook-signature': signature,
    'x-webhook-timestamp': timestamp
  };

  const isValid = cashfreeClient.verifyWebhookSignature(headers, rawBody);
  assert.equal(isValid, true);

  const isInvalid = cashfreeClient.verifyWebhookSignature({ 'x-webhook-signature': 'bad', 'x-webhook-timestamp': timestamp }, rawBody);
  assert.equal(isInvalid, false);
});

test('cashfreeClient getBaseUrl respects CASHFREE_BASE_URL and CASHFREE_ENV', () => {
  const origBase = process.env.CASHFREE_BASE_URL;
  const origEnv = process.env.CASHFREE_ENV;
  try {
    delete process.env.CASHFREE_BASE_URL;
    process.env.CASHFREE_ENV = 'sandbox';
    assert.equal(cashfreeClient.getBaseUrl(), 'https://sandbox.cashfree.com/pg');

    process.env.CASHFREE_ENV = 'production';
    assert.equal(cashfreeClient.getBaseUrl(), 'https://api.cashfree.com/pg');

    process.env.CASHFREE_BASE_URL = 'https://sandbox.cashfree.com';
    assert.equal(cashfreeClient.getBaseUrl(), 'https://sandbox.cashfree.com/pg');

    process.env.CASHFREE_BASE_URL = 'https://sandbox.cashfree.com/pg/';
    assert.equal(cashfreeClient.getBaseUrl(), 'https://sandbox.cashfree.com/pg');
  } finally {
    if (origBase !== undefined) process.env.CASHFREE_BASE_URL = origBase;
    else delete process.env.CASHFREE_BASE_URL;
    if (origEnv !== undefined) process.env.CASHFREE_ENV = origEnv;
    else delete process.env.CASHFREE_ENV;
  }
});
