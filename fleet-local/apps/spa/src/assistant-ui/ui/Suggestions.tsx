import { useEffect, useMemo, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { deriveSuggestions } from './followups';

// Chips derived from the agent's last answer (see followups.ts), shown only
// when the thread is idle so they never compete with a run in flight. Clicking
// one fills the composer rather than sending it: the human still chooses.
export function Suggestions() {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const messages = useAuiState((s) => s.thread.messages);
  const [dismissed, setDismissed] = useState(false);

  const lastAnswer = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== 'assistant') continue;
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => ('text' in part ? part.text : ''))
        .join('');
      // Only the most recent assistant turn, and only if it is the last message
      // (a user reply already superseded the moment these chips were relevant).
      if (text.trim() === '') continue;
      return i === messages.length - 1 ? text : undefined;
    }
    return undefined;
  }, [messages]);

  // A new answer re-arms the chips the human dismissed for the previous one.
  useEffect(() => setDismissed(false), [lastAnswer]);

  const items = useMemo(() => (lastAnswer ? deriveSuggestions(lastAnswer) : []), [lastAnswer]);
  if (isRunning || dismissed || items.length === 0) return null;

  return (
    <div className="aui-suggestions" role="group" aria-label="Suggested follow-ups">
      {items.map((text) => (
        <button
          key={text}
          type="button"
          className="aui-suggestion"
          onClick={() => {
            aui.composer.setText(text);
            setDismissed(true);
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
