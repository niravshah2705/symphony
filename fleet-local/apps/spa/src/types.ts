export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface Org {
  id: string;
  slug: string;
  name: string;
}

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
  status: string;
  tier: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  metered_at: string | null;
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

export interface StepState {
  step: OnboardingStepId;
  status: StepStatus;
  attempt: number;
  idempotencyKey: string;
  result?: Record<string, unknown>;
  error?: string;
}

export type States = Partial<Record<OnboardingStepId, StepState>>;

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
export const STEP_META: { id: OnboardingStepId; diagram: number; label: string }[] = [
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