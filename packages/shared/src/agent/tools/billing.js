'use strict';

const { defineTool } = require('./exec');
const store = require('../../store');
const { resolveOrgId } = require('../../billing/org-context');
const { paiseToInr } = require('../../billing/pricing');
const ledger = require('../../billing/ledger');

/**
 * Billing usage tool — lets an agent fetch its org's current credit balance and
 * recent usage on demand ("fetched as and when required"). READ-ONLY. Scoped to
 * the deployment's billing org via resolveOrgId; it NEVER accepts an org id from
 * the model, so a run can only ever see its own org's billing (cross-tenant safe).
 */

const PERIOD_DAYS = Object.freeze({ day: 1, week: 7, month: 30 });

function usageSince(orgId, days, now = Date.now()) {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const records = store.listUsageRecords({ orgId }).filter((r) => String(r.createdAt || '') >= cutoff);
  const tokens = records.reduce((sum, r) => sum + ((r.usage && Number(r.usage.totalTokens)) || 0), 0);
  const costPaise = records.reduce((sum, r) => sum + (Number(r.costPaise) || 0), 0);
  return { records: records.length, tokens, costInr: paiseToInr(costPaise) };
}

const getBillingUsageTool = defineTool(
  {
    name: 'get_billing_usage',
    description:
      "Get the organization's AI Fleet billing status: current credit balance (INR) and " +
      'token/cost usage over a period. Use to check remaining credit before starting expensive ' +
      'work, or to report spend. Read-only; scoped to the current organization.',
    schema: (z) =>
      z.object({
        period: z.enum(['day', 'week', 'month']).optional().describe('usage window (default: week)'),
      }),
  },
  async (input) => {
    const orgId = resolveOrgId({});
    const account = store.getBillingAccount(orgId);
    const balanceInr = account
      ? paiseToInr(account.balancePaise)
      : paiseToInr(ledger.balanceFromLedger(orgId));
    const period = input.period && PERIOD_DAYS[input.period] ? input.period : 'week';
    const usage = usageSince(orgId, PERIOD_DAYS[period]);
    const lines = [
      `Organization: ${orgId}`,
      `Balance: ₹${balanceInr.toFixed(2)}`,
      `Usage (last ${period}): ${usage.records} run(s), ${usage.tokens} tokens, ₹${usage.costInr.toFixed(2)}`,
    ];
    if (account && Number(account.balancePaise) < 0) {
      lines.push('⚠️ Balance is negative — runner activity is paused until credits are added.');
    }
    return lines.join('\n');
  },
);

const FACTORIES = Object.freeze({ get_billing_usage: getBillingUsageTool });

module.exports = { FACTORIES, usageSince, PERIOD_DAYS };
