import { useEffect, useRef } from 'react';
import type { FC } from 'react';
import { AuiIf, ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { dictationSupported, markSpoken, useAutoRead } from '../../agui/useVoice';
import { MicIcon, SpeakerIcon, SpeakerOffIcon } from './icons';

// Voice controls, in the runtime's own vocabulary: the mic is the composer's
// dictation session (`s.composer.dictation`, whose interim transcript the runtime
// already tracks and rebases against edits) and reading aloud is a message's
// speech utterance (`s.message.speech`). Neither button keeps state of its own.

// The interim line under the input: what the browser heard so far. Committed
// sentences go into the textarea itself, so this only shows the tail that is
// still being recognized — the human sees whether to keep talking.
export const DictationPreview: FC = () => (
  <AuiIf condition={(s) => s.composer.dictation !== undefined}>
    <p className="aui-voice-interim">
      <ComposerPrimitive.DictationTranscript />
    </p>
  </AuiIf>
);

// One button that is the session's state: press to listen, press again to stop.
// The two primitives are mutually exclusive because `AuiIf` picks the branch, and
// each is a plain composer button — no handler of ours is involved.
export const MicButton: FC<{ disabled: boolean }> = ({ disabled }) => {
  // Firefox ships no SpeechRecognition backend, so the button would sit there
  // doing nothing. Chrome's implementation transcribes through Google's speech
  // service (see agui/useVoice.ts), which is why it is opt-in per click rather
  // than a always-hot microphone.
  if (!dictationSupported()) return null;
  return (
    <>
      <AuiIf condition={(s) => s.composer.dictation === undefined}>
        <ComposerPrimitive.Dictate
          className="aui-button aui-button-outline aui-button-icon aui-voice-mic"
          aria-label="Dictate a message"
          title="Dictate with the microphone"
          disabled={disabled}
        >
          <MicIcon />
        </ComposerPrimitive.Dictate>
      </AuiIf>
      <AuiIf condition={(s) => s.composer.dictation !== undefined}>
        <ComposerPrimitive.StopDictation
          className="aui-button aui-button-outline aui-button-icon aui-voice-mic is-listening"
          aria-label="Stop dictating"
          title="Listening — click to stop"
        >
          <MicIcon />
        </ComposerPrimitive.StopDictation>
      </AuiIf>
    </>
  );
};

// Read every new answer, for the hands-busy case. Global rather than per thread:
// it is an accessibility preference, not a property of a conversation.
export const AutoReadToggle: FC = () => {
  const { enabled, toggle } = useAutoRead();
  return (
    <button
      type="button"
      className={`aui-button aui-button-outline aui-button-icon aui-voice-auto${enabled ? ' is-on' : ''}`}
      aria-pressed={enabled}
      aria-label={enabled ? 'Stop reading answers aloud' : 'Read answers aloud'}
      title={enabled ? 'Reading new answers aloud — click to stop' : 'Read every new answer aloud'}
      onClick={toggle}
    >
      <SpeakerIcon />
    </button>
  );
};

// Per answer: read this one, or stop it. The runtime speaks one message at a
// time, so starting here interrupts whatever was playing before.
export const ReadAloud: FC = () => {
  const aui = useAui();
  const auiRef = useRef(aui);
  auiRef.current = aui;

  const id = useAuiState((s) => s.message.id);
  const isLast = useAuiState((s) => s.message.isLast);
  const done = useAuiState((s) => s.message.status?.type === 'complete');
  const hasText = useAuiState((s) => s.message.content.some((part) => part.type === 'text' && part.text.trim() !== ''));
  const speaking = useAuiState((s) => {
    const speech = s.message.speech;
    return speech !== undefined && speech.messageId === s.message.id && speech.status.type !== 'ended';
  });
  const auto = useAutoRead().enabled;

  // Only the newest answer, and only once per message: a toggle flipped an hour
  // into a conversation must not read the whole transcript, and resuming a stored
  // session must not read the history back at the human.
  useEffect(() => {
    if (!auto || !done || !isLast || !hasText || speaking) return;
    if (!markSpoken(id)) return;
    auiRef.current.message.speak();
    // `speaking` is deliberately not a dependency: it is what this effect causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, done, isLast, hasText, id]);

  if (!hasText) return null;
  return (
    <button
      type="button"
      className="aui-button aui-button-ghost aui-voice-read"
      aria-label={speaking ? 'Stop reading this answer' : 'Read this answer aloud'}
      title={speaking ? 'Stop' : 'Read aloud'}
      onClick={() => (speaking ? aui.message.stopSpeaking() : aui.message.speak())}
    >
      {speaking ? <SpeakerOffIcon /> : <SpeakerIcon />}
    </button>
  );
};
