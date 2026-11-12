'use strict';

/**
 * The payment-provider seam: one interface, two adapters.
 *
 * Both gateways differ in units (Cashfree takes rupees as a decimal, Razorpay
 * takes paise as an integer), in status words, and in webhook envelope shape.
 * Nothing above this file may know that: `settle()` sees
 * `{ status, amountDecimal, providerOrderId }` and nothing else.
 *
 * Deliberately absent: this layer never decides whether a payment is good enough
 * to credit. An adapter's job is to report what the provider said. The knowledge
 * that an UNCONFIGURED provider must not be believed lives in recharge-settle.js
 * (`BILLING_ALLOW_MOCK_PAYMENTS`), because `cashfree-client.js:246-254` answers
 * `getOrder` with a fabricated `PAID` / ₹100 when no keys are set, and an adapter
 * that passed that through would look like a verification.
 */

const crypto = require('node:crypto');
const { decimalFromPaise } = require('@ai-fleet/shared-core/billing/money-wire');
const cashfree = require('@ai-fleet/shared-core/billing/cashfree-client');

const PROVIDERS = Object.freeze(['cashfree', 'razorpay']);

/** The status words `settle()` switches on. Anything else is an adapter bug. */
const PAYMENT = Object.freeze({ PAID: 'PAID', PENDING: 'PENDING', FAILED: 'FAILED' });

class ProviderError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}

function normalizeProvider(provider) {
  const name = String(provider || '').trim().toLowerCase();
  return PROVIDERS.includes(name) ? name : null;
}

function timingSafeHexEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw || ''));
  } catch (_) {
    return null;
  }
}

// --- Cashfree -----------------------------------------------------------------

function mapCashfreeStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'PAID') return PAYMENT.PAID;
  if (s === 'CANCELLED' || s === 'FAILED') return PAYMENT.FAILED;
  return PAYMENT.PENDING; // ACTIVE, PENDING, ERROR before capture
}

function createCashfreeAdapter({ client = cashfree } = {}) {
  return {
    name: 'cashfree',
    isConfigured: () => client.isConfigured(),
    environment: () => process.env.CASHFREE_ENV || 'sandbox',

    /**
     * `amountPaise` is integer paise and leaves this function as the decimal
     * string Cashfree documents (`"590.00"`) — the gross including GST. The
     * conversion is `money-wire.decimalFromPaise`, never `amountInr * 100`.
     */
    async createOrder({ orderId, amountPaise, customer = {}, note, returnUrl }) {
      const order = await client.createOrder({
        orderId,
        orderAmount: decimalFromPaise(amountPaise),
        customerId: customer.id,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        returnUrl,
        orderNote: note,
      });
      return {
        provider: 'cashfree',
        orderId,
        providerOrderId: order.order_id || orderId,
        checkout: { mode: 'session', paymentSessionId: order.payment_session_id || null },
        raw: order,
      };
    },

    async verify(orderId) {
      const order = await client.getOrder(orderId);
      return {
        provider: 'cashfree',
        status: mapCashfreeStatus(order.order_status),
        amountDecimal: order.order_amount == null ? null : String(order.order_amount),
        providerOrderId: order.cf_order_id || order.order_id || orderId,
        // What the unconfigured client returns. Recorded, never trusted — the
        // caller decides whether a mock is acceptable at all.
        mock: Boolean(order.mock),
        raw: order,
      };
    },

    parseWebhook(rawBody, headers = {}) {
      const verified = client.verifyWebhookSignature(headers, rawBody);
      const payload = parseJson(rawBody) || {};
      const data = payload.data || {};
      const order = data.order || {};
      const payment = data.payment || {};
      const orderId = order.order_id || payment.order_id || null;
      const amount = order.order_amount != null ? order.order_amount : payment.payment_amount;
      return {
        provider: 'cashfree',
        verified,
        event: payload.type || null,
        orderId,
        amountDecimal: amount == null ? null : String(amount),
        providerOrderId: payment.payment_id || order.cf_order_id || null,
      };
    },
  };
}

const cashfreeAdapter = createCashfreeAdapter();

// --- Razorpay -----------------------------------------------------------------

function mapRazorpayOrderStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'paid') return PAYMENT.PAID;
  if (s === 'expired') return PAYMENT.FAILED;
  return PAYMENT.PENDING; // created, partially_paid
}

function createRazorpayAdapter({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const baseUrl = () => String(env.RAZORPAY_BASE_URL || 'https://api.razorpay.com/v1').replace(/\/+$/, '');
  const keyId = () => String(env.RAZORPAY_KEY_ID || '');
  const keySecret = () => String(env.RAZORPAY_KEY_SECRET || '');
  const webhookSecret = () => String(env.RAZORPAY_WEBHOOK_SECRET || '');

  async function call(method, route, body) {
    const res = await fetchImpl(`${baseUrl()}${route}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${keyId()}:${keySecret()}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ProviderError(502, 'razorpay_request_failed',
        `Razorpay ${method} ${route} returned ${res.status}: ${json.error && json.error.description || 'no description'}`);
    }
    return json;
  }

  return {
    name: 'razorpay',
    isConfigured: () => Boolean(keyId() && keySecret()),
    environment: () => (baseUrl().includes('test') ? 'test' : 'live'),

    /** Razorpay's `amount` is an integer in the smallest unit (paise) — no decimal. */
    async createOrder({ orderId, amountPaise, customer = {}, note }) {
      const created = await call('POST', '/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt: orderId,
        notes: { fleet_order_id: orderId, note: String(note || '').slice(0, 100) },
      });
      return {
        provider: 'razorpay',
        // The intent's own id stays the key of the record; Razorpay's id is the
        // `order_id` the browser hands back with the payment signature.
        orderId,
        providerOrderId: created.id,
        checkout: { mode: 'checkout.js', keyId: keyId(), razorpayOrderId: created.id },
        raw: created,
      };
    },

    async verify(orderId) {
      const order = await call('GET', `/orders/${encodeURIComponent(orderId)}`);
      const payments = order.payments && order.payments.items ? order.payments.items : [];
      return {
        provider: 'razorpay',
        status: mapRazorpayOrderStatus(order.status),
        // `amount_paid` is what actually landed; `amount` is what was asked for.
        // Verifying against the ask would let a partial payment settle in full.
        amountDecimal: order.amount_paid == null ? null : decimalFromPaise(Number(order.amount_paid)),
        providerOrderId: payments.length ? payments[0].id : (order.id || orderId),
        mock: false,
        raw: order,
      };
    },

    /**
     * Checkout callback proof: HMAC-SHA256 over `<razorpay_order_id>|<razorpay_payment_id>`
     * with the key secret, hex. This is the browser-supplied proof, so it is
     * checked before anything is credited — but it is still not the server-side
     * `verify()`, which is what reports the amount.
     */
    verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature } = {}) {
      if (!keySecret() || !razorpayOrderId || !razorpayPaymentId || !signature) return false;
      const expected = crypto.createHmac('sha256', keySecret())
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');
      return timingSafeHexEqual(signature, expected);
    },

    parseWebhook(rawBody, headers = {}) {
      const signature = headers['x-razorpay-signature'] || headers['X-Razorpay-Signature'];
      const verified = Boolean(webhookSecret()) && timingSafeHexEqual(signature,
        crypto.createHmac('sha256', webhookSecret()).update(String(rawBody || '')).digest('hex'));
      const payload = parseJson(rawBody) || {};
      const payment = (payload.payload && payload.payload.payment && payload.payload.payment.entity) || {};
      const event = String(payload.event || '');
      const captured = event === 'payment.captured' || event === 'order.paid';
      return {
        provider: 'razorpay',
        verified,
        // Normalized onto Cashfree's vocabulary so settle()/routes branch once.
        event: captured ? 'ORDER_PAID_SUCCESS' : event || null,
        orderId: payment.order_id || null,
        amountDecimal: payment.amount == null ? null : decimalFromPaise(Number(payment.amount)),
        providerOrderId: payment.id || null,
      };
    },
  };
}

function providerFor(provider, opts = {}) {
  const name = normalizeProvider(provider);
  if (!name) {
    throw new ProviderError(400, 'unknown_provider',
      `Unknown payment provider "${provider}". Supported: ${PROVIDERS.join(', ')}.`);
  }
  return name === 'cashfree' ? createCashfreeAdapter(opts) : createRazorpayAdapter(opts);
}

module.exports = {
  PROVIDERS,
  PAYMENT,
  ProviderError,
  normalizeProvider,
  providerFor,
  createCashfreeAdapter,
  cashfreeAdapter,
  createRazorpayAdapter,
};
