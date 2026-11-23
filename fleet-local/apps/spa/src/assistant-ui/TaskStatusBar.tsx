import { useAuiState } from '@assistant-ui/react';
import { useA2ATask, type A2ATaskState } from '@assistant-ui/react-a2a';

// The nine A2A task states, in the words an operator uses. The tones reuse the
// house badge classes (styles.css), so the chat header matches the wizard.
const STATE_META: Record<A2ATaskState, { label: string; tone: string; hint?: string }> = {
  unspecified: { label: 'no state yet', tone: '' },
  submitted: { label: 'submitted', tone: 'running' },
  working: { label: 'working', tone: 'running' },
  completed: { label: 'completed', tone: 'done' },
  failed: { label: 'failed', tone: 'failed' },
  canceled: { label: 'cancelled', tone: 'failed' },
  rejected: { label: 'rejected', tone: 'failed' },
  input_required: { label: 'awaiting your reply', tone: 'state', hint: 'Reply below to continue the same task.' },
  auth_required: { label: 'needs approval', tone: 'state', hint: 'Reply below to continue the same task.' },
};

export function TaskStatusBar() {
  const task = useA2ATask();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const state = task?.status.state ?? (isRunning ? 'working' : undefined);
  if (!state) return null;

  const meta = STATE_META[state] ?? STATE_META.unspecified;
  return (
    <>
      {meta.hint ? <span className="muted small">{meta.hint}</span> : null}
      {task?.id ? <span className="muted small">task {task.id.slice(0, 8)}</span> : null}
      <span className={`badge${meta.tone ? ` badge-${meta.tone}` : ''}`}>{meta.label}</span>
    </>
  );
}
