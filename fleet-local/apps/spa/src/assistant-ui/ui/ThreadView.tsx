import { useEffect } from 'react';
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
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { useAgUiInterrupts, useAgUiSubmitInterruptResponses } from '@assistant-ui/react-ag-ui';
import { FailureNotice } from '../FailureNotice';
import { MarkdownText } from './Markdown';
import { AddAttachment, AgentFile, ComposerAttachments, FILE_CUSTOM_EVENT, UserFile, UserImage } from './Attachments';
import { HitlCard } from './HitlCard';
import { UI_CUSTOM_EVENT, GenerativeUI } from './GenerativeUI';
import { Suggestions } from './Suggestions';
import { SOURCES_CUSTOM_EVENT, Sources } from './Sources';
import { AutoReadToggle, DictationPreview, MicButton, ReadAloud } from './Voice';
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
  /** Fork a new conversation from this message; see assistant-ui/branches.ts. */
  onFork?: (text: string) => void;
  /** Prefill the composer on mount — the fork seed the previous surface handed up. */
  composerSeed?: string;
}

export function ThreadView({ welcome, placeholder, sendDisabled, run, onAnswerError, onFork, composerSeed }: ThreadViewProps) {
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
            UserMessage: () => <UserMessage onFork={onFork} />,
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
          <Suggestions />
          {/* A structured pause (tool approval, ask-user) asks for decisions, not
              prose; the card sits above the composer, which stays the free-text
              answer path for a plain input-required. */}
          <HitlCard onAnswerError={onAnswerError} />
          <Composer placeholder={placeholder} disabled={sendDisabled} onAnswerError={onAnswerError} seed={composerSeed} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

const UserMessage: FC<{ onFork?: (text: string) => void }> = ({ onFork }) => {
  // Fork only hands the text up: the surface remounts on a new thread handle
  // (Thread.tsx keys it), so anything done to THIS runtime would be discarded.
  // The seed arrives back as `initialComposerText` on the fresh subtree.
  const text = useAuiState((s) => s.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
  return (
    <MessagePrimitive.Root className="aui-user-message-root">
      <div className="aui-user-message-content">
        <MessagePrimitive.Parts components={{ Text: PlainText, Image: UserImage, File: UserFile }} />
        {onFork && text !== '' ? (
          <button
            type="button"
            className="aui-button aui-button-outline aui-message-fork"
            aria-label="Fork a new conversation from this message"
            title="Fork a branch from this message"
            onClick={() => onFork(text)}
          >
            Fork
          </button>
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantMessage: FC<RunFacts> = ({ closeReason, transportError }) => {
  const status = useAuiState((s) => s.message.status);
  // Tool calls count as output: the shell ran, so the turn is not empty even if
  // the answer is a raw/url part we cannot render as text.
  const hasText = useAuiState((s) =>
    s.message.content.some(
      (part) =>
        (part.type === 'text' && part.text !== '') ||
        (part.type === 'tool-call' && (part.argsText !== '' || part.result !== undefined)) ||
        // A file the agent produced is an answer the human can open, even when
        // the turn said nothing about it in words.
        part.type === 'image' ||
        part.type === 'file' ||
        (part.type === 'data' && part.name === FILE_CUSTOM_EVENT),
    ),
  );
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
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Reasoning: Reasoning,
            tools: { Fallback: ToolCall },
            Image: UserImage,
            File: UserFile,
            data: {
              by_name: {
                [FILE_CUSTOM_EVENT]: AgentFile,
                [SOURCES_CUSTOM_EVENT]: Sources,
                [UI_CUSTOM_EVENT]: GenerativeUI,
              },
            },
          }}
        />
        {question === '' ? null : <p className="aui-md-p">{question}</p>}
        <FailureNotice status={status} hasText={hasText || question !== ''} closeReason={closeReason} transportError={transportError} />
        <ReadAloud />
      </div>
    </MessagePrimitive.Root>
  );
};

const PlainText: FC = () => <MessagePartPrimitive.Text className="aui-text" component="p" />;

// The tool payloads arrive whole from the BFF (one ARGS frame per call), so
// there is nothing to stream here — the open question is whether the result has
// come back yet, which is what the running status and the summary say.
const MAX_TOOL_JSON = 4000;

function prettyToolJson(value: string): string {
  let text = value;
  try {
    text = JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    /* harnesses may send a plain string; show it verbatim */
  }
  return text.length > MAX_TOOL_JSON ? `${text.slice(0, MAX_TOOL_JSON)}\n… truncated` : text;
}

const ToolCall: FC<ToolCallMessagePartProps> = ({ toolName, argsText, result, status }) => {
  const pending = result === undefined && status?.type === 'running';
  return (
    <details className="aui-toolcall" open={pending}>
      <summary>
        <span className="aui-toolcall-name">{toolName}</span>
        {result === undefined ? (status?.type === 'running' ? ' running…' : '') : ' returned'}
      </summary>
      {argsText ? <pre className="aui-toolcall-json">{prettyToolJson(argsText)}</pre> : null}
      {result !== undefined ? (
        <pre className="aui-toolcall-json">{prettyToolJson(typeof result === 'string' ? result : JSON.stringify(result))}</pre>
      ) : null}
    </details>
  );
};

// Open while the thought streams so the human sees the agent working; closed
// once it ends so the answer, not the scratchpad, holds the transcript. The
// details element keeps the browser's own toggle for after that.
const Reasoning: FC<{ text: string; status?: { type: string } }> = ({ text, status }) => {
  const running = status?.type === 'running';
  return (
    <details className="aui-reasoning" open={running}>
      <summary>{running ? 'Thinking…' : 'Thought'}</summary>
      <pre>{text}</pre>
    </details>
  );
};

function Composer({
  placeholder,
  disabled,
  onAnswerError,
  seed,
}: {
  placeholder: string;
  disabled: boolean;
  onAnswerError?: (message: string) => void;
  seed?: string;
}) {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const pending = useAgUiInterrupts()[0];
  const submit = useAgUiSubmitInterruptResponses();
  const paused = pending !== undefined;

  // A fork mounts this composer (via the keyed subtree) carrying the message it
  // forked from. Seed it once — the human can edit before running the branch.
  useEffect(() => {
    if (seed) aui.composer.setText(seed);
    // Mount-only by design: a later re-render must not overwrite what they typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      {/* Pending files above the input: the human sees what is about to travel
          with the prompt and can drop one before sending. */}
      <ComposerAttachments />
      <ComposerPrimitive.Input
        className="aui-composer-input"
        rows={1}
        aria-label={paused ? 'Answer the agent' : 'Message the agent'}
        placeholder={paused ? 'Answer the agent to continue this task…' : placeholder}
        disabled={disabled}
        onKeyDown={onKeyDown}
      />
      <AuiIf condition={(s) => !s.thread.isRunning}>
        {/* Attaching to an answer is a new turn, not a reply to the question the
            agent paused on — so the picker stays closed while an interrupt is open. */}
        {paused ? null : <AddAttachment disabled={disabled} />}
        <MicButton disabled={disabled} />
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
      {/* Last in the row, and outside the running branches: it is a preference,
          armed once and left on, not a control for this particular turn. */}
      <AutoReadToggle />
      {/* What the browser heard that is not yet committed to the textarea. */}
      <DictationPreview />
    </ComposerPrimitive.Root>
  );
}
