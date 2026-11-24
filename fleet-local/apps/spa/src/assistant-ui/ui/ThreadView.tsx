import type { FC, KeyboardEvent } from 'react';
import {
  AuiIf,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { useAgUiInterrupts, useAgUiSubmitInterruptResponses } from '@assistant-ui/react-ag-ui';
import { FailureNotice } from '../FailureNotice';
import { MarkdownText } from './Markdown';
import { ArrowDownIcon, SendIcon, StopIcon } from './icons';

// The chat in the library's shape. Every element carries the `.aui-*` class that
// @assistant-ui/react-ui's standalone stylesheet paints, on the primitives of the
// core we actually run (0.15). The library's own components are not used: 0.2.1
// renders through hooks the current core no longer exports (`useThread`,
// `ThreadPrimitive.If`), declares prop types inside TS `namespace` blocks this repo
// forbids, and pulls lucide-react for three icons.
//
// What is kept is the markup contract: root/viewport/footer nesting, one
// `aui-*-message-root` grid per turn, and the sticky composer.

export interface RunFacts {
  /** sessions.close_reason for this conversation, as recorded by the facade. */
  closeReason?: string | null;
  /** The transport-level error, when the run never reached a task. */
  transportError?: string;
}

export interface ThreadViewProps {
  welcome: string;
  placeholder: string;
  sendDisabled: boolean;
  run: RunFacts;
  /** Reporting a resume the endpoint refused, in the same place as a run error. */
  onAnswerError?: (message: string) => void;
}

export function ThreadView({ welcome, placeholder, sendDisabled, run, onAnswerError }: ThreadViewProps) {
  return (
    <ThreadPrimitive.Root className="aui-root aui-thread-root">
      <ThreadPrimitive.Viewport className="aui-thread-viewport">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <div className="aui-thread-welcome-root">
            <div className="aui-thread-welcome-center">
              <p className="aui-thread-welcome-message">{welcome}</p>
            </div>
          </div>
        </AuiIf>

        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage: () => <AssistantMessage {...run} />,
          }}
        />

        {/* The library pushes the footer down an empty-looking column with a
            flexGrow spacer; without it the sticky composer sits under the last
            bubble instead of at the bottom of the viewport. */}
        <AuiIf condition={(s) => !s.thread.isEmpty}>
          <div style={{ flexGrow: 1 }} />
        </AuiIf>

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer">
          <ThreadPrimitive.ScrollToBottom asChild>
            <button
              type="button"
              className="aui-button aui-button-outline aui-button-icon aui-thread-scroll-to-bottom"
              aria-label="Scroll to bottom"
            >
              <ArrowDownIcon />
            </button>
          </ThreadPrimitive.ScrollToBottom>
          <Composer placeholder={placeholder} disabled={sendDisabled} onAnswerError={onAnswerError} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="aui-user-message-root">
    <div className="aui-user-message-content">
      <MessagePrimitive.Parts components={{ Text: PlainText }} />
    </div>
  </MessagePrimitive.Root>
);

const AssistantMessage: FC<RunFacts> = ({ closeReason, transportError }) => {
  const status = useAuiState((s) => s.message.status);
  const hasText = useAuiState((s) => s.message.content.some((part) => part.type === 'text' && part.text !== ''));
  // A pause is not a failure: the run ended with an interrupt, and the question
  // it carries is the thing the human has to read. It reached the transcript as
  // text whenever the agent also said it in a part, and the encoder leaves it out
  // of the interrupt then, so this prints it only when nothing else does.
  const paused = status?.type === 'requires-action' && status.reason === 'interrupt';
  const interrupts = useAgUiInterrupts();
  const question = paused ? interrupts.map((interrupt) => interrupt.message ?? '').filter((text) => text !== '').join('\n') : '';

  return (
    <MessagePrimitive.Root className="aui-assistant-message-root">
      {/* The grid reserves column 1 for the avatar, and the library paints one per
          turn; radix's Avatar is not a dependency, so the fallback is the element. */}
      <div className="aui-avatar-root">
        <span className="aui-avatar-fallback">A</span>
      </div>
      <div className="aui-assistant-message-content">
        <MessagePrimitive.Parts components={{ Text: MarkdownText, Reasoning: Reasoning }} />
        {question === '' ? null : <p className="aui-md-p">{question}</p>}
        <FailureNotice status={status} hasText={hasText || question !== ''} closeReason={closeReason} transportError={transportError} />
      </div>
    </MessagePrimitive.Root>
  );
};

const PlainText: FC = () => <MessagePartPrimitive.Text className="aui-text" component="p" />;

const Reasoning: FC<{ text: string }> = ({ text }) => (
  <details className="aui-reasoning">
    <summary>Thinking</summary>
    <pre>{text}</pre>
  </details>
);

function Composer({
  placeholder,
  disabled,
  onAnswerError,
}: {
  placeholder: string;
  disabled: boolean;
  onAnswerError?: (message: string) => void;
}) {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const pending = useAgUiInterrupts()[0];
  const submit = useAgUiSubmitInterruptResponses();
  const paused = pending !== undefined;

  // An open interrupt blocks an ordinary send — the runtime refuses to start a
  // second run over a conversation the agent is still waiting on — so the typed
  // words go back as its answer instead. That is the same turn continuing, on the
  // A2A side exactly what replying to a paused task used to be.
  async function answer() {
    const reply = text.trim();
    if (!reply || !pending) return;
    // The way a send empties the composer: before the run, not after it.
    aui.composer.setText('');
    try {
      await submit([{ interruptId: pending.id, status: 'resolved', payload: reply }]);
    } catch (err) {
      onAnswerError?.(err instanceof Error ? err.message : String(err));
    }
  }

  // Enter is the other half of the same decision: the composer's own submit path
  // is the ordinary send, and the runtime refuses to start a run over a paused
  // one — so on a paused conversation Enter answers, exactly like the button.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!paused || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void answer();
  }

  return (
    <ComposerPrimitive.Root className="aui-composer-root">
      <ComposerPrimitive.Input
        className="aui-composer-input"
        rows={1}
        aria-label={paused ? 'Answer the agent' : 'Message the agent'}
        placeholder={paused ? 'Answer the agent to continue this task…' : placeholder}
        disabled={disabled}
        onKeyDown={onKeyDown}
      />
      <AuiIf condition={(s) => !s.thread.isRunning}>
        {paused ? (
          <button
            type="button"
            className="aui-button aui-button-primary aui-composer-send"
            aria-label="Answer"
            disabled={disabled || text.trim() === ''}
            onClick={() => void answer()}
          >
            <SendIcon />
          </button>
        ) : (
          <ComposerPrimitive.Send className="aui-button aui-button-primary aui-composer-send" aria-label="Send" disabled={disabled}>
            <SendIcon />
          </ComposerPrimitive.Send>
        )}
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel type="button" className="aui-button aui-button-outline aui-composer-cancel" aria-label="Stop">
          <StopIcon />
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </ComposerPrimitive.Root>
  );
}
