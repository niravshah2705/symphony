import { config } from '../config.ts';
import { fetchJson } from './http.ts';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'x-api-key': config.flexpriceApiKey };
  if (config.flexpriceEnvironmentId) h['X-Environment-ID'] = config.flexpriceEnvironmentId;
  return h;
}

const url = (path: string) => `${config.flexpriceApiUrl}${path}`;

interface ListResponse<T> {
  items?: T[];
  customers?: T[];
  wallets?: T[];
  data?: T[];
}

function items<T>(res: ListResponse<T>): T[] {
  return res.items ?? res.customers ?? res.wallets ?? res.data ?? [];
}

export interface Customer {
  id: string;
  external_id: string;
  name?: string;
}
export interface Wallet {
  id: string;
  customer_id?: string;
  currency?: string;
  balance?: string | number;
}

export interface FlexpriceEvent {
  id: string;
  event_name: string;
  external_customer_id: string;
  timestamp: string;
  properties: Record<string, string>;
}

export const flexprice = {
  async findCustomer(externalId: string): Promise<Customer | undefined> {
    const res = await fetchJson<ListResponse<Customer>>(
      url(`/v1/customers?external_id=${encodeURIComponent(externalId)}&limit=1`),
      { headers: headers() },
    );
    return items(res)[0];
  },
  createCustomer(externalId: string, name: string) {
    return fetchJson<Customer>(url('/v1/customers'), {
      headers: headers(),
      body: { external_id: externalId, name },
    });
  },
  async findOrCreateCustomer(externalId: string, name: string): Promise<Customer> {
    return (await this.findCustomer(externalId)) ?? (await this.createCustomer(externalId, name));
  },
  createWallet(customerId: string) {
    return fetchJson<Wallet>(url('/v1/wallets'), {
      headers: headers(),
      body: { customer_id: customerId, currency: 'INR', wallet_type: 'PRE_PAID', conversion_rate: 1 },
    });
  },
  async listWallets(customerId: string): Promise<Wallet[]> {
    const res = await fetchJson<ListResponse<Wallet>>(
      url(`/v1/wallets?customer_id=${encodeURIComponent(customerId)}&limit=10`),
      { headers: headers() },
    );
    return items(res);
  },
  async findWallet(customerId: string): Promise<Wallet | undefined> {
    return (await this.listWallets(customerId))[0];
  },
  topupWallet(walletId: string, amount: number, idempotencyKey: string) {
    return fetchJson<{ invoice_id?: string }>(url(`/v1/wallets/${walletId}/top-up`), {
      headers: headers(),
      body: { amount, currency: 'INR', transaction_reason: 'PURCHASED_CREDIT_DIRECT', idempotency_key: idempotencyKey },
    });
  },
  walletBalance(walletId: string) {
    return fetchJson(url(`/v1/wallets/${walletId}/balance/real-time`), { headers: headers() });
  },
  async findSubscription(customerId: string): Promise<{ id: string } | undefined> {
    const res = await fetchJson<ListResponse<{ id: string }>>(
      url(`/v1/subscriptions?customer_id=${encodeURIComponent(customerId)}&limit=1`),
      { headers: headers() },
    );
    return items(res)[0];
  },
  createSubscription(customerId: string, planId: string) {
    return fetchJson<{ id: string }>(url('/v1/subscriptions'), {
      headers: headers(),
      body: { customer_id: customerId, plan_id: planId, currency: 'INR', billing_period: 'MONTHLY' },
    });
  },
  // Teardown cancels; it never deletes the customer or the wallet. Immediate
  // cancellation WITH an invoice is the point: an open usage period that is simply
  // abandoned is accrued spend that never reaches a statement, and the customer id
  // is the bare org UUID — deleting it would break the audit trail the delete is
  // required to keep.
  cancelSubscription(subscriptionId: string) {
    return fetchJson(url(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`), {
      headers: headers(),
      body: { cancellation_type: 'immediate', cancel_immediately_invoice_policy: 'generate_invoice' },
    });
  },
  bulkEvents(events: unknown[]) {
    return fetchJson(url('/v1/events/bulk'), { headers: headers(), body: { events } });
  },
  usage(params: Record<string, unknown>) {
    return fetchJson<{ value?: number; event_name?: string; type?: string }>(url('/v1/events/usage'), {
      headers: headers(),
      body: params,
    });
  },
  listEvents(params: {
    externalCustomerId: string;
    eventName?: string;
    startTime?: string;
    endTime?: string;
    limit?: number;
    offset?: number;
  }) {
    const qs = new URLSearchParams({ external_customer_id: params.externalCustomerId, limit: String(params.limit ?? 200) });
    if (params.eventName) qs.set('event_name', params.eventName);
    if (params.startTime) qs.set('start_time', params.startTime);
    if (params.endTime) qs.set('end_time', params.endTime);
    if (params.offset) qs.set('offset', String(params.offset));
    return fetchJson<{ events?: FlexpriceEvent[]; has_more?: boolean; total_count?: number }>(url(`/v1/events?${qs}`), {
      headers: headers(),
    });
  },
  previewInvoice(params: Record<string, unknown>) {
    return fetchJson(url('/v1/invoices/preview'), { headers: headers(), body: params });
  },
  payInvoice(invoiceId: string) {
    return fetchJson(url(`/v1/invoices/${invoiceId}/payment`), {
      headers: headers(),
      method: 'PUT',
      body: { payment_status: 'SUCCEEDED' },
    });
  },
  setAlertConfig(value: Record<string, unknown>) {
    return fetchJson(url('/v1/settings/subscription_alert_config'), {
      headers: headers(),
      method: 'PUT',
      body: { value },
    });
  },
};