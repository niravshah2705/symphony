'use strict';

const { z } = require('zod');

/**
 * Structured output contract for the enrichment deep agent.
 *
 * Security: the LLM output is untrusted. We validate it against this schema
 * (schema validation per ai-prompt-injection checklist) and additionally
 * normalize/clamp it before any Linear write, so a hallucinated or
 * injection-influenced response cannot create unbounded resources or
 * reference out-of-range dependency indices.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL'];

/** Clamp a model-provided size to a valid T-shirt size (uppercase); default 'M'. */
function normalizeTshirtSize(size) {
  const s = String(size || '').trim().toUpperCase();
  return TSHIRT_SIZES.includes(s) ? s : 'M';
}

const IssueSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().max(8000).default(''),
  priority: z.number().int().min(0).max(4).default(3),
  // Acceptance / definition-of-done for this feature/issue.
  evaluationCriteria: z.string().max(2400).default(''),
  estimateDays: z.number().int().min(1).max(90).optional(),
  // Relative effort/complexity; drives model routing at code time (XS → local
  // agent, larger → hosted). Kept a plain string here (tolerant of messy local-model
  // output and JSON-Schema-representable); clamped to a valid size at write time via
  // normalizeTshirtSize.
  tshirtSize: z.string().max(20).default('M'),
});

const MilestoneSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(2000).default(''),
  startDate: z.string().regex(DATE_RE, 'startDate must be YYYY-MM-DD'),
  targetDate: z.string().regex(DATE_RE, 'targetDate must be YYYY-MM-DD'),
  // How to measure this milestone is achieved (success/exit criteria).
  evaluationCriteria: z.string().max(1500).default(''),
  issues: z.array(IssueSchema).default([]),
});

const DependencySchema = z.object({
  fromMilestone: z.number().int().min(0),
  fromIssue: z.number().int().min(0),
  toMilestone: z.number().int().min(0),
  toIssue: z.number().int().min(0),
  reason: z.string().max(300).optional(),
});

const PlanSchema = z.object({
  description: z.string().min(10).max(6000),
  milestones: z.array(MilestoneSchema).min(1),
  dependencies: z.array(DependencySchema).default([]),
});

/** Business-owner viability verdict for a project (step 1 of planning). */
const ViabilitySchema = z.object({
  viable: z.boolean(),
  reason: z.string().min(3).max(800),
});

/** Tasks generated for existing milestones (resume path). */
const ResumeSchema = z.object({
  milestones: z.array(
    z.object({
      name: z.string(),
      evaluationCriteria: z.string().max(1500).default(''),
      issues: z.array(IssueSchema).default([]),
    })
  ),
});

/** Convert the Zod schema to plain JSON Schema for the LLM response format. */
function planJsonSchema() {
  return z.toJSONSchema(PlanSchema);
}

/**
 * Clamp and sanitize a validated plan to the configured limits and drop
 * dependencies whose indices fall outside the milestone/issue matrix.
 * @param {import('zod').infer<typeof PlanSchema>} plan
 * @param {{ maxMilestones: number, maxIssuesPerMilestone: number }} limits
 */
function normalizePlan(plan, limits) {
  const maxMilestones = Math.max(1, limits.maxMilestones || 6);
  const maxIssues = Math.max(0, limits.maxIssuesPerMilestone || 5);

  const milestones = plan.milestones.slice(0, maxMilestones).map((m) => ({
    ...m,
    // Ensure target is not before start; if so, swap to keep a valid range.
    ...normalizeDates(m.startDate, m.targetDate),
    issues: m.issues.slice(0, maxIssues),
  }));

  const dependencies = (plan.dependencies || []).filter((d) => {
    const from = milestones[d.fromMilestone];
    const to = milestones[d.toMilestone];
    if (!from || !to) return false;
    if (!from.issues[d.fromIssue] || !to.issues[d.toIssue]) return false;
    // No self-dependency.
    return !(d.fromMilestone === d.toMilestone && d.fromIssue === d.toIssue);
  });

  return { description: plan.description, milestones, dependencies };
}

function normalizeDates(startDate, targetDate) {
  if (startDate && targetDate && targetDate < startDate) {
    return { startDate: targetDate, targetDate: startDate };
  }
  return { startDate, targetDate };
}

module.exports = {
  PlanSchema,
  ViabilitySchema,
  ResumeSchema,
  planJsonSchema,
  normalizePlan,
  normalizeTshirtSize,
  TSHIRT_SIZES,
};
