import type { FC } from 'react';
import {
  AuiIf,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import { artifactText, messageArtifacts, REASONING_ARTIFACT_ID } from '../../a2a/artifacts';
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

export function ThreadView({
  welcome,
  placeholder,
  sendDisabled,
  run,
}: {
  welcome: string;
  placeholder: string;
  sendDisabled: boolean;
  run: RunFacts;
}) {
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
          <Composer placeholder={placeholder} disabled={sendDisabled} />
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
  const metadata = useAuiState((s) => s.message.metadata);
  // The channel kagent answers on for the A2A leg: an artifact, which the adapter
  // keeps on message metadata rather than in content. Content wins when the task
  // also put the text in a status message, so a reply is never printed twice.
  const answer = artifactText(messageArtifacts(metadata), [REASONING_ARTIFACT_ID]);
  return (
    <MessagePrimitive.Root className="aui-assistant-message-root">
      {/* The grid reserves column 1 for the avatar, and the library paints one per
          turn; radix's Avatar is not a dependency, so the fallback is the element. */}
      <div className="aui-avatar-root">
        <span className="aui-avatar-fallback">A</span>
      </div>
      <div className="aui-assistant-message-content">
        <MessagePrimitive.Parts components={{ Text: MarkdownText, Reasoning: Reasoning }} />
        {hasText || answer === '' ? null : <p className="aui-md-p">{answer}</p>}
        <FailureNotice status={status} hasText={hasText || answer !== ''} closeReason={closeReason} transportError={transportError} />
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

function Composer({ placeholder, disabled }: { placeholder: string; disabled: boolean }) {
  return (
    <ComposerPrimitive.Root className="aui-composer-root">
      <ComposerPrimitive.Input
        className="aui-composer-input"
        rows={1}
        aria-label="Message the agent"
        placeholder={placeholder}
        disabled={disabled}
      />
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send
          className="aui-button aui-button-primary aui-composer-send"
          aria-label="Send"
          disabled={disabled}
        >
          <SendIcon />
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel type="button" className="aui-button aui-button-outline aui-composer-cancel" aria-label="Stop">
          <StopIcon />
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </ComposerPrimitive.Root>
  );
}
