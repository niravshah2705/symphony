import { useAuiState } from '@assistant-ui/react';
import { useAgUiInterrupts } from '@assistant-ui/react-ag-ui';

// Mirrors INTERRUPT_INPUT_REQUIRED / INTERRUPT_AUTH_REQUIRED in
// packages/shared/src/agui.ts: the paused A2A state IS the interrupt reason the
// encoder writes, so this is the same two words the facade settled the row with.
// A drift here costs an operator the plain-language label, not the turn.
const INPUT_REQUIRED = 'input-required';
const AUTH_REQUIRED = 'auth-required';

// The tones reuse the house badge classes (styles.css), so the chat header
// matches the wizard.
export function TaskStatusBar() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const interrupts = useAgUiInterrupts();
  const paused = interrupts[0];

  if (paused) {
    const meta =
      paused.reason === AUTH_REQUIRED
        ? { label: 'needs approval', tone: 'state' }
        : paused.reason === INPUT_REQUIRED
          ? { label: 'awaiting your reply', tone: 'state' }
          : { label: `waiting: ${paused.reason}`, tone: 'state' };
    // The interrupt id IS the paused A2A task, which is the handle an operator
    // follows in the session row and the kagent logs.
    return (
      <>
        <span className="muted small">Reply below to continue the same task.</span>
        <span className="muted small">task {paused.id.slice(0, 8)}</span>
        <span className={`badge badge-${meta.tone}`}>{meta.label}</span>
      </>
    );
  }

  if (!isRunning) return null;
  return <span className="badge badge-running">working</span>;
}
