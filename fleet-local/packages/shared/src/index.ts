export * from './a2a.ts';
export * from './agui.ts';

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
export type HarnessRuntime = 'kagent' | 'claude' | 'codex' | 'qoder';

export interface ModelCatalogEntry {
  id: string;
  label: string;
  model: string;
  default?: boolean;
  // P7: which Harness compiles this agent. 'claude' routes through an
  // Anthropic-provider ModelConfig (egress-injected x-api-key) on the
  // claude-harness image; 'codex' stays on the OpenAI provider but requires
  // apiFormat responses and rejects defaultHeaders; 'kagent' (default) keeps
  // the OpenAI wire + headers. 'qoder' compiles a kagent `byo` Harness running
  // the published qoder-runtime image, dialing Qoder directly with the org's own
  // token (Secret key QODER_API_KEY) substituted per call by an EgressPolicy.
  runtime?: HarnessRuntime;
  // An experimental entry is rendered for the tenant but is never waited on
  // during onboarding and is hidden from the chat picker until it is proven.
  experimental?: boolean;
}

export const DEFAULT_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  { id: 'mock', label: 'Mock GPT (offline)', model: 'mock-gpt', default: true },
  { id: 'claude', label: 'Claude Sonnet 4', model: 'claude-sonnet-4' },
  {
    id: 'nemotron',
    label: 'Nemotron 3 Ultra 550B (free)',
    model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  },
  {
    id: 'nemotron-claude',
    label: 'Nemotron 550B (Claude Code runtime)',
    model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    runtime: 'claude',
  },
  {
    id: 'nemotron-codex',
    label: 'Nemotron 550B (Codex runtime)',
    model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    runtime: 'codex',
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
    if (m.runtime !== undefined && m.runtime !== 'kagent' && m.runtime !== 'claude' && m.runtime !== 'codex' && m.runtime !== 'qoder') {
      throw new Error(`FLEET_MODELS entry runtime must be kagent|claude|codex|qoder: ${JSON.stringify(m)}`);
    }
    if (m.experimental !== undefined && typeof m.experimental !== 'boolean') {
      throw new Error(`FLEET_MODELS entry experimental must be a boolean: ${JSON.stringify(m)}`);
    }
  }
  if (!out.some((m) => m.default)) out[0] = { ...out[0]!, default: true };
  return out;
}

// The Qoder entry is opt-in: it is only appended to the catalog when the BFF is
// configured with a digest-pinned qoder-runtime image (config.qoderRuntimeImage),
// so a deployment without the image never renders a dead agent.
export const QODER_CATALOG_ENTRY: ModelCatalogEntry = {
  id: 'qoder',
  label: 'Qwen3.8 Flash (Qoder runtime)',
  // A Qoder-native model id, not a LiteLLM alias: the qoder agent dials Qoder's own
  // endpoint, so nothing here is resolved against the LiteLLM model list.
  model: 'qwen3.8-flash',
  runtime: 'qoder',
};

// DigestPin is what the kagent Harness CRD demands of workload.image: a tag is
// rejected at apply time, after onboarding has already mutated the tenant.
export const DIGEST_PIN = /@sha256:[a-f0-9]{64}$/;

// withQoderCatalog appends the Qoder entry only when the deployment has a
// qoder-runtime image to render. An explicit runtime:'qoder' row in
// FLEET_MODELS wins, so an operator can override the label/model/policy.
export function withQoderCatalog(catalog: ModelCatalogEntry[], image: string): ModelCatalogEntry[] {
  if (!image || catalog.some((m) => m.runtime === 'qoder')) return catalog;
  return [...catalog, { ...QODER_CATALOG_ENTRY }];
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

// The onboarding DAG run backwards: one teardown step per create step, so nothing
// provisioned is left behind. Order is not decoration —
//   key before namespace: the raw LiteLLM virtual key exists only in that Secret,
//     so deleting the namespace first orphans a key that can still spend;
//   workspace (WorkerPool) before namespace: namespace deletion alone can leave
//     atelet-managed gVisor sandboxes running;
//   flexprice last-but-one: cancelling the subscription invoices the open usage
//     period, which must happen after the compute has actually stopped;
//   access dead last: an incomplete teardown must not hide the org from the owner
//     who has to retry it.
export const OFFBOARDING_STEPS = [
  { id: 'release', diagram: 3, deps: [] },
  { id: 'detach', diagram: 4, deps: ['release'] },
  { id: 'key', diagram: 8, deps: ['release'] },
  { id: 'workspace', diagram: 6, deps: ['release'] },
  { id: 'team', diagram: 2, deps: ['key'] },
  { id: 'namespace', diagram: 6, deps: ['workspace', 'key'] },
  { id: 'substrate', diagram: 6, deps: ['namespace'] },
  { id: 'flexprice', diagram: 5, deps: ['team'] },
  { id: 'access', diagram: 1, deps: ['substrate', 'flexprice'] },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]['id'];
export type OffboardingStepId = (typeof OFFBOARDING_STEPS)[number]['id'];
export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface StepState<S extends string = OnboardingStepId> {
  step: S;
  status: StepStatus;
  attempt: number;
  idempotencyKey: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface StepDef<S extends string> {
  readonly id: S;
  readonly deps: readonly S[];
}

export function stepDef(id: OnboardingStepId | OffboardingStepId) {
  const def = [...ONBOARDING_STEPS, ...OFFBOARDING_STEPS].find((s) => s.id === id);
  if (!def) throw new Error(`unknown step: ${id}`);
  return def;
}

// Selectable = not yet done, not in flight, and every dependency already done.
// A failed dependency blocks its dependents; an independent sibling still runs.
export function runnableSteps<S extends string>(
  steps: readonly StepDef<S>[],
  states: Partial<Record<S, StepState<S>>>,
): S[] {
  return steps
    .filter((def) => {
      const own = states[def.id];
      if (own && (own.status === 'done' || own.status === 'running')) return false;
      return def.deps.every((dep) => states[dep]?.status === 'done');
    })
    .map((def) => def.id);
}

export function nextRunnableSteps(
  states: Partial<Record<OnboardingStepId, StepState<OnboardingStepId>>>,
): OnboardingStepId[] {
  return runnableSteps(ONBOARDING_STEPS, states);
}

export function nextRunnableOffboardSteps(
  states: Partial<Record<OffboardingStepId, StepState<OffboardingStepId>>>,
): OffboardingStepId[] {
  return runnableSteps(OFFBOARDING_STEPS, states);
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