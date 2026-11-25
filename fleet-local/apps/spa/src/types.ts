export interface User {
  id: string;
  email: string;
  name: string | null;
}

// Mirrors OrgStatus in apps/control-plane/src/lifecycle.ts. `deleted` never
// reaches the SPA as a selected org: the teardown removes membership, so the row
// drops out of /api/me.
export type OrgStatus = 'active' | 'disabled' | 'offboarding' | 'deleted';

export interface Org {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  /** The caller's own role, which is why the lifecycle controls can be hidden
   *  rather than left to fail with a 403. Only the list endpoints carry it. */
  role: string;
}

/** What the org mutations return: the row itself, without the membership join. */
export type OrgRow = Omit<Org, 'role'>;

export interface Project {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  agent_name: string | null;
  agent_namespace: string | null;
}

export interface ModelOption {
  id: string;
  label: string;
  model: string;
  default: boolean;
}

// Mirrors Outcome in apps/control-plane/src/a2a/contract.ts and the sessions
// table's outcome column. The BFF guards any value it does not recognise, so a
// drift here degrades to "unknown outcome" rather than a bad render.
export type SessionOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'upstream_error'
  | 'client_abort'
  | 'no_events'
  | 'awaiting_input';

export interface Session {
  id: string;
  org_id: string;
  project_id: string;
  user_id: string;
  agent_name: string;
  agent_namespace: string;
  model?: string | null;
  kagent_session_id: string | null;
  kagent_task_id: string | null;
  // The AG-UI thread handle the browser minted for this conversation. It is what
  // the run endpoint resolves a session by, and what "resume" has to send back —
  // kagent's own context id is not something the browser may name.
  thread_id: string | null;
  status: string;
  tier: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  metered_at: string | null;
  // What the turn was, and why: 'closed' alone cannot tell a completed answer
  // from a run the platform broke, which is how "(no output)" happened.
  outcome: SessionOutcome | null;
  close_reason: string | null;
  // meter_seconds is the conversation's measured agent time; billed_seconds is
  // how much of it has been invoiced. duration_seconds stays the wall clock.
  meter_seconds: number | null;
  billed_seconds: number | null;
  awaiting_since: string | null;
  turn: number;
  metered_seconds: number | null;
  metered_outcome: SessionOutcome | null;
}

export type OnboardingStepId =
  | 'org'
  | 'namespace'
  | 'project'
  | 'flexprice'
  | 'key'
  | 'workflow'
  | 'agent'
  | 'attach'
  | 'limits';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface StepState<S extends string = OnboardingStepId> {
  step: S;
  status: StepStatus;
  attempt: number;
  idempotencyKey: string;
  result?: Record<string, unknown>;
  error?: string;
}

export type States = Partial<Record<OnboardingStepId, StepState>>;

// Mirrors OFFBOARDING_STEPS in packages/shared/src/index.ts. The ids are the
// teardown's own; the table is separate from onboarding_runs on purpose, so a
// teardown never renders as onboarding progress.
export type OffboardingStepId =
  | 'release'
  | 'detach'
  | 'key'
  | 'workspace'
  | 'team'
  | 'namespace'
  | 'substrate'
  | 'flexprice'
  | 'access';

export type OffboardStates = Partial<Record<OffboardingStepId, StepState<OffboardingStepId>>>;

export interface Window {
  startTime: string;
  endTime: string;
}

export interface Breakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usd: number;
}

export interface CostRow extends Breakdown {
  orgId: string;
  projectId?: string;
  userId?: string;
  actorSeconds: number;
}

export interface OrgCosts {
  orgId: string;
  window: Window;
  totals: Breakdown & { actorSeconds: number };
  byProject: Record<string, Breakdown>;
  byUser: Record<string, Breakdown>;
  rows: CostRow[];
}

export interface LitellmCrossCheck {
  globalDaily: { date: string; spend: number }[];
  teamSpend: Record<string, number>;
}

export interface PromSample {
  metric: Record<string, string>;
  value: number;
}

export interface ReconciledCosts {
  orgId: string;
  window: Window;
  flexprice: OrgCosts;
  litellm: LitellmCrossCheck;
  prometheus: PromSample[];
  walletBalance?: unknown;
}

export interface LangfuseTrace {
  id: string;
  sessionId?: string;
  userId?: string;
  name?: string;
  timestamp?: string;
  totalCost?: number;
  latency?: number;
}

// Diagram order (#) and human labels for the wizard. Execution order is the DAG
// the BFF runs; this is just presentation.
export interface StepMeta<S extends string> {
  id: S;
  diagram: number;
  label: string;
}

export const STEP_META: StepMeta<OnboardingStepId>[] = [
  { id: 'org', diagram: 1, label: 'Default organisation' },
  { id: 'project', diagram: 2, label: 'Default project' },
  { id: 'workflow', diagram: 3, label: 'Copy coding workflow' },
  { id: 'attach', diagram: 4, label: 'Attach agent to project' },
  { id: 'flexprice', diagram: 5, label: 'Flexprice customer + wallet' },
  { id: 'namespace', diagram: 6, label: 'Substrate namespace' },
  { id: 'agent', diagram: 7, label: 'Create Agent' },
  { id: 'key', diagram: 8, label: 'LiteLLM virtual key' },
  { id: 'limits', diagram: 9, label: 'Org + project limits' },
];

// Teardown order, with the onboarding step (#) each one reverses. `key` precedes
// `namespace` because the raw virtual key exists only inside that namespace's
// Secret, and `flexprice` comes after all compute has stopped so the accrued
// usage is invoiced rather than lost.
export const OFFBOARD_META: StepMeta<OffboardingStepId>[] = [
  { id: 'release', diagram: 3, label: 'Remove the tenant release' },
  { id: 'detach', diagram: 4, label: 'Detach agents from projects' },
  { id: 'key', diagram: 8, label: 'Delete the LiteLLM virtual key' },
  { id: 'workspace', diagram: 6, label: 'Delete the worker pool' },
  { id: 'team', diagram: 2, label: 'Delete the LiteLLM team' },
  { id: 'namespace', diagram: 6, label: 'Delete the tenant namespace' },
  { id: 'substrate', diagram: 6, label: 'Drop the substrate namespace policy' },
  { id: 'flexprice', diagram: 5, label: 'Cancel the Flexprice subscription' },
  { id: 'access', diagram: 1, label: 'Remove members and mark deleted' },
];