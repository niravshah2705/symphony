'use strict';

const crypto = require('crypto');
const log = require('../logger');

const getBaseUrl = () => {
  if (process.env.CASHFREE_BASE_URL) {
    const raw = String(process.env.CASHFREE_BASE_URL).trim().replace(/\/+$/, '');
    return raw.endsWith('/pg') ? raw : `${raw}/pg`;
  }
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

/** The environment the base URL actually points at, for error wording. */
function currentEnvironment() {
  return getBaseUrl().includes('sandbox') ? 'sandbox' : 'production';
}

/** Guard for the calls that have no unconfigured mock path. */
function requireConfigured(operation) {
  if (isConfigured()) return;
  const err = new Error(`Cashfree is not configured (CASHFREE_APP_ID / CASHFREE_SECRET_KEY are missing), cannot ${operation}.`);
  err.status = 400;
  err.code = 'cashfree_not_configured';
  throw err;
}

/**
 * Read a Cashfree response. An upstream 4xx is a data- or credential-level
 * rejection, not a crash, so the thrown error carries the status the API should
 * answer with and Cashfree's own message: the caller (and the browser toast)
 * learns *why* it failed instead of seeing an opaque 500. A credential failure
 * is reported as 502 rather than 401 — this service's own 401 means "your
 * session is invalid", and reusing it would make the SPA refresh a bearer
 * token and lock the workspace over what is a server-side key mismatch.
 */
async function readResponse(res, operation) {
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;

  const upstreamMessage = data.message || data.reason || 'unknown error';
  log.error(`Cashfree ${operation} failed`, { status: res.status, code: data.code, data });

  const authFailure = res.status === 401 || res.status === 403;
  const err = new Error(authFailure
    ? `Cashfree rejected the API credentials for the ${currentEnvironment()} environment (${upstreamMessage}). `
      + 'CASHFREE_APP_ID / CASHFREE_SECRET_KEY must be keys issued for that environment.'
    : `Cashfree ${operation} was rejected (${res.status}): ${upstreamMessage}`);
  err.status = authFailure ? 502 : (res.status >= 400 && res.status < 500 ? 400 : 502);
  err.code = authFailure ? 'cashfree_auth_failed' : 'cashfree_request_rejected';
  throw err;
}

async function createOnDemandSubscription({
  subscriptionId,
  customerName = 'Admin User',
  customerEmail = 'admin@aifleet.local',
  customerPhone = '9999999999',
  planMaxAmountInr = 100000,
  returnUrl = '',
}) {
  requireConfigured('create an on-demand subscription');

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
      plan_currency: 'INR',
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

  return readResponse(res, 'createOnDemandSubscription');
}

async function getSubscription(subscriptionId) {
  requireConfigured('read a Cashfree subscription');

  const url = `${getBaseUrl()}/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  return readResponse(res, 'getSubscription');
}

async function chargeSubscription({ subscriptionId, paymentId, amountInr }) {
  requireConfigured('charge a Cashfree subscription');

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

  return readResponse(res, 'chargeSubscription');
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

async function createOrder({
  orderId,
  orderAmount,
  customerId = 'cust_default',
  customerName = 'Admin User',
  customerEmail = 'admin@aifleet.local',
  customerPhone = '9999999999',
  returnUrl = '',
  orderNote = 'Wallet reload',
}) {
  if (!isConfigured()) {
    return {
      order_id: orderId,
      order_status: 'ACTIVE',
      payment_session_id: `mock_session_${crypto.randomUUID()}`,
      mock: true,
    };
  }

  const url = `${getBaseUrl()}/orders`;
  const body = {
    order_id: orderId,
    order_amount: Number(orderAmount),
    order_currency: 'INR',
    customer_details: {
      customer_id: customerId,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
    },
    order_meta: {
      return_url: returnUrl || undefined,
      notify_url: undefined,
    },
    order_note: orderNote,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  return readResponse(res, 'createOrder');
}

async function getOrder(orderId) {
  if (!isConfigured()) {
    return {
      order_id: orderId,
      order_status: 'PAID',
      order_amount: 100,
      mock: true,
    };
  }

  const url = `${getBaseUrl()}/orders/${encodeURIComponent(orderId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  return readResponse(res, 'getOrder');
}

module.exports = {
  getBaseUrl,
  isConfigured,
  createOrder,
  getOrder,
  createOnDemandSubscription,
  getSubscription,
  chargeSubscription,
  verifyWebhookSignature,
};
