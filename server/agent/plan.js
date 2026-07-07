'use strict';

const crypto = require('crypto');
const { PlanSchema, ViabilitySchema, ResumeSchema, normalizePlan } = require('./schema');
const { webSearch, webSearchMany, formatResults } = require('./search');
const { createChatModel } = require('./llm');
const framework = require('./framework');

/**
 * Software-design planning agent, built on the workflow-driven agent framework.
 *
 * The drafting step is now a framework workflow (`planning.workflow.js`): a
 * skill-loading deep agent (skills: software-planning + web-research; tools:
 * web_search) that produces a SOFTWARE DESIGN plan — engineering milestones and
 * buildable issues, NO go-to-market/business tasks. The surrounding pipeline is
 * unchanged so the safety model holds:
 *   1. Feasibility — is this a software product we can design and build?
 *   2. Grounded research (web_search) per design phase.
 *   3. Framework draft (skills-driven software design).
 *   4. Structured extraction → schema validation → deterministic apply (server
 *      disposes; the LLM never writes to Linear directly).
 * Each call is LangSmith-traced.
 */

class AgentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
  }
}

function configureTracing(keys) {
  const on = Boolean(keys.langsmithTracing && keys.langsmithApiKey);
  const flag = on ? 'true' : 'false';
  process.env.LANGSMITH_TRACING = flag;
  process.env.LANGCHAIN_TRACING_V2 = flag;
  if (on) {
    process.env.LANGSMITH_API_KEY = keys.langsmithApiKey;
    process.env.LANGCHAIN_API_KEY = keys.langsmithApiKey;
    process.env.LANGSMITH_PROJECT = keys.langsmithProject || 'linear-manager';
    process.env.LANGCHAIN_PROJECT = keys.langsmithProject || 'linear-manager';
    process.env.LANGSMITH_ENDPOINT = keys.langsmithEndpoint || 'https://api.smith.langchain.com';
    process.env.LANGCHAIN_ENDPOINT = keys.langsmithEndpoint || 'https://api.smith.langchain.com';
  }
  return on;
}

function projectContextBlock(project) {
  return [
    '<project_context>',
    `name: ${project.name || ''}`,
    `current_state: ${project.state || 'unknown'}`,
    `existing_description: ${project.description || '(none)'}`,
    `start_date: ${project.startDate || '(none)'}`,
    `target_date: ${project.targetDate || '(none)'}`,
    '</project_context>',
  ].join('\n');
}

function researchTopic(project) {
  // Keep it short — long queries return no web results.
  const words = String(project.description || '').split(/\s+/).slice(0, 4).join(' ');
  return `${project.name || ''} ${words}`.trim();
}

function buildFeasibilityPrompt({ project, today, searchText }) {
  return [
    'As a pragmatic tech lead, decide whether this project is a software product/system',
    'that can realistically be DESIGNED AND BUILT (an app, service, API, or platform).',
    '',
    'Return ONLY JSON: {"viable": boolean, "reason": string}.',
    '- viable=true if it is buildable software with a clear feature set to engineer.',
    '- viable=false if it is not software, is mainly physical/manual operations, or is',
    '  too vague to design and build.',
    `Today is ${today}.`,
    '',
    projectContextBlock(project),
    '',
    '<web_research>',
    searchText,
    '</web_research>',
  ].join('\n');
}

function buildDraftPrompt({ project, today, config }) {
  return [
    `Today is ${today}.`,
    `Produce at most ${config.maxMilestones} engineering milestones and at most`,
    `${config.maxIssuesPerMilestone} issues per milestone.`,
    'Follow your software-planning skill. Use web_search a FEW times (~5 total) to check',
    'sensible architecture and tech choices, then STOP calling tools and write the SOFTWARE',
    'DESIGN plan as text: engineering milestones (Architecture & Foundations, Data Model,',
    'Core Features, APIs & Integration, Quality & Hardening) with buildable issues and their',
    'acceptance criteria. Do NOT include go-to-market, marketing, branding, or business tasks,',
    'and do NOT include CI/CD, deployment, release, DevOps, or infrastructure/provisioning tasks.',
    '',
    projectContextBlock(project),
  ].join('\n');
}

function buildExtractPrompt({ project, today, config, draft, research }) {
  const shape = [
    '{',
    '  "description": string (>=10 chars; the software design/architecture overview),',
    '  "milestones": [',
    '    { "name": string, "description": string, "startDate": "YYYY-MM-DD",',
    '      "targetDate": "YYYY-MM-DD",',
    '      "evaluationCriteria": string (exit condition — how to verify this milestone is achieved),',
    '      "issues": [ { "title": string, "description": string, "priority": 0-4,',
    '        "evaluationCriteria": string (acceptance criteria / definition of done for this engineering task) } ] }',
    '  ],',
    '  "dependencies": [ { "fromMilestone": int, "fromIssue": int, "toMilestone": int, "toIssue": int } ]',
    '}',
  ].join('\n');

  return [
    'Return ONLY one JSON object (no prose) with exactly this shape:',
    shape,
    '',
    'This is a SOFTWARE DESIGN plan (engineering work), NOT a business/go-to-market plan.',
    'Milestones must be engineering phases (e.g. "Architecture & Foundations", "Data Model &',
    'Persistence", "Core Features", "APIs & Integration", "Quality & Hardening"). Every issue',
    'is a buildable engineering task with concrete acceptance criteria. NEVER include',
    'marketing, branding, sales, pricing, growth, or business-metric tasks, and NEVER',
    'include CI/CD, deployment, release, DevOps, or infrastructure/provisioning tasks.',
    'Use "dependencies" to link an issue to any issue that must land before it (acyclic).',
    `Constraints: at most ${config.maxMilestones} milestones and ${config.maxIssuesPerMilestone} issues each.`,
    `Dates valid YYYY-MM-DD, targetDate on/after startDate, start on/after ${today}.`,
    '',
    projectContextBlock(project),
    '',
    '<software_design_draft>',
    draft || '(no draft; derive the design from the project context and research)',
    '</software_design_draft>',
    '',
    '<web_research>',
    research,
    '</web_research>',
  ].join('\n');
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const { contentToText, messageText, lastText } = framework;

/**
 * Parse model JSON output, tolerating markdown fences and surrounding prose —
 * some local models wrap `format:'json'` output in ```json ... ``` regardless.
 */
function parseJsonLoose(text) {
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (_) {
    const block = s.match(/[{[][\s\S]*[}\]]/);
    if (block) return JSON.parse(block[0]);
    throw new Error('no JSON object found in model output');
  }
}

/** True when a provider descriptor has everything needed to run. */
function isLlmUsable(llm) {
  if (!llm || !llm.model) return false;
  if (llm.provider === 'codex') return Boolean(llm.accessToken && llm.baseUrl);
  if (llm.provider === 'claude') return Boolean(llm.accessToken);
  return Boolean(llm.host); // ollama / lmstudio (local, host-based)
}

/** One constrained JSON call to the active provider; returns the parsed object (throws on bad JSON). */
async function jsonCall(llm, prompt, runName, runId) {
  const model = createChatModel(llm, { json: true });
  const config = { runName: runName.slice(0, 60), tags: ['enrich', 'linear-manager'] };
  if (runId) config.runId = runId;
  let msg;
  try {
    msg = await model.invoke(prompt, config);
  } catch (err) {
    // Output hit the token budget (finish_reason: length) — the JSON is truncated.
    const m = err && err.message ? err.message : String(err);
    if (/length limit|max_tokens|finish_reason.*length/i.test(m)) {
      throw new Error(
        `output was truncated at the ${llm.numTokens}-token budget — raise "Num tokens" in Settings → LLM ` +
          '(reasoning models need extra headroom)'
      );
    }
    throw err;
  }
  // Reasoning-model-aware: falls back to reasoning_content when content is empty.
  const text = messageText(msg);
  if (!text || !text.trim()) {
    const usage = (msg.response_metadata && msg.response_metadata.usage) || {};
    const reasoning = (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;
    throw new Error(
      `model returned empty output${reasoning ? ` (${reasoning} reasoning tokens, no answer content)` : ''}` +
        ' — if this is a reasoning model, set the LM Studio JSON output mode to "Prompt-only (text)"'
    );
  }
  return parseJsonLoose(text);
}

function buildResumePrompt({ project, milestones, config, research }) {
  const list = milestones
    .map((m, i) => `${i + 1}. ${m.name}${m.description ? ` — ${String(m.description).slice(0, 160)}` : ''}`)
    .join('\n');
  const shape =
    '{ "milestones": [ { "name": string, "evaluationCriteria": string, "issues": [ { "title": string, "description": string, "priority": 0-4, "evaluationCriteria": string } ] } ] }';
  return [
    'You are a TECH LEAD. For EACH existing milestone listed below, produce concrete',
    'SOFTWARE engineering tasks (issues) to accomplish it. Do NOT invent business/GTM tasks.',
    `Return ONLY JSON: ${shape}`,
    'Give every milestone a measurable evaluationCriteria, and every issue an',
    'acceptance-criteria (evaluationCriteria = definition of done).',
    `Return one entry per milestone, in the SAME ORDER and with the same "name".`,
    `At most ${config.maxIssuesPerMilestone} tasks per milestone.`,
    '',
    'Existing milestones:',
    list,
    '',
    projectContextBlock(project),
    '',
    '<web_research>',
    research,
    '</web_research>',
  ].join('\n');
}

/**
 * Resume path: given a project's EXISTING milestones, research and generate the
 * tasks (issues) for them. Returns tasks per milestone (same order as input).
 */
async function generateIssuesForMilestones({ project, milestones, config, llm, keys, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  if (!isLlmUsable(llm)) {
    throw new AgentError('Configure the deep-agent LLM in Settings → LLM.', 400);
  }
  const traced = configureTracing(keys);
  const runId = crypto.randomUUID();

  step(`Reviewing ${milestones.length} existing milestone(s); researching tasks in parallel…`);
  const scoped = milestones.slice(0, 6);
  const resumeResults = await webSearchMany(
    scoped.map((m) => `${project.name || ''} ${m.name} implementation tasks checklist`.trim()),
    3
  ); // concurrent
  const research = resumeResults
    .map((r, i) => {
      step(`🔎 web search: "${r.query}" (${r.snippets.length} results)`);
      return `## ${scoped[i].name}\n${formatResults(r.snippets)}`;
    })
    .join('\n\n');

  step('Requesting tasks for existing milestones (format=json)…');
  let raw;
  try {
    raw = await jsonCall(llm, buildResumePrompt({ project, milestones, config, research }), `resume-json:${project.name}`, runId);
  } catch (err) {
    throw new AgentError(`The model did not return valid tasks: ${err && err.message ? err.message : err}`, 502);
  }
  const parsed = ResumeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentError(`Tasks failed validation: ${parsed.error.issues[0].message}`, 502);
  }
  const maxIssues = Math.max(0, config.maxIssuesPerMilestone || 5);
  const genMilestones = parsed.data.milestones.map((m) => ({ name: m.name, issues: m.issues.slice(0, maxIssues) }));
  const issueCount = genMilestones.reduce((n, m) => n + m.issues.length, 0);
  step(`Generated ${issueCount} task(s) for ${genMilestones.length} milestone(s).`);

  const traceUrl = traced ? await resolveTraceUrl(runId, keys).catch(() => null) : null;
  return { milestones: genMilestones, traceUrl, traced };
}

/**
 * Run the software-design planning agent.
 * @returns {Promise<{ viable:boolean, reason?:string, plan?:object, traceUrl:string|null, runId:string, traced:boolean }>}
 */
async function generatePlan({ project, assumedRole, config, llm, keys, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  if (!isLlmUsable(llm)) {
    throw new AgentError('Configure the deep-agent LLM in Settings → LLM.', 400);
  }

  const traced = configureTracing(keys);
  step(`Tracing ${traced ? 'enabled' : 'disabled'}; provider ${llm.provider}, model ${llm.model}${llm.host ? ` @ ${llm.host}` : ''}`);

  const today = todayIso();
  const topic = researchTopic(project);
  const runId = crypto.randomUUID();
  const traceMeta = {
    runName: `enrich:${project.name}`.slice(0, 60),
    tags: ['enrich', 'linear-manager'],
    metadata: { projectId: project.id, assumedRole: assumedRole ? assumedRole.id : null },
  };
  const finishTrace = async () => (traced ? resolveTraceUrl(runId, keys).catch(() => null) : null);

  // ---- Step 1: feasibility (web research + verdict) ----
  step('Assessing software feasibility (web research)…');
  const feasQuery = `${topic} software architecture how to build feasibility`;
  const feasResults = await webSearch(feasQuery, 5);
  step(`🔎 web search: "${feasQuery}" (${feasResults.length} results)`);

  let viable = true;
  let reason = 'Feasibility check inconclusive; proceeding.';
  try {
    const raw = await jsonCall(llm, buildFeasibilityPrompt({ project, today, searchText: formatResults(feasResults) }), `feasibility:${project.name}`);
    const parsed = ViabilitySchema.safeParse(raw);
    if (parsed.success) {
      viable = parsed.data.viable;
      reason = parsed.data.reason;
    } else {
      step('Feasibility response invalid; proceeding by default.', 'warn');
    }
  } catch (err) {
    step(`Feasibility check failed (${err && err.message ? err.message.slice(0, 100) : err}); proceeding.`, 'warn');
  }

  if (!viable) {
    step(`Not buildable: ${reason.slice(0, 160)}`, 'warn');
    return { viable: false, reason, traceUrl: await finishTrace(), runId, traced };
  }
  step(`Buildable: ${reason.slice(0, 160)}`);

  // ---- Step 2: per-phase engineering research (grounds the design) ----
  step('Researching software design in parallel (architecture, features, testing)…');
  const phaseQueries = [
    { label: 'Architecture & stack', q: `${topic} recommended architecture tech stack` },
    { label: 'Core features', q: `${topic} core features to build MVP` },
    { label: 'Testing & quality', q: `${topic} testing strategy best practices` },
  ];
  const phaseResults = await webSearchMany(phaseQueries.map((p) => p.q), 4); // concurrent
  const research = phaseResults
    .map((r, i) => {
      step(`🔎 web search: "${r.query}" (${r.snippets.length} results)`);
      return `## ${phaseQueries[i].label}\n${formatResults(r.snippets)}`;
    })
    .join('\n\n');

  // ---- Step 3: framework draft (software-design planner workflow) ----
  let draft = '';
  step('Drafting software design (planning workflow: skills + web_search)…');
  try {
    const workflow = framework.loadWorkflow('planning');
    const { finalText } = await framework.runWorkflow({
      workflow,
      llm,
      userMessage: buildDraftPrompt({ project, today, config }),
      ctx: { step },
      invokeConfig: { runId, ...traceMeta },
    });
    draft = finalText;
    step(`Planning workflow draft ready (${draft.length} chars).`);
  } catch (err) {
    draft = '';
    step(`Planning workflow skipped: ${err && err.message ? err.message.slice(0, 120) : err}`, 'warn');
  }

  // ---- Step 4: structured software-design plan ----
  step('Requesting structured software-design plan (format=json)…');
  let raw;
  try {
    raw = await jsonCall(llm, buildExtractPrompt({ project, today, config, draft, research }), `enrich-json:${project.name}`);
  } catch (err) {
    throw new AgentError(`The model did not return a valid plan: ${err && err.message ? err.message : err}`, 502);
  }

  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentError(`Plan failed validation: ${parsed.error.issues[0].message}`, 502);
  }
  const plan = normalizePlan(parsed.data, {
    maxMilestones: config.maxMilestones,
    maxIssuesPerMilestone: config.maxIssuesPerMilestone,
  });
  const issueCount = plan.milestones.reduce((n, m) => n + m.issues.length, 0);
  step(`Plan ready: ${plan.milestones.length} milestones, ${issueCount} issues, ${plan.dependencies.length} dependencies.`);

  return { viable: true, plan, traceUrl: await finishTrace(), runId, traced };
}

async function resolveTraceUrl(runId, keys) {
  const { Client } = require('langsmith');
  const client = new Client({ apiKey: keys.langsmithApiKey, apiUrl: keys.langsmithEndpoint });
  try {
    return await client.getRunUrl({ runId });
  } catch (_) {
    return await client.getProjectUrl({ projectName: keys.langsmithProject || 'linear-manager' });
  }
}

module.exports = { AgentError, generatePlan, generateIssuesForMilestones, configureTracing };
