#!/usr/bin/env node
'use strict';

/**
 * One-off: create the "Models" issue-label GROUP in Linear and pull the
 * model-routing labels (local/hosted) into it, so Linear shows them as a
 * single-select dropdown on issues. Idempotent — re-running is a no-op once the
 * labels are already grouped.
 *
 * This maintenance call is deliberately routed through the local egress proxy;
 * the process never receives the Linear credential. Run from the repo root:
 *
 *   EGRESS_PROXY_URL=http://127.0.0.1:4030 node scripts/models-label-group.js
 *
 * Set FLEET_ORG_ID and AI_FLEET_PROJECT_ID to select a project-vault override;
 * omit the project id to use the organization-level fallback.
 */

const { CONFIG } = require('@ai-fleet/shared/config');
const { SENTINEL_TOKEN } = require('@ai-fleet/shared/egress');
const { getOrCreateGroupedIssueLabel } = require('@ai-fleet/shared/linear');
const { runWithWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');

async function groupLabels() {
  if (!String(process.env.EGRESS_PROXY_URL || '').trim()) {
    console.error('EGRESS_PROXY_URL is required; this script never accepts a raw provider credential.');
    process.exitCode = 1;
    return;
  }

  const groupName = CONFIG.CODER.modelLabelGroup;
  const children = [CONFIG.CODER.localModelLabel, CONFIG.CODER.hostedModelLabel];

  console.log(`Grouping model labels [${children.join(', ')}] under "${groupName}"…`);
  for (const name of children) {
    const label = await getOrCreateGroupedIssueLabel(SENTINEL_TOKEN, groupName, name);
    console.log(`  ✓ "${name}" → group "${groupName}" (label ${label.id})`);
  }
  console.log(`Done. "${groupName}" now renders as a single-select dropdown on issues in Linear.`);
}

const organizationId = String(process.env.FLEET_ORG_ID || process.env.PROXY_ORG_ID || '').trim();
const projectId = String(process.env.AI_FLEET_PROJECT_ID || '').trim();

Promise.resolve(runWithWorkspaceContext({ organizationId, projectId }, groupLabels)).catch((err) => {
  console.error(`Failed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
