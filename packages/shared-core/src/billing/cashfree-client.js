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

/**
 * A non-2xx from Cashfree is three different failures, and only one of them is
 * the caller's: a 401/403 means *this deployment's* App ID / Secret Key pair is
 * wrong (or rotated against the other half), which the browser can neither see
 * nor fix and which a generic 500 hides completely. Tag each outcome with the
 * status + code the service's error handler should emit, keeping the provider's
 * own status for log correlation.
 */
function providerError(action, status, data = {}) {
  const detail = data.message || data.reason || data.code || 'no detail from Cashfree';
  const err = new Error(`Cashfree ${action} failed (${status}): ${detail}`);
  err.providerStatus = status;
  err.providerCode = data.code || null;
  if (status === 401 || status === 403) {
    err.status = 502;
    err.code = 'cashfree_authentication_failed';
    err.message = `Cashfree rejected the configured API credentials (${status}). `
      + `Verify CASHFREE_APP_ID and CASHFREE_SECRET_KEY are the active pair for the `
      + `${environmentLabel()} environment.`;
  } else if (status >= 500) {
    err.status = 502;
    err.code = 'cashfree_unavailable';
  } else {
    err.status = 400;
    err.code = 'cashfree_request_rejected';
  }
  return err;
}

function environmentLabel() {
  const base = getBaseUrl();
  return base.includes('sandbox.cashfree.com') ? 'sandbox' : 'production';
}

/** Log the fields that identify the rejection without echoing a request payload. */
function logProviderFailure(action, status, data = {}) {
  log.error(`Cashfree ${action} failed`, {
    status,
    code: data.code || null,
    type: data.type || null,
    message: data.message || data.reason || null,
  });
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

  const responseData = await res.json().catch(() => ({}));
  if (!res.ok) {
    logProviderFailure('createOnDemandSubscription', res.status, responseData);
    throw providerError('createOnDemandSubscription', res.status, responseData);
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
    logProviderFailure('getSubscription', res.status, responseData);
    throw providerError('getSubscription', res.status, responseData);
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
    logProviderFailure('chargeSubscription', res.status, responseData);
    throw providerError('chargeSubscription', res.status, responseData);
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

  const responseData = await res.json().catch(() => ({}));
  if (!res.ok) {
    logProviderFailure('createOrder', res.status, responseData);
    throw providerError('createOrder', res.status, responseData);
  }

  return responseData;
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

  const responseData = await res.json().catch(() => ({}));
  if (!res.ok) {
    logProviderFailure('getOrder', res.status, responseData);
    throw providerError('getOrder', res.status, responseData);
  }

  return responseData;
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
