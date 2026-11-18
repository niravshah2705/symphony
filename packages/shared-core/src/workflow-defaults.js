'use strict';

// Platform-global default settings for the workflow designer (schema v2).
// These fixtures are the copy-source for tenant onboarding: every entry is a
// plain, frozen template that the gateway clones into the tenant's Firestore
// collections (`agents`, `workflows`, `personaGrants`) on first load, and the
// `defaults*` API lets org admins re-copy any single component later.
//
// The per-tenant copies live in aifleet_workspace_<hash>; this module is the
// single code-side source of truth shipped with the deployable (the Firestore
// `aifleet__workflow_defaults` root mirrors it for runtime edits without a
// redeploy, and falls back here when a collection is absent).

const { DEFAULT_PERSONA_GRANTS, PERSONAS } = require('./workflow/model.js');

const WORKFLOW_DEFAULTS_VERSION = 1;
const DEFAULTS_NAMESPACE_COLLECTION = 'aifleet__workflow_defaults';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function profile(input) {
  return {
    schemaVersion: 2,
    custom: false,
    backend: 'substrate',
    harness: '',
    modelFamily: '',
    taskTier: 'medium',
    connectors: [],
    systemPrompt: '',
    kagent: null,
    ...input,
  };
}

// Kagent binding defaults applied to Builder/SRE execution profiles: the
// cluster's shared ModelConfig plus a conservative env set. Skills/plugins
// stay empty until an operator pins immutable OCI sources per tenant.
function kagentBinding(model) {
  return {
    modelConfig: { name: 'default-model-config' },
    skills: [],
    plugins: [],
    tools: [],
    env: [{ name: 'LOG_LEVEL', value: 'info' }, ...(model ? [{ name: 'AGENT_MODEL', value: model }] : [])],
    egressPolicyRefs: [],
  };
}

// 17 curated delivery agents + the 5 ADLC palette roles sketched in the
// code.html design (Ideation, Engineering, Quality, Deployment, Monitoring).
const DEFAULT_AGENT_PROFILES = deepFreeze([
  profile({ id: 'requirements', name: 'Requirements Agent', category: 'Requirements', persona: 'product-designer', purpose: 'Turns a change request into scoped, testable acceptance criteria.', inputs: ['Change request', 'Product constraints'], outputs: ['Requirements brief', 'Acceptance criteria'], guardrails: ['Flag ambiguity', 'Do not invent customer commitments'], tools: ['linear'], taskTier: 'complex' }),
  profile({ id: 'ideation', name: 'Ideation Agent', category: 'Ideation', persona: 'product-designer', purpose: 'Explores problem spaces and drafts candidate directions for the Specs gate.', inputs: ['Market signal', 'Customer feedback'], outputs: ['Opportunity brief', 'Candidate directions'], guardrails: ['Label speculation', 'Keep options decision-ready'], tools: ['web-search'], taskTier: 'complex', systemPrompt: 'You are the Ideation stage of the ADLC canvas. Produce opportunity briefs that the Specs gate can assess; separate evidence from speculation.' }),
  profile({ id: 'research', name: 'Research Agent', category: 'Research', persona: 'product-designer', purpose: 'Investigates a question across approved internal and public sources.', inputs: ['Research question', 'Source policy'], outputs: ['Evidence set', 'Open questions'], guardrails: ['Separate evidence from inference', 'Respect source access rules'], tools: ['web-search'], taskTier: 'medium' }),
  profile({ id: 'source-verification', name: 'Source Verification Agent', category: 'Source verification', persona: 'product-designer', purpose: 'Checks provenance, freshness, and claim support before synthesis.', inputs: ['Evidence set'], outputs: ['Verified source ledger', 'Rejected claims'], guardrails: ['Require traceable sources', 'Surface conflicting evidence'], tools: ['web-search'], taskTier: 'easy' }),
  profile({ id: 'commercial-strategy', name: 'Commercial Strategy Agent', category: 'Commercial strategy', persona: 'product-designer', purpose: 'Assesses positioning, segments, and go-to-market tradeoffs.', inputs: ['Market evidence', 'Product capabilities'], outputs: ['Commercial recommendation', 'Assumptions'], guardrails: ['Label uncertain projections', 'Avoid unsupported competitor claims'], tools: ['market-data'], taskTier: 'complex' }),
  profile({ id: 'pricing', name: 'Pricing Agent', category: 'Pricing', persona: 'product-designer', purpose: 'Models pricing options against customer value and unit economics.', inputs: ['Segment analysis', 'Cost assumptions'], outputs: ['Pricing scenarios', 'Sensitivity notes'], guardrails: ['Mark assumptions', 'Require finance review for commitments'], tools: ['pricing-model'], taskTier: 'medium' }),
  profile({ id: 'planning', name: 'Planning Agent', category: 'Planning', persona: 'builder', purpose: 'Converts approved requirements into sequenced implementation work.', inputs: ['Requirements brief', 'Architecture context'], outputs: ['Execution plan', 'Dependency map'], guardrails: ['Keep tasks bounded', 'Identify approval gates'], tools: ['project-context'], taskTier: 'complex', backend: 'kagent', harness: 'claude-code', modelFamily: 'anthropic', kagent: kagentBinding('claude-sonnet-4-5') }),
  profile({ id: 'coding', name: 'Coding Agent', category: 'Coding', persona: 'builder', purpose: 'Implements an approved change in an isolated development workspace.', inputs: ['Execution plan', 'Repository context'], outputs: ['Code change', 'Implementation notes'], guardrails: ['Stay within approved scope', 'Never handle raw credentials'], tools: ['repository'], taskTier: 'complex', backend: 'kagent', harness: 'claude-code', modelFamily: 'anthropic', connectors: ['github'], kagent: kagentBinding('claude-sonnet-4-5') }),
  profile({ id: 'engineering', name: 'Engineering Agent', category: 'Engineering', persona: 'builder', purpose: 'Owns the Phase 1 build lane: scaffolds modules, wires services, keeps the repo green.', inputs: ['Execution plan', 'Service catalogue'], outputs: ['Change set', 'Build report'], guardrails: ['Never push to protected branches', 'Keep changes reversible'], tools: ['repository', 'ci-runner'], taskTier: 'complex', backend: 'kagent', harness: 'codex', modelFamily: 'openai', connectors: ['github'], kagent: kagentBinding('gpt-5-codex') }),
  profile({ id: 'testing', name: 'Testing Agent', category: 'Testing', persona: 'builder', purpose: 'Exercises functional, integration, regression, and accessibility expectations.', inputs: ['Change set', 'Acceptance criteria'], outputs: ['Test evidence', 'Defect report'], guardrails: ['Do not hide flaky results', 'Preserve reproducible evidence'], tools: ['test-runner'], taskTier: 'medium' }),
  profile({ id: 'quality', name: 'Quality Review Agent', category: 'Quality', persona: 'builder', purpose: 'Reviews change sets for correctness, maintainability, and gate readiness.', inputs: ['Change set', 'Quality bar'], outputs: ['Review verdict', 'Actionable findings'], guardrails: ['Block on security regressions', 'One reviewer cannot approve own work'], tools: ['repository'], taskTier: 'medium', backend: 'kagent', harness: 'claude-code', modelFamily: 'anthropic', kagent: kagentBinding('claude-sonnet-4-5') }),
  profile({ id: 'security', name: 'Security Review Agent', category: 'Security', persona: 'builder', purpose: 'Reviews changes for abuse paths, tenant isolation, and secret exposure.', inputs: ['Change set', 'Threat context'], outputs: ['Security findings', 'Release recommendation'], guardrails: ['Never reproduce secret values', 'Escalate material risk'], tools: ['security-scanner'], taskTier: 'complex' }),
  profile({ id: 'data-sanitation', name: 'Data Sanitation Agent', category: 'Data sanitation', persona: 'builder', purpose: 'Removes invalid, duplicated, sensitive, or policy-excluded records.', inputs: ['Candidate dataset', 'Data policy'], outputs: ['Sanitized dataset', 'Exclusion report'], guardrails: ['Never persist raw secrets', 'Keep reversible audit metadata'], tools: ['data-validator'], taskTier: 'easy' }),
  profile({ id: 'devops-deployment', name: 'DevOps Deployment Agent', category: 'DevOps / deployment', persona: 'sre', purpose: 'Prepares and performs an approved deployment using organization runbooks.', inputs: ['Release artifact', 'Deployment context'], outputs: ['Deployment record', 'Rollback status'], guardrails: ['Require explicit production approval', 'Follow rollback thresholds'], tools: ['deployment-runner'], taskTier: 'complex', backend: 'kagent', harness: 'codex', modelFamily: 'openai', connectors: ['github'], kagent: kagentBinding('gpt-5') }),
  profile({ id: 'deployment', name: 'Deploy Agent', category: 'Deployment', persona: 'sre', purpose: 'Runs the release pipeline: artifact promotion, rollout, and rollback drills.', inputs: ['Approved release', 'Environment matrix'], outputs: ['Rollout record', 'Rollback plan'], guardrails: ['Never deploy without gate approval', 'Honor canary thresholds'], tools: ['deployment-runner'], taskTier: 'medium', backend: 'kagent', harness: 'codex', modelFamily: 'openai', kagent: kagentBinding('gpt-5') }),
  profile({ id: 'observability', name: 'Observability Agent', category: 'Observability', persona: 'sre', purpose: 'Watches service health, business signals, and release regressions.', inputs: ['Telemetry scope', 'Service objectives'], outputs: ['Health summary', 'Alert or anomaly'], guardrails: ['Avoid customer-data disclosure', 'Include signal confidence'], tools: ['metrics', 'logs', 'traces'], taskTier: 'medium' }),
  profile({ id: 'monitoring', name: 'Monitoring Agent', category: 'Monitoring', persona: 'sre', purpose: 'Maintains telemetry listeners, scheduled health checks, and alerting.', inputs: ['Service inventory', 'Alert policy'], outputs: ['Health report', 'Paged incident'], guardrails: ['Do not silence alerts autonomously', 'Escalate uncertain severity'], tools: ['metrics', 'alerts'], taskTier: 'easy', backend: 'kagent', harness: 'deepagent', modelFamily: 'byok', kagent: kagentBinding('') }),
  profile({ id: 'incident-triage', name: 'Incident Triage Agent', category: 'Incident triage', persona: 'sre', purpose: 'Correlates incident signals and coordinates the first response.', inputs: ['Alerts', 'Recent change context'], outputs: ['Severity assessment', 'Response plan'], guardrails: ['Do not make destructive changes', 'Escalate uncertain severity'], tools: ['incident-console'], taskTier: 'complex' }),
  profile({ id: 'support', name: 'Support Agent', category: 'Support', persona: 'sre', purpose: 'Classifies customer reports and prepares evidence-grounded responses.', inputs: ['Support case', 'Known-issue catalog'], outputs: ['Triage result', 'Response draft'], guardrails: ['Protect customer data', 'Do not promise unapproved timelines'], tools: ['support-desk'], taskTier: 'easy' }),
  profile({ id: 'compliance', name: 'Compliance Agent', category: 'Compliance', persona: 'sre', purpose: 'Checks a proposed change or launch against applicable policies.', inputs: ['Proposal', 'Policy scope'], outputs: ['Compliance checklist', 'Exceptions'], guardrails: ['Escalate unresolved obligations', 'Do not provide final legal approval'], tools: ['policy-library'], taskTier: 'medium' }),
  profile({ id: 'launch', name: 'Launch Agent', category: 'Launch', persona: 'sre', purpose: 'Coordinates approved release communication and rollout tasks.', inputs: ['Approved launch plan', 'Audience'], outputs: ['Launch checklist', 'Communication package'], guardrails: ['Use approved claims only', 'Honor rollout gates'], tools: ['release-calendar'], taskTier: 'easy' }),
  profile({ id: 'knowledge-publishing', name: 'Knowledge Publishing Agent', category: 'Knowledge publishing', persona: 'product-designer', purpose: 'Turns verified findings into durable organization knowledge.', inputs: ['Approved synthesis', 'Publishing policy'], outputs: ['Knowledge article', 'Source index'], guardrails: ['Preserve attribution', 'Do not publish restricted material'], tools: ['knowledge-base'], taskTier: 'easy' }),
]);

// The decision-gate template from the code.html Specs Gate modal: six
// assessment cards, three checklist items each, threshold in percent.
const DEFAULT_GATE_TEMPLATE = deepFreeze({
  schemaVersion: WORKFLOW_DEFAULTS_VERSION,
  id: 'gate-template-v1',
  title: 'Specs Gate',
  cards: [
    {
      id: 'business-analysis', title: 'Business Analysis', threshold: 85, passRate: 90,
      items: [
        'MVB Defined: Minimum Viable Business scope verified',
        'Phase 1 Defined: Phase 1 MVP milestones and architecture locked',
        'Phase 3 Defined: Phase 3 scalability and retirement guardrails approved',
      ],
    },
    {
      id: 'cloud-selection', title: 'Cloud Selection', threshold: 100, passRate: 100,
      items: [
        'Provider Matrix: hosting environment selected (GCP / AWS / Hybrid)',
        'Hosting Tool & Runtime: runtime environment pinned (containerized)',
        'Regional Compliance: sovereignty & VPC peering constraints validated',
      ],
    },
    {
      id: 'cost-analysis', title: 'Cost Analysis', threshold: 80, passRate: 85,
      items: [
        'Run-Rate Projection: monthly inference budget established',
        'Agent Execution Envelope: burst limit policy with circuit breakers configured',
        'Token Cap: ROI justification signed off by domain lead',
      ],
    },
    {
      id: 'business-metrics', title: 'Business Metrics', threshold: 75, passRate: 88,
      items: [
        'KPI Framework: primary business conversion metric specified',
        'Telemetry Hooks: agent task completion rate benchmark set',
        'Success Benchmarks: automated anomaly threshold defined',
      ],
    },
    {
      id: 'revenue-model', title: 'Revenue Model', threshold: 80, passRate: 82,
      items: [
        'Monetization Tiering: tiered API quota and usage tiering verified',
        'Billing Integration: customer billing webhook validation active',
        'Unit Economics: gross margin per agent task above target',
      ],
    },
    {
      id: 'timeline-defined', title: 'Timeline Defined', threshold: 100, passRate: 100,
      items: [
        'Sprint Cadence: sprint delivery cadence locked',
        'Gate Sign-off SLAs: decision gate auto-escalation timer set',
        'Dependency Deadlines: downstream Planner Agent dependency clearance verified',
      ],
    },
  ],
});

function gateConfigFromTemplate() {
  return {
    id: DEFAULT_GATE_TEMPLATE.id,
    title: DEFAULT_GATE_TEMPLATE.title,
    cards: DEFAULT_GATE_TEMPLATE.cards.map((card) => ({
      id: card.id, title: card.title, items: [...card.items], threshold: card.threshold,
    })),
  };
}

function node(id, kind, refId, name, x, y, extra = {}) {
  return { id, kind, refId: refId || null, name, description: '', x, y, ...extra };
}

function edge(id, source, target, outcome) {
  return { id, source, target, ...(outcome ? { outcome } : {}) };
}

const TS = '2026-11-15T00:00:00.000Z';

function defaultWorkflow(id, name, description, nodes, edges) {
  return {
    schemaVersion: 2,
    id, name, description,
    createdAt: TS, updatedAt: TS,
    viewport: { x: 40, y: 40, zoom: 0.82 },
    nodes, edges,
  };
}

// The tenant default: the code.html "Platform Improvement" ADLC lane —
// Ideation → Specs Gate → Planning → Coding → Testing → QA sign-off →
// Deploy → Monitoring.
const DEFAULT_ADLC_WORKFLOW = deepFreeze(defaultWorkflow(
  'default-adlc',
  'Platform Improvement (ADLC)',
  'The default tenant workflow: Ideation to Deploy behind the Specs decision gate, with QA sign-off before release and monitoring after.',
  [
    node('ideation', 'agent', 'ideation', 'Ideation Agent', 40, 260, { backend: 'substrate', taskTier: 'complex', connectors: ['figma', 'notion'] }),
    node('specs-gate', 'gate', null, 'Specs Gate', 320, 260, { gateConfig: gateConfigFromTemplate(), gateRef: 'gate-template-v1' }),
    node('planning', 'agent', 'planning', 'Planner Agent', 600, 120, { backend: 'kagent', harness: 'claude-code', modelFamily: 'anthropic', taskTier: 'complex', kagentSpec: kagentBinding('claude-sonnet-4-5') }),
    node('engineering', 'agent', 'coding', 'Coding Agent', 880, 120, { backend: 'kagent', harness: 'claude-code', modelFamily: 'anthropic', taskTier: 'complex', connectors: ['github'], kagentSpec: kagentBinding('claude-sonnet-4-5') }),
    node('testing', 'agent', 'testing', 'Testing Agent', 1160, 120),
    node('qa-signoff', 'approval', null, 'QA sign-off', 1440, 120, {
      requiredRole: 'Quality',
      reviewCriteria: ['All acceptance criteria pass', 'No open security findings'],
      instructions: 'Approve to promote the change set to the deploy lane.',
      rejectionHandling: 'Return the defect report to the Coding Agent lane.',
    }),
    node('deploy', 'agent', 'deployment', 'Deploy Agent', 1720, 120, { backend: 'kagent', harness: 'codex', modelFamily: 'openai', taskTier: 'medium', connectors: ['slack'], kagentSpec: kagentBinding('gpt-5') }),
    node('monitoring', 'agent', 'monitoring', 'Monitoring Agent', 2000, 120, { connectors: ['slack'] }),
  ],
  [
    edge('e1', 'ideation', 'specs-gate'),
    edge('e2', 'specs-gate', 'planning'),
    edge('e3', 'planning', 'engineering'),
    edge('e4', 'engineering', 'testing'),
    edge('e5', 'testing', 'qa-signoff'),
    edge('e6', 'qa-signoff', 'deploy', 'approved'),
    edge('e8', 'deploy', 'monitoring'),
  ],
));

// The onboarding minimum: one small workflow every persona can run against
// the default agent, proving persistence end to end.
const DEFAULT_QUICKSTART_WORKFLOW = deepFreeze(defaultWorkflow(
  'default-quickstart',
  'Quickstart: plan → code → review',
  'A minimal three-step workflow created during onboarding; duplicate and extend it, or reset from the platform defaults at any time.',
  [
    node('qs-plan', 'agent', 'planning', 'Planning Agent', 40, 120),
    node('qs-code', 'agent', 'coding', 'Coding Agent', 320, 120),
    node('qs-review', 'approval', null, 'Peer review', 600, 120, { requiredRole: 'Builder' }),
  ],
  [
    edge('qs-e1', 'qs-plan', 'qs-code'),
    edge('qs-e2', 'qs-code', 'qs-review'),
  ],
));

// Namespaced Role the kagent adapter needs (documented in
// docs/WORKFLOWS_AUTHENTICATION.md); crTemplates seed the adapter defaults.
const DEFAULT_KAGENT_CR_TEMPLATES = deepFreeze({
  schemaVersion: WORKFLOW_DEFAULTS_VERSION,
  group: 'api.kagent.dev',
  version: 'v1alpha3',
  namespace: 'kagent',
  rbac: {
    apiGroup: 'api.kagent.dev',
    resources: ['agents', 'agenttemplates', 'harnesses', 'modelconfigs', 'remotemcpservers', 'egresspolicies'],
    verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
  },
  agentSkeleton: {
    apiVersion: 'api.kagent.dev/v1alpha3',
    kind: 'Agent',
    spec: {
      harnessRef: { name: 'my-first-harness' },
      template: { inline: { systemPrompt: '', modelConfig: { name: 'default-model-config' } } },
    },
  },
});

const DEFAULT_ROLE_GRANTS = deepFreeze(
  PERSONAS.map((persona) => ({
    id: `grant-${persona}`,
    persona,
    allowedCategories: DEFAULT_PERSONA_GRANTS[persona],
  })),
);

// What onboarding copies into a fresh tenant, keyed by store collection.
const DEFAULT_TENANT_SEED = deepFreeze({
  organization: 'Default Organization',
  project: 'Default Project',
  defaultAgentId: 'ideation',
  defaultWorkflowId: DEFAULT_ADLC_WORKFLOW.id,
  personas: [...PERSONAS],
  defaultPersona: 'builder',
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify({
    agentProfiles: DEFAULT_AGENT_PROFILES,
    workflows: [DEFAULT_ADLC_WORKFLOW, DEFAULT_QUICKSTART_WORKFLOW],
    gateTemplate: DEFAULT_GATE_TEMPLATE,
    roleGrants: DEFAULT_ROLE_GRANTS,
    kagentCrTemplates: DEFAULT_KAGENT_CR_TEMPLATES,
    tenant: DEFAULT_TENANT_SEED,
  }));
}

module.exports = {
  WORKFLOW_DEFAULTS_VERSION,
  DEFAULTS_NAMESPACE_COLLECTION,
  DEFAULT_AGENT_PROFILES,
  DEFAULT_GATE_TEMPLATE,
  DEFAULT_ADLC_WORKFLOW,
  DEFAULT_QUICKSTART_WORKFLOW,
  DEFAULT_KAGENT_CR_TEMPLATES,
  DEFAULT_ROLE_GRANTS,
  DEFAULT_TENANT_SEED,
  gateConfigFromTemplate,
  cloneDefaults,
};
