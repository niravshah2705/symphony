import { api } from './api.js';

// The recharge flow, in one place: quote → create order → provider checkout →
// settle. Two views need it (Cost and Organization) and both previously carried
// their own copy, which is how the "Add credits" button survived after the
// server stopped crediting on a bare POST.
//
// Nothing here decides what a payment is worth. The server's `quote` is rendered
// as-is — ₹500 + CGST ₹45 + SGST ₹45 = ₹590 for 500 credits — and the settle
// response is the only thing that may say "credits added".

const SDKS = {
  cashfree: { global: 'Cashfree', src: 'https://sdk.cashfree.com/js/v3/cashfree.js' },
  razorpay: { global: 'Razorpay', src: 'https://checkout.razorpay.com/v1/checkout.js' },
};

function loadSdk(provider) {
  const sdk = SDKS[provider];
  if (!sdk) return Promise.reject(new Error(`Unknown payment provider: ${provider}`));
  if (window[sdk.global]) return Promise.resolve(window[sdk.global]);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = sdk.src;
    script.onload = () => resolve(window[sdk.global]);
    script.onerror = () => reject(new Error(`Failed to load the ${provider} checkout SDK.`));
    document.head.appendChild(script);
  });
}

/** The GST breakdown for a subtotal, exactly as the server computed it. */
export async function rechargeQuote(amountInr, couponBps) {
  return api.billing.rechargeQuote(amountInr, couponBps);
}

/**
 * Pay for one recharge and return the settlement.
 *
 * @param {object} args
 * @param {number|string} args.amountInr  the pre-tax subtotal in rupees
 * @param {string} [args.provider]        'cashfree' | 'razorpay'
 * @param {object} [args.customer]        name/email/phone for the gateway
 * @param {string} [args.returnUrl]
 * @param {(msg: string) => void} [args.onStatus]
 */
export async function payRecharge({ amountInr, provider = 'cashfree', customer = {}, returnUrl = '', onStatus = () => {} } = {}) {
  const order = provider === 'razorpay'
    ? await api.billing.createRazorpayOrder({ amountInr, ...customer, returnUrl })
    : await api.billing.createCashfreeOrder({ amountInr, ...customer, returnUrl });

  // A deployment with no gateway keys has no checkout to open; settle() applies
  // the same flag to the credit, so this branch cannot mint free balance on its own.
  if (order.checkout && order.checkout.mode === 'mock') {
    onStatus('Confirming the mock payment…');
    return api.billing.settleRecharge(order.orderId);
  }

  if (provider === 'razorpay') {
    const checkout = order.checkout || {};
    if (!checkout.razorpayOrderId || !checkout.keyId) throw new Error('No Razorpay order was returned.');
    const Razorpay = await loadSdk('razorpay');
    const settlement = await new Promise((resolve, reject) => {
      const rzp = new Razorpay({
        key_id: checkout.keyId,
        order_id: checkout.razorpayOrderId,
        amount: order.quote.totalPaise,
        currency: 'INR',
        name: 'AI Fleet',
        callback: (result) => {
          onStatus('Verifying payment with Razorpay…');
          api.billing.verifyRazorpayOrder({
            orderId: order.orderId,
            razorpayOrderId: result.razorpay_order_id,
            razorpayPaymentId: result.razorpay_payment_id,
            razorpayPaymentSignature: result.razorpay_signature,
          }).then(resolve).catch(reject);
        },
        modal: { ondismiss: () => reject(new Error('Checkout closed before payment.')) },
      });
      rzp.on('payment.failed', (event) => reject(new Error(event.error && event.error.description || 'Razorpay payment failed.')));
      rzp.open();
    });
    return settlement;
  }

  if (!order.paymentSessionId) throw new Error('No payment session returned from Cashfree.');
  const Cashfree = await loadSdk('cashfree');
  const cashfree = Cashfree({ mode: order.environment === 'production' ? 'production' : 'sandbox' });
  const result = await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_modal' });
  if (result && result.error) throw new Error(`Payment error: ${result.error.message}`);
  onStatus('Verifying payment with Cashfree…');
  return api.billing.verifyCashfreeOrder(order.orderId);
}

/** True when a settlement moved credit (or had already moved it before). */
export function isSettled(settlement) {
  return Boolean(settlement && (settlement.status === 'settled' || settlement.alreadyProcessed));
}
