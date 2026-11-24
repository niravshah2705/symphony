import { useAui } from '@assistant-ui/react';
import type { MessageStatus } from '@assistant-ui/react';

export interface FailureNoticeProps {
  status: MessageStatus | undefined;
  /** Whether the bubble already carries the agent's own words. */
  hasText: boolean;
  /** sessions.close_reason for this conversation, as recorded by the facade. */
  closeReason?: string | null;
  /** The transport-level error, when the run never reached a task. */
  transportError?: string;
}

// The whole point of the facade: a turn that produced nothing says WHY, in the
// words the BFF actually recorded, instead of the literal string "(no output)".
// A broken provider credential arrives as the task's own status message, so it
// is already in the bubble; this notice adds the verdict and the Retry.
export function FailureNotice({ status, hasText, closeReason, transportError }: FailureNoticeProps) {
  const aui = useAui();
  const retry = (
    <button className="ghost" onClick={() => aui.message.reload()}>
      Retry
    </button>
  );

  if (!status) return null;

  if (status.type === 'incomplete') {
    if (status.reason === 'cancelled') {
      return (
        <div className="notice">
          <span className="muted small">This turn was cancelled.</span>
          {retry}
        </div>
      );
    }
    const cause =
      transportError || closeReason || (typeof status.error === 'string' ? status.error : '') || 'no reason was recorded';
    return (
      <div className="notice">
        <span className="error small">
          {hasText ? 'The agent could not finish this turn.' : `The agent could not finish this turn: ${cause}`}
        </span>
        {retry}
      </div>
    );
  }

  if (status.type === 'complete' && !hasText) {
    return (
      <div className="notice">
        <span className="muted small">{closeReason || 'the agent completed the turn without producing any output'}</span>
        {retry}
      </div>
    );
  }

  return null;
}
