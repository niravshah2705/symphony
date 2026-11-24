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
export const TOOL_APPROVAL_RESPONSE_TYPE = 'tool_approval_response';

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
