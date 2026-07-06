'use strict';

const linear = require('../linear');

/** Append a labelled criteria block to a description (no-op if empty). */
function withCriteria(base, label, criteria) {
  const b = base || '';
  if (!criteria) return b;
  return `${b ? `${b}\n\n` : ''}**${label}:** ${criteria}`;
}

/**
 * Apply a validated, normalized enrichment plan to a Linear project using the
 * stored Linear token. Writes are deterministic (not performed by the LLM):
 * the LLM proposes, the server disposes — a hard guardrail per the
 * ai-prompt-injection checklist (no autonomous destructive tool calls).
 *
 * Resilient: a single milestone/issue/dependency failure is recorded as a
 * warning and does not abort the rest of the plan.
 */
async function applyPlan(apiKey, { project, plan, assumedRole, config, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const warnings = [];
  const summary = { milestonesCreated: 0, issuesCreated: 0, dependenciesCreated: 0, warnings };

  const { team } = await linear.getProjectTeam(apiKey, project.id);
  step(`Applying plan to Linear (team ${team.key || team.name}).`);

  // 1. Assign the assumed role as project lead (claims the open project).
  if (config.autoAssignLead && assumedRole && assumedRole.id) {
    try {
      await linear.setProjectLead(apiKey, project.id, assumedRole.id);
      step(`Assigned lead: ${assumedRole.name}.`);
    } catch (err) {
      warnings.push(`Lead assignment failed: ${errMsg(err)}`);
      step(`Lead assignment failed: ${errMsg(err)}`, 'warn');
    }
  }

  // 2. Enrich the project description.
  try {
    await linear.updateProjectDescription(apiKey, project.id, plan.description);
    step('Updated project description.');
  } catch (err) {
    warnings.push(`Description update failed: ${errMsg(err)}`);
    step(`Description update failed: ${errMsg(err)}`, 'warn');
  }

  // 3. Create milestones. Linear milestones only carry a targetDate, so the
  //    start date is preserved in the description as an explicit timeline line.
  const issueIdMatrix = []; // [milestoneIndex][issueIndex] -> issueId
  for (const milestone of plan.milestones) {
    const timelineNote = `**Timeline:** ${milestone.startDate} → ${milestone.targetDate}`;
    let description = milestone.description ? `${timelineNote}\n\n${milestone.description}` : timelineNote;
    description = withCriteria(description, 'Evaluation criteria', milestone.evaluationCriteria);

    let createdMilestone = null;
    try {
      createdMilestone = await linear.createMilestone(apiKey, {
        projectId: project.id,
        name: milestone.name,
        description,
        targetDate: milestone.targetDate,
      });
      summary.milestonesCreated += 1;
      step(`Created milestone: ${milestone.name} (${milestone.startDate} → ${milestone.targetDate}).`);
    } catch (err) {
      warnings.push(`Milestone "${milestone.name}" failed: ${errMsg(err)}`);
      step(`Milestone "${milestone.name}" failed: ${errMsg(err)}`, 'warn');
      issueIdMatrix.push([]);
      continue;
    }

    // 4. Create issues for this milestone.
    const issueIds = [];
    if (config.createIssues) {
      for (const issue of milestone.issues) {
        try {
          const created = await linear.createIssue(apiKey, {
            teamId: team.id,
            projectId: project.id,
            projectMilestoneId: createdMilestone.id,
            title: issue.title,
            description: withCriteria(issue.description, 'Acceptance criteria', issue.evaluationCriteria),
            priority: issue.priority,
          });
          issueIds.push(created.id);
          summary.issuesCreated += 1;
        } catch (err) {
          issueIds.push(null);
          warnings.push(`Issue "${issue.title}" failed: ${errMsg(err)}`);
          step(`Issue "${issue.title}" failed: ${errMsg(err)}`, 'warn');
        }
      }
      const ok = issueIds.filter(Boolean).length;
      if (ok) step(`Created ${ok} issue(s) under "${milestone.name}".`);
    }
    issueIdMatrix.push(issueIds);
  }

  // 5. Create dependencies (from blocks to). Indices were already validated in
  //    normalizePlan; we re-check the resolved IDs before writing.
  if (config.addDependencies && config.createIssues) {
    for (const dep of plan.dependencies) {
      const fromId = safeAt(issueIdMatrix, dep.fromMilestone, dep.fromIssue);
      const toId = safeAt(issueIdMatrix, dep.toMilestone, dep.toIssue);
      if (!fromId || !toId || fromId === toId) continue;
      try {
        await linear.createIssueRelation(apiKey, {
          issueId: fromId,
          relatedIssueId: toId,
          type: 'blocks',
        });
        summary.dependenciesCreated += 1;
      } catch (err) {
        warnings.push(`Dependency failed: ${errMsg(err)}`);
        step(`Dependency failed: ${errMsg(err)}`, 'warn');
      }
    }
    if (summary.dependenciesCreated) step(`Created ${summary.dependenciesCreated} dependency link(s).`);
  }

  return summary;
}

/**
 * Resume path: create issues for EXISTING milestones that currently have none.
 * `generated` holds tasks per milestone (same order as `milestones`); matched by
 * index, then by name as a fallback.
 */
async function applyIssuesForMilestones(apiKey, { project, milestones, generated, config, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const warnings = [];
  const summary = { milestonesCreated: 0, issuesCreated: 0, dependenciesCreated: 0, warnings, resumed: true };
  if (!config.createIssues) return summary;

  const { team } = await linear.getProjectTeam(apiKey, project.id);
  step(`Creating tasks for ${milestones.length} milestone(s) (team ${team.key || team.name}).`);

  for (let i = 0; i < milestones.length; i += 1) {
    const milestone = milestones[i];
    const match = generated[i] || generated.find((g) => (g.name || '').toLowerCase() === (milestone.name || '').toLowerCase());
    const issues = (match && match.issues) || [];

    // Add the milestone's evaluation criteria to its description (if any).
    if (match && match.evaluationCriteria) {
      try {
        await linear.updateMilestone(apiKey, {
          id: milestone.id,
          description: withCriteria(milestone.description, 'Evaluation criteria', match.evaluationCriteria),
        });
        step(`Added evaluation criteria to "${milestone.name}".`);
      } catch (err) {
        warnings.push(`Milestone criteria update failed: ${errMsg(err)}`);
      }
    }

    let created = 0;
    for (const issue of issues) {
      try {
        await linear.createIssue(apiKey, {
          teamId: team.id,
          projectId: project.id,
          projectMilestoneId: milestone.id,
          title: issue.title,
          description: withCriteria(issue.description, 'Acceptance criteria', issue.evaluationCriteria),
          priority: issue.priority,
        });
        created += 1;
        summary.issuesCreated += 1;
      } catch (err) {
        warnings.push(`Issue "${issue.title}" failed: ${errMsg(err)}`);
        step(`Issue "${issue.title}" failed: ${errMsg(err)}`, 'warn');
      }
    }
    if (created) step(`Created ${created} task(s) under "${milestone.name}".`);
  }
  return summary;
}

/** Mark a project complete: switch its label to `aidone` (replacing others). */
async function applyAidone(apiKey, { project, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  try {
    const label = await linear.getOrCreateProjectLabel(apiKey, 'aidone');
    await linear.setProjectLabels(apiKey, project.id, [label.id]);
    step('Set project label to "aidone".');
  } catch (err) {
    step(`aidone label failed: ${errMsg(err)}`, 'warn');
  }
}

/**
 * Handle a project the business-owner agent judged NOT viable: append a note to
 * the project description and switch its label to `aifail` (replacing existing
 * labels so it leaves the enrichment set and is not retried).
 */
async function applyAifail(apiKey, { project, reason, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const note = `\n\n---\n**AI viability check — not a fit for a software-driven solution.**\nReason: ${reason}`;
  const nextDescription = `${project.description || ''}${note}`.trim();

  try {
    await linear.updateProjectDescription(apiKey, project.id, nextDescription);
    step('Added viability note to project description.');
  } catch (err) {
    step(`Description note failed: ${errMsg(err)}`, 'warn');
  }

  try {
    const label = await linear.getOrCreateProjectLabel(apiKey, 'aifail');
    await linear.setProjectLabels(apiKey, project.id, [label.id]);
    step('Set project label to "aifail".');
  } catch (err) {
    step(`Label update failed: ${errMsg(err)}`, 'warn');
  }

  return { aifail: true, reason, milestonesCreated: 0, issuesCreated: 0, dependenciesCreated: 0, warnings: [] };
}

function safeAt(matrix, i, j) {
  return matrix[i] && matrix[i][j] ? matrix[i][j] : null;
}

function errMsg(err) {
  return err && err.message ? err.message : String(err);
}

module.exports = { applyPlan, applyIssuesForMilestones, applyAidone, applyAifail };
