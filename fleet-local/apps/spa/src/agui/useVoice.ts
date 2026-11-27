// Voice, both directions, inside the browser: the Web Speech API. No BFF route,
// no provider key, no model, so nothing here touches the egress boundary.
//
// What leaves the machine is the browser's own doing, and it is worth stating
// plainly: Chrome's SpeechRecognition transcribes through Google's speech service,
// and Firefox ships no recognition backend at all (the mic button hides itself —
// see dictationSupported). The voices used for reading aloud are the operating
// system's. The platform stores nothing about either.
//
// Both are runtime adapters, not bespoke hooks, because assistant-ui already owns
// this state: `s.composer.dictation` (with the interim transcript) and
// `s.message.speech`. Hand-rolling the same bookkeeping would only give the
// transcript a second, diverging idea of whether the mic is open.
//
// Escalation, deliberately out of scope: BFF `/api/voice/{stt,tts}` routes proxying
// a provider through the existing LiteLLM/egress config — needed for Safari STT and
// languages the OS voices do not carry.

import { useCallback, useSyncExternalStore } from 'react';
import { WebSpeechDictationAdapter, type DictationAdapter, type SpeechSynthesisAdapter } from '@assistant-ui/react';

type Status = { type: 'starting' | 'running' } | { type: 'ended'; reason: 'finished' | 'cancelled' | 'error'; error?: unknown };

// The library's own WebSpeechSynthesisAdapter speaks the whole message as ONE
// utterance. Chrome stops a long utterance around 15 seconds in, so an answer of
// any length goes silent mid-sentence with no error to show for it. Chunking at
// the sentence boundary is what makes a long reply survivable, and it is the only
// reason this adapter exists.
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+|\n+/;

// A chat answer is markdown: a fenced block read aloud is a wall of indentation
// and punctuation, and `[text](url)` reads the URL. Strip the markup, keep the prose.
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
}

function sentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export const fleetDictation: DictationAdapter = new WebSpeechDictationAdapter();

export function dictationSupported(): boolean {
  return WebSpeechDictationAdapter.isSupported();
}

// A module singleton, not a per-render object: the runtime memoises its adapter
// registry on identity, so a fresh instance every render would churn it.
export const fleetSpeech: SpeechSynthesisAdapter = {
  speak(text) {
    const synth = globalThis.speechSynthesis;
    const utterance = {
      status: { type: 'running' } as Status,
      cancel: () => {},
      subscribe: (_callback: () => void) => () => {},
    };
    if (!synth) {
      utterance.status = { type: 'ended', reason: 'error', error: 'this browser has no speech synthesis' };
      return utterance;
    }

    const queue = sentences(speakable(text));
    const listeners = new Set<() => void>();
    let cancelled = false;

    const settle = (reason: 'finished' | 'cancelled' | 'error', error?: unknown) => {
      if (utterance.status.type === 'ended') return;
      utterance.status = { type: 'ended', reason, ...(error === undefined ? {} : { error }) };
      for (const listener of [...listeners]) listener();
    };

    // The runtime reads `utterance.status` inside the notification, so the object
    // is mutated rather than replaced — same shape the library's adapter uses.
    utterance.subscribe = (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    };
    utterance.cancel = () => {
      if (cancelled) return;
      cancelled = true;
      queue.length = 0;
      try {
        synth.cancel();
      } catch {
        /* a browser that refuses to cancel still must not leave the button stuck */
      }
      settle('cancelled');
    };

    if (queue.length === 0) settle('finished');
    const speakNext = (): void => {
      if (cancelled) return;
      const next = queue.shift();
      if (next === undefined) {
        settle('finished');
        return;
      }
      const chunk = new SpeechSynthesisUtterance(next);
      chunk.lang = navigator.language || 'en-US';
      chunk.onend = () => {
        // Deferred: `onend` fires inside the synthesis event loop, and a synchronous
        // `speak()` from there is dropped by some browsers.
        setTimeout(speakNext, 0);
      };
      chunk.onerror = (event) => {
        // An interruption of the FIRST chunk is a browser that will not speak at all
        // (no voice loaded yet, or the page lacks a user gesture); later ones are a
        // lost chunk, which the queue already moved past.
        if (cancelled) return;
        settle('error', event.error ?? 'speech synthesis failed');
      };
      synth.speak(chunk);
    };
    speakNext();
    return utterance;
  },
};

// Read every new answer aloud, for the hands-busy case. One global switch rather
// than a per-thread one: it is an accessibility preference, not a property of a
// conversation, and it survives a reload the way the rest of the UI's do.
const AUTO_READ_KEY = 'fleet.voice.autoRead';

const readStored = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(AUTO_READ_KEY) === '1';
  } catch {
    return false;
  }
};

let autoRead = readStored();
const autoReadListeners = new Set<() => void>();

const subscribeAutoRead = (callback: () => void): (() => void) => {
  autoReadListeners.add(callback);
  return () => autoReadListeners.delete(callback);
};

// Answers spoken this page session, so a resume that reloads the transcript does
// not read the whole history aloud a second time.
const spoken = new Set<string>();

export function markSpoken(messageId: string): boolean {
  if (spoken.has(messageId)) return false;
  spoken.add(messageId);
  return true;
}

export function useAutoRead(): { enabled: boolean; toggle: () => void } {
  const enabled = useSyncExternalStore(subscribeAutoRead, () => autoRead, () => autoRead);
  const toggle = useCallback(() => {
    autoRead = !autoRead;
    try {
      globalThis.localStorage?.setItem(AUTO_READ_KEY, autoRead ? '1' : '0');
    } catch {
      /* a private-mode store that throws must not break the button */
    }
    for (const listener of [...autoReadListeners]) listener();
  }, []);
  return { enabled, toggle };
}
