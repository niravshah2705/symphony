export const FLEET_HEADERS = {
  orgId: 'x-fleet-org-id',
  projectId: 'x-fleet-project-id',
  userId: 'x-fleet-user-id',
} as const;

export const AUTH_HEADERS = {
  email: 'x-auth-request-email',
  user: 'x-auth-request-user',
  preferredUsername: 'x-auth-request-preferred-username',
  authorization: 'authorization',
} as const;

export const STRIPPED_CLIENT_HEADERS = [
  'x-auth-request-email',
  'x-auth-request-user',
  'x-auth-request-preferred-username',
  'x-auth-request-access-token',
  'x-forwarded-user',
  'x-forwarded-email',
  'x-forwarded-groups',
  'x-forwarded-preferred-username',
  'x-fleet-org-id',
  'x-fleet-project-id',
  'x-fleet-user-id',
  'x-user-id',
  'x-agent-name',
] as const;

export const BAGGAGE_KEYS = {
  orgId: 'fleet_org_id',
  projectId: 'fleet_project_id',
  userId: 'fleet_user_id',
  conversationId: 'gen_ai.conversation.id',
} as const;

export const BILLABLE_TAGS = ['planning', 'skill', 'mcp'] as const;

export const MODELS = {
  mock: 'mock-gpt',
  claude: 'claude-sonnet-4',
} as const;

// P6: the chat model is configuration. FLEET_MODELS (BFF configmap) holds a JSON
// array of these entries; MODELS remains the fallback for the two originals.
export interface ModelCatalogEntry {
  id: string;
  label: string;
  model: string;
  default?: boolean;
}

export const DEFAULT_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  { id: 'mock', label: 'Mock GPT (offline)', model: 'mock-gpt', default: true },
  { id: 'claude', label: 'Claude Sonnet 4', model: 'claude-sonnet-4' },
  {
    id: 'nemotron',
    label: 'Nemotron 3 Ultra 550B (free)',
    model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  },
];

export function parseModelCatalog(json: string | undefined): ModelCatalogEntry[] {
  if (!json) return [...DEFAULT_MODEL_CATALOG];
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('FLEET_MODELS must be a non-empty JSON array');
  const out = parsed as ModelCatalogEntry[];
  for (const m of out) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(m.id ?? '') || !m.model || !m.label) {
      throw new Error(`FLEET_MODELS entry invalid: ${JSON.stringify(m)}`);
    }
  }
  if (!out.some((m) => m.default)) out[0] = { ...out[0]!, default: true };
  return out;
}

export function encodeBaggage(entries: Record<string, string | undefined>): string {
  return Object.entries(entries)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join(',');
}

export function decodeBaggage(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const member of header.split(',')) {
    const eq = member.indexOf('=');
    if (eq <= 0) continue;
    const key = member.slice(0, eq).trim();
    const raw = member.slice(eq + 1).trim();
    if (!key || !raw) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

// One canonical UUID per org/project across every system and environment: no prefixes.
export function customerId(orgUuid: string): string {
  return orgUuid;
}

export function actorComputeEventId(orgUuid: string, sessionId: string): string {
  return `ev:${orgUuid}:${sessionId}:actor-compute`;
}

export const ONBOARDING_STEPS = [
  { id: 'org', diagram: 1, deps: [] },
  { id: 'namespace', diagram: 6, deps: ['org'] },
  { id: 'project', diagram: 2, deps: ['org'] },
  { id: 'flexprice', diagram: 5, deps: ['org'] },
  { id: 'key', diagram: 8, deps: ['org', 'project'] },
  { id: 'workflow', diagram: 3, deps: ['namespace', 'key'] },
  { id: 'agent', diagram: 7, deps: ['workflow'] },
  { id: 'attach', diagram: 4, deps: ['project', 'agent'] },
  { id: 'limits', diagram: 9, deps: ['flexprice', 'key'] },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]['id'];
export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface StepState {
  step: OnboardingStepId;
  status: StepStatus;
  attempt: number;
  idempotencyKey: string;
  result?: Record<string, unknown>;
  error?: string;
}

export function stepDef(id: OnboardingStepId) {
  const def = ONBOARDING_STEPS.find((s) => s.id === id);
  if (!def) throw new Error(`unknown onboarding step: ${id}`);
  return def;
}

export function nextRunnableSteps(states: Partial<Record<OnboardingStepId, StepState>>): OnboardingStepId[] {
  return ONBOARDING_STEPS.filter((def) => {
    const own = states[def.id];
    if (own && (own.status === 'done' || own.status === 'running')) return false;
    return def.deps.every((dep) => states[dep]?.status === 'done');
  }).map((def) => def.id);
}

export interface CostRow {
  orgId: string;
  projectId?: string;
  userId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usd: number;
  actorSeconds: number;
}