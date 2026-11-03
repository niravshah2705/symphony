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

test('cashfreeClient reports an upstream credential rejection as a diagnosable error, not a 500', async () => {
  const origAppId = process.env.CASHFREE_APP_ID;
  const origSecret = process.env.CASHFREE_SECRET_KEY;
  const origBase = process.env.CASHFREE_BASE_URL;
  const origFetch = globalThis.fetch;
  try {
    process.env.CASHFREE_APP_ID = 'PROD1234';
    process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_prod_abc';
    process.env.CASHFREE_BASE_URL = 'https://sandbox.cashfree.com';
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message: 'authentication Failed', code: 'UNAUTHORIZED' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );

    await assert.rejects(
      () => cashfreeClient.createOrder({ orderId: 'order_1', orderAmount: 100 }),
      (err) => {
        assert.equal(err.status, 502, 'not a 500, and not a 401 the SPA would read as its own session expiring');
        assert.match(err.message, /sandbox environment/);
        assert.match(err.message, /CASHFREE_APP_ID/);
        return true;
      },
    );

    await assert.rejects(
      () => cashfreeClient.createOnDemandSubscription({ subscriptionId: 'sub_1' }),
      (err) => err.status === 502,
    );
  } finally {
    globalThis.fetch = origFetch;
    for (const [key, value] of Object.entries({
      CASHFREE_APP_ID: origAppId, CASHFREE_SECRET_KEY: origSecret, CASHFREE_BASE_URL: origBase,
    })) {
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
  }
});

test('cashfreeClient passes an upstream validation rejection through as a 400', async () => {
  const origAppId = process.env.CASHFREE_APP_ID;
  const origSecret = process.env.CASHFREE_SECRET_KEY;
  const origFetch = globalThis.fetch;
  try {
    process.env.CASHFREE_APP_ID = 'TEST10385923abcdef';
    process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_abc';
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message: 'customer_email is invalid', code: 'BAD_REQUEST' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );

    await assert.rejects(
      () => cashfreeClient.createOrder({ orderId: 'order_1', orderAmount: 100 }),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /customer_email is invalid/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = origFetch;
    if (origAppId !== undefined) process.env.CASHFREE_APP_ID = origAppId;
    else delete process.env.CASHFREE_APP_ID;
    if (origSecret !== undefined) process.env.CASHFREE_SECRET_KEY = origSecret;
    else delete process.env.CASHFREE_SECRET_KEY;
  }
});

test('cashfreeClient createOrder and getOrder fallback to mock when credentials missing', async () => {
  const origAppId = process.env.CASHFREE_APP_ID;
  const origSecret = process.env.CASHFREE_SECRET_KEY;
  try {
    delete process.env.CASHFREE_APP_ID;
    delete process.env.CASHFREE_SECRET_KEY;

    const orderRes = await cashfreeClient.createOrder({
      orderId: 'order_test_123',
      orderAmount: 500,
      orderCurrency: 'INR',
      customerDetails: { customerId: 'org_1', customerPhone: '9999999999' },
    });
    assert.equal(orderRes.order_id, 'order_test_123');
    assert.ok(orderRes.payment_session_id);

    const getRes = await cashfreeClient.getOrder('order_test_123');
    assert.equal(getRes.order_id, 'order_test_123');
    assert.equal(getRes.order_status, 'PAID');
  } finally {
    if (origAppId) process.env.CASHFREE_APP_ID = origAppId;
    if (origSecret) process.env.CASHFREE_SECRET_KEY = origSecret;
  }
});
