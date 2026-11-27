// The A2A wire vocabulary shared by the BFF facade and the SPA. Both sides must
// spell these identically — a key that drifts silently stops matching instead of
// failing loudly, which is how a reasoning stream would just look like the answer.

export const A2A_VERSION_HEADER = 'A2A-Version';
export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_CONTENT_TYPE = 'application/a2a+json';
export const A2A_SSE_CONTENT_TYPE = 'text/event-stream';

// kagent's reasoning convention: a TEXT part carrying this metadata key is model
// thinking, not the answer. There is no reasoning part kind in A2A (Part is a
// oneof Text/Raw/Data/URL), so metadata on a text part is the only option.
// Byte-identical to the Go constant in go/api/a2a/metadata.go.
export const THOUGHT_PART_KEY = 'kagent.dev/a2a/thought';

// assistant-ui's A2A adapter drops part.metadata when converting parts to
// content, so a thought-marked text part would be indistinguishable from the
// answer in the UI. The facade re-emits reasoning on the one channel the adapter
// preserves with identity: a dedicated artifact.
export const REASONING_ARTIFACT_ID = 'fleet.dev/reasoning';
export const REASONING_ARTIFACT_NAME = 'Reasoning';

// Chat model selection has no field in an A2A Message, so the SPA sends it as
// message metadata; the facade consumes and strips it before kagent sees it.
// There is deliberately no request-header fallback: metadata is the only channel
// the standard client builds (it passes per-call metadata as undefined), so a
// second spelling of the same choice would be a second path that can drift.
export const MODEL_METADATA_KEY = 'fleet.dev/model';

export const HITL_EXTENSION_URI = 'https://kagent.dev/extensions/hitl/v1';
export const HITL_TYPE_TOOL_APPROVAL_REQUEST = 'tool_approval_request';
export const HITL_TYPE_ASK_USER_REQUEST = 'ask_user_request';
export const HITL_TYPE_TOOL_APPROVAL_RESPONSE = 'tool_approval_response';
export const HITL_TYPE_ASK_USER_RESPONSE = 'ask_user_response';
export const TOOL_APPROVAL_RESPONSE_TYPE = HITL_TYPE_TOOL_APPROVAL_RESPONSE;

// kagent's tool-activity convention (go/api/a2a/tool_activity.go): a DATA part
// whose metadata names the part-type. Byte-identical spellings, or the parse
// silently stops matching — the same drift the thought marker above warns about.
export const PART_TYPE_METADATA_KEY = 'kagent.dev/a2a/part-type';
export const TOOL_CALL_PART_KIND = 'function_call';
export const TOOL_RESULT_PART_KIND = 'function_response';

// One harness tool invocation as it rides the A2A wire. `args`/`response` are
// whatever JSON the harness produced; the UI renders them verbatim.
export interface ToolActivity {
  kind: typeof TOOL_CALL_PART_KIND | typeof TOOL_RESULT_PART_KIND;
  id: string;
  name: string;
  args?: unknown;
  response?: unknown;
}

// The public HITL payloads (go/api/a2a/hitl.go), mirrored so the SPA's approval
// card and the BFF's resume body speak the harness's exact field names.
export interface HitlTool {
  id: string;
  call_id: string;
  name: string;
  args?: Record<string, unknown>;
}

// Tool approvals propagated from a child agent name the child's tools instead
// of the top-level list (go/api/a2a/hitl.go NestedHITLRequest); a response must
// decide exactly that list.
export interface HitlNestedRequest {
  subagent_name?: string;
  task_id?: string;
  context_id?: string;
  tools: HitlTool[];
}

export interface HitlToolApprovalRequest {
  type: typeof HITL_TYPE_TOOL_APPROVAL_REQUEST;
  hint?: string;
  tools: HitlTool[];
  nested?: HitlNestedRequest;
}

export interface HitlQuestion {
  question: string;
  choices: string[];
  multiple: boolean;
}

export interface HitlAskUserRequest {
  type: typeof HITL_TYPE_ASK_USER_REQUEST;
  id: string;
  questions: HitlQuestion[];
  nested?: HitlNestedRequest;
}

export interface HitlToolApproval {
  id: string;
  approved: boolean;
  rejection_reason?: string;
}

export interface HitlToolApprovalResponse {
  type: typeof HITL_TYPE_TOOL_APPROVAL_RESPONSE;
  approvals: HitlToolApproval[];
}

export interface HitlAskUserAnswer {
  answer: string[];
}

export interface HitlAskUserResponse {
  type: typeof HITL_TYPE_ASK_USER_RESPONSE;
  id: string;
  answers: HitlAskUserAnswer[];
}

// One A2A server per project: the client derives its agent-card URL from baseUrl
// alone (basePath/tenant are not applied to discovery), so the project scope has
// to live in the baseUrl path for a multi-project BFF.
export function a2aFacadeBase(origin: string, orgId: string, projectId: string): string {
  return `${origin.replace(/\/+$/, '')}/api/a2a/orgs/${orgId}/projects/${projectId}`;
}

export function isThoughtPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as { text?: unknown; metadata?: unknown };
  if (typeof candidate.text !== 'string' || candidate.text === '') return false;
  const metadata = candidate.metadata;
  if (typeof metadata !== 'object' || metadata === null) return false;
  return (metadata as Record<string, unknown>)[THOUGHT_PART_KEY] === true;
}

// Read one wire part as a tool activity, tolerating both the A2A proto spelling
// (data is the `data` member) and the kind-tagged REST form. Returns undefined
// for any part that is not a function_call / function_response data part.
export function parseToolActivityPart(part: unknown): ToolActivity | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const candidate = part as { data?: unknown; metadata?: unknown };
  if (typeof candidate.metadata !== 'object' || candidate.metadata === null) return undefined;
  const kind = (candidate.metadata as Record<string, unknown>)[PART_TYPE_METADATA_KEY];
  if (kind !== TOOL_CALL_PART_KIND && kind !== TOOL_RESULT_PART_KIND) return undefined;
  const data = candidate.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const name = typeof record.name === 'string' ? record.name : '';
  if (!id && !name) return undefined;
  const activity: ToolActivity = { kind, id, name };
  if (kind === TOOL_CALL_PART_KIND && record.args !== undefined) activity.args = record.args;
  if (kind === TOOL_RESULT_PART_KIND && record.response !== undefined) activity.response = record.response;
  return activity;
}

// kagent's structured terminal result (go/api/a2a/structured_output.go): a DATA
// part with mediaType application/json whose metadata carries the digest of the
// schema the model output was validated against. The digest is the only proof the
// payload matches a schema, and it is what distinguishes this from any other JSON
// data part — so all three conditions must hold, exactly as Go checks them.
export const OUTPUT_SCHEMA_SHA256_KEY = 'kagent.dev/a2a/output-schema-sha256';

export interface StructuredOutput {
  value: unknown;
  schemaSha256: string;
}

export function parseStructuredOutputPart(part: unknown): StructuredOutput | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const candidate = part as { data?: unknown; mediaType?: unknown; media_type?: unknown; metadata?: unknown };
  if (candidate.data === undefined) return undefined;
  const declared = typeof candidate.mediaType === 'string' ? candidate.mediaType : typeof candidate.media_type === 'string' ? candidate.media_type : '';
  if (declared.split(';')[0]?.trim().toLowerCase() !== 'application/json') return undefined;
  const metadata = candidate.metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const digest = (metadata as Record<string, unknown>)[OUTPUT_SCHEMA_SHA256_KEY];
  if (typeof digest !== 'string' || digest === '') return undefined;
  return { value: candidate.data, schemaSha256: digest };
}

// Sources v1 — a fleet-local derivation, not a wire convention. Nothing in kagent
// emits citations (there is no sources part in go/api/a2a), so the only evidence
// the platform has of what the agent read is the URL list inside a web tool's
// function_response. Deriving from THAT is honest about the limit: a source is a
// page a tool fetched, not a page the answer cites.
export interface AgentSource {
  url: string;
  title?: string;
}

// Only web-shaped tools produce citations. A shell or filesystem result can
// contain a URL without the agent having read the page it points at.
const WEB_TOOL_NAME = /web|browse|search|fetch|http|url|scrape|crawl|retriev/i;

const URL_IN_TEXT = /https?:\/\/[^\s"'<>()\[\]]+/g;
const TITLE_FIELDS = ['title', 'name', 'heading', 'site_name'] as const;
const URL_FIELDS = ['url', 'link', 'href', 'uri'] as const;

const clean = (url: string): string => url.replace(/[.,;:!?]+$/, '');

const fallbackTitle = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop();
    return path ? `${parsed.hostname} · ${decodeURIComponent(path)}` : parsed.hostname;
  } catch {
    return undefined;
  }
};

const asText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

// Walk whatever JSON the harness returned. A `{url, title}` object anywhere in the
// tree is one citation; a bare string (a markdown answer, a curl body) is scanned
// for links. Depth- and count-bounded because a tool response can be a whole page.
const collect = (value: unknown, found: AgentSource[], depth: number): void => {
  if (found.length >= 12 || depth > 6) return;
  if (typeof value === 'string') {
    for (const match of value.matchAll(URL_IN_TEXT)) {
      const url = clean(match[0]);
      if (url) found.push({ url });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found, depth + 1);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  const url = URL_FIELDS.map((field) => asText(record[field])).find((x): x is string => x !== undefined);
  if (url) {
    const title = TITLE_FIELDS.map((field) => asText(record[field])).find((x): x is string => x !== undefined);
    found.push({ url: clean(url), ...(title ? { title } : {}) });
    return;
  }
  for (const nested of Object.values(record)) collect(nested, found, depth + 1);
};

export function sourcesFromToolResult(name: string, response: unknown): AgentSource[] {
  if (!WEB_TOOL_NAME.test(name) || response === undefined || response === null) return [];
  const found: AgentSource[] = [];
  collect(response, found, 0);
  const out: AgentSource[] = [];
  for (const source of found) {
    if (!/^https?:\/\//.test(source.url)) continue;
    const existing = out.find((candidate) => candidate.url === source.url);
    if (existing) {
      if (!existing.title && source.title) existing.title = source.title;
      continue;
    }
    if (out.length >= 8) break;
    const title = source.title ?? fallbackTitle(source.url);
    out.push({ url: source.url, ...(title ? { title } : {}) });
  }
  return out;
}

// Pull the typed HITL payload out of a message's metadata, if the harness
// attached one (go/api/a2a/hitl.go AttachHITL writes it under the extension URI).
export function parseHitlPayload(metadata: unknown): Record<string, unknown> | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const payload = (metadata as Record<string, unknown>)[HITL_EXTENSION_URI];
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : undefined;
}
