import { customerId } from '@fleet-local/shared';
import { config } from '../../config.ts';
import { flexprice } from '../../clients/flexprice.ts';
import { HttpError } from '../../clients/http.ts';
import type { StepExecutor } from '../machine.ts';

function isConflict(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 400 || err.status === 409) && /exist|duplicate|idempoten/i.test(err.body);
}

// Diagram 5: Flexprice customer keyed by the BARE org UUID, a pre-paid INR wallet
// topped up once (fixed idempotency key), and a subscription on the seeded plan.
export const flexpriceStep: StepExecutor = async (ctx) => {
  const externalId = customerId(ctx.orgId);
  const customer = await flexprice.findOrCreateCustomer(externalId, ctx.orgName);

  // findWallet returns the first wallet of any currency; the plan prices are INR,
  // so match on currency or create one (Flexprice allows one active wallet per
  // currency+type; a stale USD-only wallet must not block top-up).
  const wallets = await flexprice.listWallets(customer.id);
  const wallet = wallets.find((w) => (w.currency ?? '').toLowerCase() === 'inr') ?? (await flexprice.createWallet(customer.id));

  try {
    const topup = await flexprice.topupWallet(wallet.id, config.defaultOrgBudgetUsd, `${ctx.orgId}:flexprice:topup`);
    if (topup.invoice_id) await flexprice.payInvoice(topup.invoice_id);
  } catch (err) {
    if (!isConflict(err)) throw err;
  }

  let subscriptionId: string | undefined;
  if (config.flexpricePlanId) {
    const existing = await flexprice.findSubscription(customer.id);
    subscriptionId = existing?.id ?? (await flexprice.createSubscription(customer.id, config.flexpricePlanId)).id;
  }

  return { customerId: customer.id, externalId, walletId: wallet.id, subscriptionId };
};