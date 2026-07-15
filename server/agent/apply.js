'use strict';

const linear = require('../linear');
const { CONFIG } = require('../config');
const { normalizeTshirtSize } = require('./schema');

/**
 * Resolve the AI task-label id once per apply run so every created issue can be
 * stamped with it (Step 2: software-design issues are marked with the AI label,
 * which the coder board monitor picks up in Step 3). Best-effort: on failure we
 * return null and issues are created unlabeled rather than aborting the plan.
 */
async function resolveTaskLabelId(apiKey, step) {
  try {
    const label = await linear.getOrCreateIssueLabel(apiKey, CONFIG.CODER.taskLabel);
    return label.id;
  } catch (err) {
    step(`Could not resolve "${CONFIG.CODER.taskLabel}" issue label: ${errMsg(err)}`, 'warn');
    return null;
  }
}

/** Append a labelled criteria block to a description (no-op if empty). */
function withCriteria(base, label, criteria) {
  const b = base || '';
  if (!criteria) return b;
  return `${b ? `${b}\n\n` : ''}**${label}:** ${criteria}`;
}

/** The model-routing label for a T-shirt size: XS → local, everything larger → hosted. */
function modelLabelForSize(size) {
  return size === String(CONFIG.CODER.localSize).toUpperCase() ? CONFIG.CODER.localModelLabel : CONFIG.CODER.hostedModelLabel;
}

/**
 * Memoized issue-label resolver: getOrCreate each distinct label name once per
 * apply run and cache its id. Best-effort — a failure caches null so the issue is
 * created without that label rather than aborting the whole plan.
 */
function makeLabelResolver(apiKey, step) {
  const cache = new Map();
  return async (name) => {
    if (!name) return null;
    if (cache.has(name)) return cache.get(name);
    try {
      const label = await linear.getOrCreateIssueLabel(apiKey, name);
      cache.set(name, label.id);
      return label.id;
    } catch (err) {
      step(`Could not resolve "${name}" issue label: ${errMsg(err)}`, 'warn');
      cache.set(name, null);
      return null;
    }
  };
}

/**
 * Memoized resolver for the model-routing label (local/hosted), resolved as a
 * member of the "Models" label group so Linear shows it as a single-select
 * dropdown on the issue. Best-effort: on failure it falls back to an ungrouped
 * label, then to null, so a labelling hiccup never aborts issue creation.
 */
function makeModelLabelResolver(apiKey, step) {
  const cache = new Map();
  const groupName = CONFIG.CODER.modelLabelGroup;
  return async (name) => {
    if (!name) return null;
    if (cache.has(name)) return cache.get(name);
    let id = null;
    try {
      id = (await linear.getOrCreateGroupedIssueLabel(apiKey, groupName, name)).id;
    } catch (err) {
      step(`Could not group "${name}" under "${groupName}": ${errMsg(err)}`, 'warn');
      try {
        id = (await linear.getOrCreateIssueLabel(apiKey, name)).id;
      } catch (err2) {
        step(`Could not resolve "${name}" issue label: ${errMsg(err2)}`, 'warn');
      }
    }
    cache.set(name, id);
    return id;
  };
}

/** Label ids to stamp on an issue: task label + T-shirt size + model-routing label. */
async function issueLabelIds(resolveLabel, resolveModelLabel, taskLabelId, size) {
  const sizeName = normalizeTshirtSize(size); // always a valid XS|S|M|L|XL
  const [sizeId, modelId] = await Promise.all([
    resolveLabel(sizeName),
    resolveModelLabel(modelLabelForSize(sizeName)),
  ]);
  return [taskLabelId, sizeId, modelId].filter(Boolean);
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
  const taskLabelId = config.createIssues ? await resolveTaskLabelId(apiKey, step) : null;
  const resolveLabel = makeLabelResolver(apiKey, step);
  const resolveModelLabel = makeModelLabelResolver(apiKey, step);

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
          const labelIds = await issueLabelIds(resolveLabel, resolveModelLabel, taskLabelId, issue.tshirtSize);
          const created = await linear.createIssue(apiKey, {
            teamId: team.id,
            projectId: project.id,
            projectMilestoneId: createdMilestone.id,
            title: issue.title,
            description: withCriteria(issue.description, 'Acceptance criteria', issue.evaluationCriteria),
            priority: issue.priority,
            labelIds: labelIds.length ? labelIds : undefined,
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
  const taskLabelId = await resolveTaskLabelId(apiKey, step);
  const resolveLabel = makeLabelResolver(apiKey, step);
  const resolveModelLabel = makeModelLabelResolver(apiKey, step);

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
        const labelIds = await issueLabelIds(resolveLabel, resolveModelLabel, taskLabelId, issue.tshirtSize);
        await linear.createIssue(apiKey, {
          teamId: team.id,
          projectId: project.id,
          projectMilestoneId: milestone.id,
          title: issue.title,
          description: withCriteria(issue.description, 'Acceptance criteria', issue.evaluationCriteria),
          priority: issue.priority,
          labelIds: labelIds.length ? labelIds : undefined,
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
 * Mark a project as PLANNED: switch its label to `aiplanned` (replacing the enrich
 * label). This both drops the project out of the planning set and signals the
 * coding flow to start working its tasks in dependency order.
 */
async function applyAiplanned(apiKey, { project, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  try {
    const label = await linear.getOrCreateProjectLabel(apiKey, 'aiplanned');
    await linear.setProjectLabels(apiKey, project.id, [label.id]);
    step('Set project label to "aiplanned".');
  } catch (err) {
    step(`aiplanned label failed: ${errMsg(err)}`, 'warn');
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

/* --------------------- Coder issue state transitions -------------------- */

/**
 * Move a coder task to "In Progress" (a `started` state) before the agent runs.
 * Idempotent: an issue already started/completed is left as-is. Returns the
 * resulting state (or null if the team has no started state).
 */
async function startIssue(apiKey, { issueId, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const detail = await linear.getIssueDetail(apiKey, issueId);
  const type = detail.state && detail.state.type;
  if (type === 'started' || type === 'completed' || type === 'canceled') {
    return detail.state || null; // already in/after progress — nothing to do
  }
  const target = linear.pickStateByType(await linear.getTeamStates(apiKey, detail.team.id), 'started', 'In Progress');
  if (!target) {
    step('No "In Progress" workflow state on this team; leaving state unchanged.', 'warn');
    return detail.state || null;
  }
  await linear.updateIssue(apiKey, issueId, { stateId: target.id });
  step(`Moved issue to "${target.name}".`);
  return target;
}

/**
 * Finish a coder task per the agent's verdict: move it to Done (a `completed`
 * state) and stamp the outcome label on the ISSUE — `aidone` when completed,
 * `aifail` when insufficient — creating the label if missing and appending it to
 * the issue's existing labels. An insufficient reason is posted as a comment.
 */
async function finishIssue(apiKey, { issueId, outcome, reason, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const labelName = outcome === 'completed' ? 'aidone' : 'aifail';
  const detail = await linear.getIssueDetail(apiKey, issueId);

  // Resolve (create-if-missing) the outcome label, appended to existing labels.
  let labelIds;
  try {
    const label = await linear.getOrCreateIssueLabel(apiKey, labelName);
    const current = (detail.labels && detail.labels.nodes ? detail.labels.nodes : []).map((l) => l.id);
    labelIds = [...new Set([...current, label.id])];
  } catch (err) {
    step(`Could not resolve "${labelName}" issue label: ${errMsg(err)}`, 'warn');
  }

  const done = linear.pickStateByType(await linear.getTeamStates(apiKey, detail.team.id), 'completed', 'Done');
  const input = {};
  if (done) input.stateId = done.id;
  if (labelIds) input.labelIds = labelIds;
  if (Object.keys(input).length) await linear.updateIssue(apiKey, issueId, input);
  step(`Marked issue ${done ? `"${done.name}"` : '(no Done state found)'} + label "${labelName}".`);

  // Record the reason a task was judged insufficient (for the human triaging it).
  if (outcome !== 'completed' && reason) {
    try {
      await linear.createComment(apiKey, { issueId, body: `**AI coder — insufficient to complete.**\n\n${reason}` });
      step('Posted insufficiency reason as a comment.');
    } catch (err) {
      step(`Comment failed: ${errMsg(err)}`, 'warn');
    }
  }
  return { labelName, done: Boolean(done) };
}

function safeAt(matrix, i, j) {
  return matrix[i] && matrix[i][j] ? matrix[i][j] : null;
}

function errMsg(err) {
  return err && err.message ? err.message : String(err);
}

module.exports = { applyPlan, applyIssuesForMilestones, applyAidone, applyAiplanned, applyAifail, startIssue, finishIssue };
