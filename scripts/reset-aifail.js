#!/usr/bin/env node
'use strict';

/*
 * One-off maintenance: find every Linear issue labelled `aifail`, move it to its
 * team's Backlog state, and strip the `aifail` label so the coder monitor can
 * pick it up again (the monitor only selects non-terminal issues, and a failed
 * run leaves the issue in a completed state).
 *
 *   node scripts/reset-aifail.js           # dry run — list affected issues only
 *   node scripts/reset-aifail.js --apply   # perform the state + label changes
 */

const linear = require('../packages/shared/src/linear');
const store = require('../packages/shared/src/store');

const FAIL_LABEL = 'aifail';
const APPLY = process.argv.includes('--apply');

const AIFAIL_ISSUES_QUERY = `
  query AifailIssues($label: String!, $first: Int!) {
    issues(first: $first, filter: { labels: { name: { eq: $label } } }) {
      nodes {
        id identifier title url
        state { id name type }
        team { id name }
        labels(first: 50) { nodes { id name } }
      }
    }
  }`;

async function main() {
  const data = store.readStore();
  const apiKey = data && data.settings && data.settings.linearApiKey;
  if (!apiKey) throw new Error('No linearApiKey configured in the store.');

  const res = await linear.linearRequest(apiKey, AIFAIL_ISSUES_QUERY, { label: FAIL_LABEL, first: 250 });
  const issues = (res && res.issues && res.issues.nodes) || [];

  if (!issues.length) {
    console.log(`No issues carry the "${FAIL_LABEL}" label. Nothing to do.`);
    return;
  }

  console.log(`Found ${issues.length} issue(s) labelled "${FAIL_LABEL}":\n`);

  // Cache Backlog state per team so we hit getTeamStates once per team.
  const backlogByTeam = new Map();
  async function backlogStateFor(team) {
    if (!team || !team.id) throw new Error('issue has no team');
    if (backlogByTeam.has(team.id)) return backlogByTeam.get(team.id);
    const states = await linear.getTeamStates(apiKey, team.id);
    const backlog = linear.pickStateByType(states, 'backlog', 'Backlog');
    if (!backlog) throw new Error(`team "${team.name}" has no Backlog-type state`);
    backlogByTeam.set(team.id, backlog);
    return backlog;
  }

  let changed = 0;
  for (const issue of issues) {
    const labels = (issue.labels && issue.labels.nodes) || [];
    const keptLabelIds = labels.filter((l) => l.name !== FAIL_LABEL).map((l) => l.id);
    const backlog = await backlogStateFor(issue.team);
    const from = `${issue.state.name} (${issue.state.type})`;
    console.log(
      `  ${issue.identifier}  ${from} → Backlog | ` +
      `labels: [${labels.map((l) => l.name).join(', ')}] → [${labels.filter((l) => l.name !== FAIL_LABEL).map((l) => l.name).join(', ')}]  ` +
      `— ${issue.title.slice(0, 60)}`
    );
    if (APPLY) {
      await linear.updateIssue(apiKey, issue.id, { stateId: backlog.id, labelIds: keptLabelIds });
      changed += 1;
    }
  }

  console.log('');
  if (APPLY) {
    console.log(`✅ Updated ${changed} issue(s): moved to Backlog and removed "${FAIL_LABEL}".`);
  } else {
    console.log(`Dry run only. Re-run with --apply to perform these ${issues.length} change(s).`);
  }
}

main().catch((err) => {
  console.error('reset-aifail failed:', err && err.message ? err.message : err);
  process.exit(1);
});
