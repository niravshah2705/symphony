#!/usr/bin/env node
'use strict';

/**
 * One-off: create the "Models" issue-label GROUP in Linear and pull the
 * model-routing labels (local/hosted) into it, so Linear shows them as a
 * single-select dropdown on issues. Idempotent — re-running is a no-op once the
 * labels are already grouped.
 *
 * Uses the Linear API key from the store (Settings), or LINEAR_API_KEY from the
 * environment. Run from the repo root:
 *
 *   node scripts/models-label-group.js
 *   LINEAR_API_KEY=lin_api_xxx node scripts/models-label-group.js
 */

const { CONFIG } = require('@ai-fleet/shared/config');
const { getApiKey } = require('@ai-fleet/shared/store');
const { getOrCreateGroupedIssueLabel } = require('@ai-fleet/shared/linear');

async function main() {
  const apiKey = process.env.LINEAR_API_KEY || getApiKey();
  if (!apiKey) {
    console.error('No Linear API key. Set it in Settings or pass LINEAR_API_KEY=…');
    process.exitCode = 1;
    return;
  }

  const groupName = CONFIG.CODER.modelLabelGroup;
  const children = [CONFIG.CODER.localModelLabel, CONFIG.CODER.hostedModelLabel];

  console.log(`Grouping model labels [${children.join(', ')}] under "${groupName}"…`);
  for (const name of children) {
    const label = await getOrCreateGroupedIssueLabel(apiKey, groupName, name);
    console.log(`  ✓ "${name}" → group "${groupName}" (label ${label.id})`);
  }
  console.log(`Done. "${groupName}" now renders as a single-select dropdown on issues in Linear.`);
}

main().catch((err) => {
  console.error(`Failed: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
