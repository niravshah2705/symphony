'use strict';

const crypto = require('crypto');
const log = require('../logger');

const getBaseUrl = () => {
  const env = String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
  return env === 'production' || env === 'prod'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
};

const getHeaders = () => {
  const appId = process.env.CASHFREE_APP_ID || '';
  const secretKey = process.env.CASHFREE_SECRET_KEY || '';
  return {
    'Content-Type': 'application/json',
    'x-api-version': '2026-01-01',
    'x-client-id': appId,
    'x-client-secret': secretKey,
  };
};

function isConfigured() {
  return Boolean(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
}

async function createOnDemandSubscription({
  subscriptionId,
  customerName = 'Admin User',
  customerEmail = 'admin@aifleet.local',
  customerPhone = '9999999999',
  planMaxAmountInr = 100000,
  returnUrl = '',
}) {
  if (!isConfigured()) {
    throw new Error('Cashfree API keys (CASHFREE_APP_ID / CASHFREE_SECRET_KEY) are not configured');
  }

  const url = `${getBaseUrl()}/subscriptions`;
  const body = {
    subscription_id: subscriptionId,
    customer_details: {
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
    },
    plan_details: {
      plan_name: 'AI Fleet Auto Reload Plan',
      plan_type: 'ON_DEMAND',
      plan_max_amount: Number(planMaxAmountInr) || 100000,
    },
    subscription_meta: {
      return_url: returnUrl,
      notification_channel: ['EMAIL', 'SMS'],
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const responseData = await res.json().catch(() => ({}));
  if (!res.ok) {
    log.error('Cashfree createOnDemandSubscription failed', { status: res.status, data: responseData });
    const msg = responseData.message || responseData.reason || 'Failed to create Cashfree subscription';
    throw new Error(`Cashfree error (${res.status}): ${msg}`);
  }

  return responseData;
}

async function getSubscription(subscriptionId) {
  if (!isConfigured()) {
    throw new Error('Cashfree API keys are not configured');
  }

  const url = `${getBaseUrl()}/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  const responseData = await res.json().catch(() => ({}));
  if (!res.ok) {
    log.error('Cashfree getSubscription failed', { status: res.status, data: responseData });
    const msg = responseData.message || 'Failed to get Cashfree subscription details';
    throw new Error(`Cashfree error (${res.status}): ${msg}`);
  }

  return responseData;
}

async function chargeSubscription({ subscriptionId, paymentId, amountInr }) {
  if (!isConfigured()) {
    throw new Error('Cashfree API keys are not configured');
  }

  const url = `${getBaseUrl()}/subscriptions/pay`;
  const body = {
    subscription_id: subscriptionId,
    payment_id: paymentId,
    payment_type: 'CHARGE',
    payment_amount: Number(amountInr),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const responseData = await res.json().catch(() => ({}));
  if (!res.ok) {
    log.error('Cashfree chargeSubscription failed', { status: res.status, data: responseData });
    const msg = responseData.message || responseData.reason || 'Failed to charge Cashfree subscription';
    throw new Error(`Cashfree error (${res.status}): ${msg}`);
  }

  return responseData;
}

function verifyWebhookSignature(headers = {}, rawBody = '') {
  const secretKey = process.env.CASHFREE_SECRET_KEY || '';
  if (!secretKey) return false;

  const signature = headers['x-webhook-signature'] || headers['X-Webhook-Signature'];
  const timestamp = headers['x-webhook-timestamp'] || headers['X-Webhook-Timestamp'];

  if (!signature || !timestamp) return false;

  try {
    const dataToSign = `${timestamp}${rawBody}`;
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(dataToSign)
      .digest('base64');

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch (err) {
    log.error('Cashfree webhook signature verification error', { error: err.message });
    return false;
  }
}

module.exports = {
  isConfigured,
  createOnDemandSubscription,
  getSubscription,
  chargeSubscription,
  verifyWebhookSignature,
};
