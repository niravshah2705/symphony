'use strict';

const { CONFIG } = require('../config');

/**
 * Resolve the orgId a HEADLESS run's usage bills to. Coder/planner runs have no
 * browser caller, so the billable org is the deployment's identity:
 *   - a DEDICATED per-tenant stack sets FLEET_ORG_ID (or PROXY_ORG_ID) so all its
 *     usage bills that one org (structural per-org isolation);
 *   - the SHARED stack leaves it unset, so shared usage attributes to a single
 *     free-tier account (SHARED_ORG_ID).
 *
 * NEVER throws — attribution must never break a run. An explicit per-run override
 * (`context.orgId`) wins when a caller can supply a trusted org (e.g. tests, or a
 * future task→org mapping); it is used verbatim, so callers must only pass a
 * trusted value.
 */
const SHARED_ORG_ID = '__shared__';

function resolveOrgId(context = {}) {
  const override = context && typeof context.orgId === 'string' ? context.orgId.trim() : '';
  if (override) return override;
  if (CONFIG.BILLING.orgId) return CONFIG.BILLING.orgId;
  return SHARED_ORG_ID;
}

module.exports = { resolveOrgId, SHARED_ORG_ID };
