'use strict';

const { defineTool } = require('./exec');
const store = require('../../store');
const { resolveOrgId } = require('../../billing/org-context');
const { creditsFromTokenCredits } = require('@software-factory/shared-core/billing/money-wire');
const gate = require('../../billing/gate');

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
  const costTokenCredits = records.reduce((sum, r) => sum + (Number(r.costTokenCredits) || 0), 0);
  return { records: records.length, tokens, costCredits: creditsFromTokenCredits(costTokenCredits) };
}

const getBillingUsageTool = defineTool(
  {
    name: 'get_billing_usage',
    description:
      "Get the organization's Software Factory billing status: current wallet balance in credits and " +
      'token/cost usage over a period. Use to check remaining credit before starting expensive ' +
      'work, or to report spend. Read-only; scoped to the current organization.',
    schema: (z) =>
      z.object({
        period: z.enum(['day', 'week', 'month']).optional().describe('usage window (default: week)'),
      }),
  },
  async (input) => {
    const orgId = resolveOrgId({});
    // Awaited rather than cached: this tool exists to answer "may I start
    // expensive work", so it should read the wallet instead of the last admission.
    const fund = await gate.ensureFundStatus(orgId);
    const period = input.period && PERIOD_DAYS[input.period] ? input.period : 'week';
    const usage = usageSince(orgId, PERIOD_DAYS[period]);
    const raw = fund.balanceTokenCredits;
    const balance = raw === null || raw === undefined
      ? 'unknown (no FlexPrice wallet balance could be read)'
      : `${creditsFromTokenCredits(Math.round(Number(raw) || 0))} credits`;
    const lines = [
      `Organization: ${orgId}`,
      `Balance: ${balance}`,
      `Usage (last ${period}): ${usage.records} run(s), ${usage.tokens} tokens, ${usage.costCredits} credits debited`,
    ];
    if (fund.state === gate.STATE.negative) {
      lines.push('⚠️ Balance is negative — a platform debit exceeded it. Runner activity is paused until credits are added.');
    } else if (!fund.fundsAvailable) {
      lines.push('⚠️ Balance is exhausted — runner activity is paused until credits are added.');
    }
    return lines.join('\n');
  },
);

const FACTORIES = Object.freeze({ get_billing_usage: getBillingUsageTool });

module.exports = { FACTORIES, usageSince, PERIOD_DAYS };
