'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  PROVIDERS,
  PAYMENT,
  normalizeProvider,
  providerFor,
  createCashfreeAdapter,
  createRazorpayAdapter,
} = require('./payment-providers');

// The seam's whole purpose is that the two gateways' differences stop leaking
// upward, so these tests pin the differences at the boundary: the unit each one
// speaks (Cashfree rupees-decimal, Razorpay integer paise), the word each one uses
// for "paid", and what each one's webhook actually contains.

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body });
    const out = await handler(url, init, body);
    return {
      ok: out.status ? out.status < 400 : true,
      status: out.status || 200,
      json: async () => out.json || {},
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('normalizeProvider accepts only the two supported gateways', () => {
  assert.deepEqual([...PROVIDERS].sort(), ['cashfree', 'razorpay']);
  assert.equal(normalizeProvider(' CashFree '), 'cashfree');
  assert.equal(normalizeProvider('razorpay'), 'razorpay');
  assert.equal(normalizeProvider('stripe'), null);
  assert.equal(normalizeProvider(undefined), null);
});

test('providerFor builds the adapter the caller asked for, with its own proof methods', () => {
  assert.throws(() => providerFor('paypal'), (err) => err.status === 400 && err.code === 'unknown_provider');
  assert.equal(providerFor('Razorpay').name, 'razorpay');
  assert.equal(typeof providerFor('razorpay').verifyPaymentSignature, 'function', 'the checkout-callback proof exists only on the gateway that has a checkout.js');
  assert.equal(typeof providerFor('cashfree').verifyPaymentSignature, 'undefined');
  assert.equal(providerFor('cashfree', { client: { isConfigured: () => true } }).isConfigured(), true, 'the real Cashfree singleton is the default client and is replaceable');
});

// --- Cashfree -----------------------------------------------------------------

test('cashfree createOrder sends the GROSS as a rupee decimal, never paise or a float', async () => {
  const sent = [];
  const client = {
    isConfigured: () => true,
    createOrder: async (args) => { sent.push(args); return { order_id: args.orderId, payment_session_id: 'pset_1' }; },
    getOrder: async () => ({}),
    verifyWebhookSignature: () => true,
  };
  const adapter = createCashfreeAdapter({ client });
  const order = await adapter.createOrder({ orderId: 'order_org_1', amountPaise: 59000, customer: { id: 'cust_org_1', name: 'Org' } });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].orderAmount, '590.00', '₹500 + ₹90 GST is what the gateway is asked for');
  assert.equal(typeof sent[0].orderAmount, 'string', 'the wire value is the decimal string, not 590.0000000000001');
  assert.equal(order.checkout.paymentSessionId, 'pset_1');
  assert.equal(order.providerOrderId, 'order_org_1');
});

test('cashfree verify maps PAID and reads the amount as reported by the gateway', async () => {
  const asked = [];
  const adapter = createCashfreeAdapter({
    client: {
      isConfigured: () => true,
      createOrder: async () => ({}),
      getOrder: async (id) => { asked.push(id); return { order_status: 'PAID', order_amount: '590.00', cf_order_id: 'cf_9' }; },
      verifyWebhookSignature: () => true,
    },
  });
  const v = await adapter.verify('order_org_1');
  assert.deepEqual(asked, ['order_org_1']);
  assert.deepEqual(
    { status: v.status, amountDecimal: v.amountDecimal, providerOrderId: v.providerOrderId, mock: v.mock },
    { status: PAYMENT.PAID, amountDecimal: '590.00', providerOrderId: 'cf_9', mock: false },
  );
});

test('cashfree statuses collapse to the three the settlement path switches on', async () => {
  const verify = async (order_status) => (await createCashfreeAdapter({
    client: { isConfigured: () => true, createOrder: async () => ({}), getOrder: async () => ({ order_status }), verifyWebhookSignature: () => true },
  }).verify('x')).status;
  assert.equal(await verify('PAID'), PAYMENT.PAID);
  assert.equal(await verify('ACTIVE'), PAYMENT.PENDING, 'an order that exists is not an order that was paid');
  assert.equal(await verify('CANCELLED'), PAYMENT.FAILED);
  assert.equal(await verify(undefined), PAYMENT.PENDING);
});

test('cashfree reports the unconfigured mock instead of hiding it', async () => {
  const adapter = createCashfreeAdapter({
    client: {
      isConfigured: () => false,
      createOrder: async () => ({}),
      // Exactly what cashfree-client.js:246-254 returns with no keys: PAID, ₹100.
      getOrder: async () => ({ order_status: 'PAID', order_amount: 100, mock: true }),
      verifyWebhookSignature: () => false,
    },
  });
  const v = await adapter.verify('order_org_1');
  assert.equal(v.mock, true, 'the flag is what lets settle() refuse; an adapter that dropped it would launder the mock');
  assert.equal(v.status, PAYMENT.PAID);
});

test('cashfree webhook parse pulls the order id and amount out of both envelope shapes', () => {
  const adapter = createCashfreeAdapter({
    client: { isConfigured: () => true, createOrder: async () => ({}), getOrder: async () => ({}), verifyWebhookSignature: (h) => h.good === 'yes' },
  });
  const byOrder = adapter.parseWebhook(JSON.stringify({
    type: 'ORDER_PAID_SUCCESS', data: { order: { order_id: 'order_a_1', order_amount: '590.00' } },
  }), { good: 'yes' });
  assert.deepEqual(
    { verified: byOrder.verified, event: byOrder.event, orderId: byOrder.orderId, amountDecimal: byOrder.amountDecimal },
    { verified: true, event: 'ORDER_PAID_SUCCESS', orderId: 'order_a_1', amountDecimal: '590.00' },
  );
  const byPayment = adapter.parseWebhook(JSON.stringify({
    type: 'PAYMENT_SUCCESS_WEBHOOK', data: { payment: { order_id: 'order_b_2', payment_amount: 590, payment_id: 'pay_1' } },
  }), { good: 'no' });
  assert.equal(byPayment.orderId, 'order_b_2');
  assert.equal(byPayment.amountDecimal, '590');
  assert.equal(byPayment.verified, false, 'an unsigned event is reported unsigned; the route decides');
  assert.equal(adapter.parseWebhook('not json', {}).event, null);
});

// --- Razorpay -----------------------------------------------------------------

const RZP_ENV = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'sec_123',
  RAZORPAY_WEBHOOK_SECRET: 'whsec_123',
  RAZORPAY_BASE_URL: 'https://api.razorpay.com/v1',
};

test('razorpay createOrder sends integer paise and hands back the ids checkout needs', async () => {
  const fetchImpl = fakeFetch(async () => ({ json: { id: 'order_Rzp9', amount: 59000, amount_paid: 0, status: 'created', currency: 'INR' } }));
  const adapter = createRazorpayAdapter({ fetchImpl, env: RZP_ENV });
  const order = await adapter.createOrder({ orderId: 'order_org_1', amountPaise: 59000, note: 'recharge' });

  assert.equal(fetchImpl.calls[0].url, 'https://api.razorpay.com/v1/orders');
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.equal(fetchImpl.calls[0].body.amount, 59000, 'Razorpay takes the smallest unit: 59000 paise, not 590 and not 59000.0');
  assert.equal(fetchImpl.calls[0].body.currency, 'INR');
  assert.equal(fetchImpl.calls[0].body.receipt, 'order_org_1', 'our intent id rides along as the receipt');
  assert.equal(fetchImpl.calls[0].body.notes.fleet_order_id, 'order_org_1');
  assert.equal(fetchImpl.calls[0].headers.authorization, `Basic ${Buffer.from('rzp_test_key:sec_123').toString('base64')}`);
  assert.equal(order.providerOrderId, 'order_Rzp9');
  assert.deepEqual(order.checkout, { mode: 'checkout.js', keyId: 'rzp_test_key', razorpayOrderId: 'order_Rzp9' });
});

test('razorpay verify reads amount_paid, because amount is only what was asked for', async () => {
  const fetchImpl = fakeFetch(async (url) => (url.endsWith('/orders/order_Rzp9')
    ? { json: { id: 'order_Rzp9', status: 'paid', amount: 59000, amount_paid: 49000, currency: 'INR', payments: { items: [{ id: 'pay_1' }] } } }
    : { json: {} }));
  const adapter = createRazorpayAdapter({ fetchImpl, env: RZP_ENV });
  const v = await adapter.verify('order_Rzp9');
  assert.equal(v.status, PAYMENT.PAID);
  assert.equal(v.amountDecimal, '490.00', 'a partial payment must not settle as if it were the full quote');
  assert.equal(v.providerOrderId, 'pay_1');

  const pending = await createRazorpayAdapter({
    fetchImpl: fakeFetch(async () => ({ json: { id: 'o', status: 'created', amount: 59000, amount_paid: 0 } })),
    env: RZP_ENV,
  }).verify('o');
  assert.deepEqual({ status: pending.status, amountDecimal: pending.amountDecimal }, { status: PAYMENT.PENDING, amountDecimal: '0.00' });

  const expired = await createRazorpayAdapter({
    fetchImpl: fakeFetch(async () => ({ json: { id: 'o', status: 'expired', amount: 59000 } })),
    env: RZP_ENV,
  }).verify('o');
  assert.equal(expired.status, PAYMENT.FAILED);
});

test('razorpay http errors are typed and never echo the secret', async () => {
  const fetchImpl = fakeFetch(async () => ({ status: 401, json: { error: { code: 'BAD_REQUEST_ERROR', description: 'Unauthorized' } } }));
  const adapter = createRazorpayAdapter({ fetchImpl, env: { ...RZP_ENV, RAZORPAY_KEY_SECRET: 'super_secret_value' } });
  await assert.rejects(adapter.verify('order_x'), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.code, 'razorpay_request_failed');
    assert.doesNotMatch(err.message, /super_secret_value|Basic /);
    assert.match(err.message, /Unauthorized/);
    return true;
  });
});

test('razorpay checkout signature is order_id|payment_id, constant-time, and requires a secret', () => {
  const adapter = createRazorpayAdapter({ fetchImpl: fakeFetch(async () => ({ json: {} })), env: RZP_ENV });
  const sign = (orderId, paymentId) => crypto.createHmac('sha256', 'sec_123').update(`${orderId}|${paymentId}`).digest('hex');

  assert.equal(adapter.verifyPaymentSignature({
    razorpayOrderId: 'order_Rzp9', razorpayPaymentId: 'pay_1', signature: sign('order_Rzp9', 'pay_1'),
  }), true);
  assert.equal(adapter.verifyPaymentSignature({
    razorpayOrderId: 'order_Rzp9', razorpayPaymentId: 'pay_2', signature: sign('order_Rzp9', 'pay_1'),
  }), false, 'a signature for another payment of the same order is refused');
  assert.equal(adapter.verifyPaymentSignature({ razorpayOrderId: 'order_Rzp9', razorpayPaymentId: 'pay_1', signature: 'deadbeef' }), false);
  assert.equal(adapter.verifyPaymentSignature({ razorpayOrderId: '', razorpayPaymentId: 'pay_1', signature: 'x' }), false);
  const noSecret = createRazorpayAdapter({ fetchImpl: fakeFetch(async () => ({ json: {} })), env: { RAZORPAY_KEY_ID: 'k' } });
  assert.equal(noSecret.isConfigured(), false);
  assert.equal(noSecret.verifyPaymentSignature({
    razorpayOrderId: 'order_Rzp9', razorpayPaymentId: 'pay_1', signature: sign('order_Rzp9', 'pay_1'),
  }), false, 'without a secret nothing verifies — the check never passes by default');
});

test('razorpay webhook is verified over the raw body and normalized onto the shared event name', () => {
  const adapter = createRazorpayAdapter({ fetchImpl: fakeFetch(async () => ({ json: {} })), env: RZP_ENV });
  const payload = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_1', order_id: 'order_org_1', amount: 59000, status: 'captured' } } },
  });
  const signature = crypto.createHmac('sha256', 'whsec_123').update(payload).digest('hex');
  const parsed = adapter.parseWebhook(payload, { 'x-razorpay-signature': signature });
  assert.deepEqual(parsed, {
    provider: 'razorpay',
    verified: true,
    event: 'ORDER_PAID_SUCCESS',
    orderId: 'order_org_1',
    amountDecimal: '590.00',
    providerOrderId: 'pay_1',
  }, 'paise in, decimal rupees out, and the event name is Cashfree\'s so settle() branches once');

  assert.equal(adapter.parseWebhook(payload, { 'x-razorpay-signature': 'nope' }).verified, false);
  assert.equal(adapter.parseWebhook(payload, {}).verified, false);
  const failed = adapter.parseWebhook(JSON.stringify({
    event: 'payment.failed', payload: { payment: { entity: { id: 'pay_2', order_id: 'order_org_1', amount: 59000 } } },
  }), { 'x-razorpay-signature': crypto.createHmac('sha256', 'whsec_123').update('{}').digest('hex') });
  assert.equal(failed.event, 'payment.failed', 'a failed payment is not quietly rewritten into a paid one');
  assert.equal(failed.verified, false);
});

test('razorpay is unconfigured until both the key id and the secret exist', () => {
  assert.equal(createRazorpayAdapter({ fetchImpl: fakeFetch(async () => ({ json: {} })), env: { RAZORPAY_KEY_ID: 'k' } }).isConfigured(), false);
  assert.equal(createRazorpayAdapter({ fetchImpl: fakeFetch(async () => ({ json: {} })), env: { RAZORPAY_KEY_SECRET: 's' } }).isConfigured(), false);
  assert.equal(createRazorpayAdapter({ fetchImpl: fakeFetch(async () => ({ json: {} })), env: RZP_ENV }).isConfigured(), true);
});
