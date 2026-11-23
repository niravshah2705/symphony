// kagent delivers the answer as an A2A **artifact**, and the adapter keeps
// artifacts on `message.metadata.custom.a2a.artifacts` instead of merging them
// into message content (A2AThreadController: `handleArtifactUpdate` only calls
// `updateAssistantArtifacts`; only a `status.message` or an agent `message`
// becomes content). So a bubble driven by `MessagePrimitive.Parts` alone renders
// nothing for a turn that really did answer — which is why the transcript looked
// identical to the old `(no output)`. These helpers read the channel the answer
// actually arrives on.

/** Mirrors REASONING_ARTIFACT_ID in packages/shared/src/a2a.ts. */
export const REASONING_ARTIFACT_ID = 'fleet.dev/reasoning';

export interface ArtifactPart {
  text?: string;
}

export interface ArtifactLike {
  artifactId?: string;
  name?: string;
  parts?: ArtifactPart[];
}

// The metadata is written by the adapter, but it reaches us as unknown: a hand
// resumed row or a different adapter build must not be able to throw in render.
export function messageArtifacts(metadata: unknown): ArtifactLike[] {
  if (typeof metadata !== 'object' || metadata === null) return [];
  const custom = (metadata as { custom?: unknown }).custom;
  if (typeof custom !== 'object' || custom === null) return [];
  const a2a = (custom as { a2a?: unknown }).a2a;
  if (typeof a2a !== 'object' || a2a === null) return [];
  const artifacts = (a2a as { artifacts?: unknown }).artifacts;
  return Array.isArray(artifacts) ? (artifacts as ArtifactLike[]) : [];
}

// Joined text of every artifact except the ones the caller renders elsewhere.
export function artifactText(artifacts: readonly ArtifactLike[], skipIds: readonly string[] = []): string {
  return artifacts
    .filter((artifact) => !skipIds.includes(artifact.artifactId ?? ''))
    .map((artifact) => (artifact.parts ?? []).map((part) => part.text ?? '').join(''))
    .join('\n')
    .trim();
}
