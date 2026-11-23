import { useA2AArtifacts } from '@assistant-ui/react-a2a';

// Mirrors REASONING_ARTIFACT_ID in packages/shared/src/a2a.ts. A2A has no
// reasoning part kind, and the adapter drops part.metadata, so the facade
// re-emits thought-marked text as this dedicated artifact — the one channel the
// adapter keeps with its identity.
const REASONING_ARTIFACT_ID = 'fleet.dev/reasoning';

// Nothing in the deployed controller emits thought-marked parts yet, so this
// renders only once the harness does. It is the read half of that contract, not
// a working feature today.
export function ThoughtPanel() {
  const artifacts = useA2AArtifacts();
  const reasoning = artifacts.find((artifact) => artifact.artifactId === REASONING_ARTIFACT_ID);
  const text = (reasoning?.parts ?? []).map((part) => part.text ?? '').join('');
  if (!text) return null;

  return (
    <details className="thought" open>
      <summary className="muted small">Reasoning</summary>
      <pre>{text}</pre>
    </details>
  );
}
