// A2A task frames in, AG-UI run events out. This is the whole translation and it
// is pure: it is handed the frames the facade already parsed
// (`a2a/translate.inspectFrame`) and the verdict the contract already reached
// (`a2a/contract.classifyStreamEnd`), and it returns the event sequence the
// browser's `@ag-ui/client` will accept. It never dials kagent and never touches
// the database, so the sequence can be tested without a cluster.
//
// The client's verifier is strict, and its rules are the shape of this file:
// the first event of a run must be RUN_STARTED; nothing may follow RUN_ERROR or
// RUN_FINISHED except a new RUN_STARTED; TEXT_MESSAGE_CONTENT requires an open
// message with the same id and must be closed by TEXT_MESSAGE_END; an id cannot
// be reopened while it is still open. So every branch here closes what it
// opened before ending the run.
//
// Two mapping decisions are load-bearing, so they are stated rather than implied:
//
// - A failure's `status.message` IS the reason, not an answer. kagent reports a
//   broken credential as an ordinary TASK_STATE_FAILED carrying the provider's
//   text, and `inspectFrame` reads that text as `answer` too (it is a text part).
//   Echoing it as message content would put the error in the transcript and then
//   RUN_ERROR would say it again, so a failed/cancelled/rejected frame emits no
//   text and the reason travels on RUN_ERROR.message — which is the whole reason
//   this protocol was chosen over the artifact workaround.
// - A pause (input-required / auth-required) is not a terminal state. It ends the
//   run with an interrupt outcome, and the question the agent asked reaches the
//   UI exactly once: as message text if the turn is already speaking, as
//   Interrupt.message if it is not.

import { EventType, type Event as AgUiEvent, type Interrupt, type RunFinishedOutcome } from '@ag-ui/core';
import { INTERRUPT_AUTH_REQUIRED, INTERRUPT_INPUT_REQUIRED } from '@fleet-local/shared';
import { truncate, type Settlement } from '../a2a/contract.ts';
import type { WireFrame } from '../a2a/translate.ts';

export interface RunIdentity {
  /** The A2A contextId: the conversation this run belongs to. */
  threadId: string;
  /** The A2A taskId when the controller gave one, else the run we minted. */
  runId: string;
}

export interface TurnEnd {
  settlement: Settlement;
  /** Last task state seen on the wire, already normalized. */
  state?: string;
  taskId?: string;
  contextId?: string;
}

export interface TurnEncoder {
  /** RUN_STARTED: always the first thing written, before any upstream frame. */
  started(): AgUiEvent[];
  /** One parsed A2A frame, in arrival order. */
  frame(frame: WireFrame): AgUiEvent[];
  /** The turn settled: close whatever is open and end the run. */
  end(end: TurnEnd): AgUiEvent[];
  /** The run failed before/at the boundary: close and report RUN_ERROR. */
  fail(message: string, code?: string): AgUiEvent[];
}

const FAILURE_STATES = new Set(['failed', 'cancelled', 'rejected']);

export function createTurnEncoder(identity: RunIdentity): TurnEncoder {
  const messageId = `${identity.runId}-answer`;
  const reasoningId = `${identity.runId}-reasoning`;

  let textOpen = false;
  let textSpoken = false;
  let reasoningOpen = false;
  let closed = false;
  let statusMessage: string | undefined;

  const openText = (): AgUiEvent[] => {
    if (textOpen) return [];
    const opened: AgUiEvent[] = [];
    if (reasoningOpen) {
      reasoningOpen = false;
      opened.push({ type: EventType.REASONING_MESSAGE_END, messageId: reasoningId });
      opened.push({ type: EventType.REASONING_END, messageId: reasoningId });
    }
    textOpen = true;
    opened.push({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
    return opened;
  };

  const closeText = (): AgUiEvent[] => {
    if (!textOpen) return [];
    textOpen = false;
    return [{ type: EventType.TEXT_MESSAGE_END, messageId }];
  };

  const openReasoning = (): AgUiEvent[] => {
    if (reasoningOpen) return [];
    reasoningOpen = true;
    return [
      { type: EventType.REASONING_START, messageId: reasoningId },
      { type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: 'reasoning' },
    ];
  };

  const closeReasoning = (): AgUiEvent[] => {
    if (!reasoningOpen) return [];
    reasoningOpen = false;
    return [
      { type: EventType.REASONING_MESSAGE_END, messageId: reasoningId },
      { type: EventType.REASONING_END, messageId: reasoningId },
    ];
  };

  const closeAll = (): AgUiEvent[] => [...closeText(), ...closeReasoning()];

  const finishWith = (outcome: RunFinishedOutcome, result?: Record<string, string | number | boolean>): AgUiEvent[] => [
    { type: EventType.RUN_FINISHED, threadId: identity.threadId, runId: identity.runId, outcome, result },
  ];

  return {
    started(): AgUiEvent[] {
      return [{ type: EventType.RUN_STARTED, threadId: identity.threadId, runId: identity.runId }];
    },

    frame(frame: WireFrame): AgUiEvent[] {
      // Anything the controller sends after the run is closed is not this run's
      // business: the client rejects events after RUN_FINISHED/RUN_ERROR.
      if (closed) return [];
      if (frame.statusMessage) statusMessage = frame.statusMessage;
      const out: AgUiEvent[] = [];

      // Reasoning first, then the answer: opening the answer closes the thought.
      if (frame.thought) {
        out.push(...openReasoning());
        out.push({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: frame.thought });
      }

      // `inspectFrame` reads a task's status.message as answer text too, so a
      // FAILED frame would otherwise put the error in the transcript and then
      // say it again on RUN_ERROR. Failed state outranks "it is text".
      const failure = frame.state !== undefined && FAILURE_STATES.has(frame.state);
      if (frame.answer && !failure) {
        out.push(...openText());
        textSpoken = true;
        out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: frame.answer });
      }
      return out;
    },

    end({ settlement, state, taskId, contextId }: TurnEnd): AgUiEvent[] {
      if (closed) return [];
      const closing = closeAll();
      const outcome = settlement.outcome;

      if (outcome === 'awaiting_input') {
        // The paused A2A state IS the interrupt reason: one spelling for both,
        // so the UI that matches on it and the facade that wrote it agree.
        const reason = state === INTERRUPT_AUTH_REQUIRED ? INTERRUPT_AUTH_REQUIRED : INTERRUPT_INPUT_REQUIRED;
        const interrupt: Interrupt = {
          // The resume names this interrupt and the task it belongs to, so the
          // id is the controller's task handle whenever we have one.
          id: taskId ?? identity.runId,
          reason,
          // Never say the question twice: it already reached the transcript as
          // message text when the agent put it in a part we streamed.
          ...(textSpoken || !statusMessage ? {} : { message: statusMessage }),
        };
        closed = true;
        return [...closing, ...finishWith({ type: 'interrupt', interrupts: [interrupt] })];
      }

      if (outcome === 'cancelled' || outcome === 'client_abort') {
        closed = true;
        return [...closing, ...finishWith({ type: 'cancelled' })];
      }

      if (outcome === 'completed') {
        closed = true;
        const result: Record<string, string | number | boolean> = {
          contextId: contextId ?? identity.threadId,
          outcome,
          answered: textSpoken,
        };
        if (taskId) result.taskId = taskId;
        return [...closing, ...finishWith({ type: 'success' }, result)];
      }

      // failed / rejected / upstream_error / no_events: the reason is the payload.
      closed = true;
      const message = settlement.reason ?? `the turn ended as ${outcome}`;
      return [...closing, { type: EventType.RUN_ERROR, message: truncate(message), code: outcome }];
    },

    fail(message: string, code = 'run_failed'): AgUiEvent[] {
      if (closed) return [];
      closed = true;
      return [...closeAll(), { type: EventType.RUN_ERROR, message: truncate(message), code }];
    },
  };
}
