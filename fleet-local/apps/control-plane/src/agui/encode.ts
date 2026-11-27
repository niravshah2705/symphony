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
import {
  INTERRUPT_AUTH_REQUIRED,
  INTERRUPT_INPUT_REQUIRED,
  FILE_CUSTOM_EVENT,
  SOURCES_CUSTOM_EVENT,
  UI_CUSTOM_EVENT,
  sourcesFromToolResult,
  uiSpecFor,
  type UiSpec,
} from '@fleet-local/shared';
import { truncate, type Settlement } from '../a2a/contract.ts';
import type { WireFile, WireFrame } from '../a2a/translate.ts';

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
  // The typed HITL payload (tool_approval_request / ask_user_request) the
  // harness attached to the pausing message. It rides out to the UI on the
  // interrupt's metadata, because an Interrupt has no field for anything else.
  let hitl: Record<string, unknown> | undefined;

  // Tool calls arrive as separate artifacts (call, then result) and every one of
  // them is replayed inside the final task frame, so each id is emitted at most
  // once per run. A tool sequence never closes an open text/reasoning block:
  // a harness streams "text, tool, more text" for one answer, and the answer's
  // messageId may not be reopened once ended.
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  // Files ride the same replay as tools, so each one is emitted once. An inline
  // image and the URI of the image it was uploaded from are different objects,
  // hence the byte-prefix key rather than the name alone.
  const fileIds = new Set<string>();
  const fileKey = (file: WireFile): string =>
    file.uri ?? `${file.name ?? ''}|${file.mimeType ?? ''}|${file.bytes?.length ?? 0}|${file.bytes?.slice(0, 64) ?? ''}`;

  // Citations are collected across the whole run and spoken once, after the
  // answer: a chip per page the agent's web tools fetched, deduped by URL so the
  // final-task artifact replay cannot double the list.
  const sources: { url: string; title?: string }[] = [];
  const noteSources = (activity: NonNullable<WireFrame['toolCalls']>[number]): void => {
    if (activity.kind !== 'function_response') return;
    for (const source of sourcesFromToolResult(activity.name, activity.response)) {
      if (sources.some((seen) => seen.url === source.url)) continue;
      sources.push(source);
    }
  };
  const sourcesEvent = (): AgUiEvent[] =>
    sources.length === 0
      ? []
      : [{ type: EventType.CUSTOM, name: SOURCES_CUSTOM_EVENT, value: { sources } }];

  // The structured result is the run's terminal payload, so it is spoken once,
  // with the answer closed, exactly like the citations beside it.
  let ui: UiSpec | undefined;
  const uiEvent = (): AgUiEvent[] => (ui ? [{ type: EventType.CUSTOM, name: UI_CUSTOM_EVENT, value: ui }] : []);

  const fileEvents = (file: WireFile): AgUiEvent[] => {
    const key = fileKey(file);
    if (fileIds.has(key)) return [];
    fileIds.add(key);
    const value: Record<string, string> = {};
    if (file.bytes !== undefined) value.dataUri = `data:${file.mimeType ?? 'application/octet-stream'};base64,${file.bytes}`;
    if (file.uri !== undefined) value.uri = file.uri;
    if (file.mimeType !== undefined) value.mimeType = file.mimeType;
    if (file.name !== undefined) value.name = file.name;
    return [{ type: EventType.CUSTOM, name: FILE_CUSTOM_EVENT, value }];
  };

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

  const resultContent = (value: unknown): string => {
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  };

  // One function_call / function_response part as the AG-UI sequence. A result
  // whose call was never seen (a stripped or out-of-order artifact) still gets a
  // synthetic start so the verifier sees a closed call before its result.
  const toolEvents = (activity: NonNullable<WireFrame['toolCalls']>[number]): AgUiEvent[] => {
    if (!activity.id) return [];
    const out: AgUiEvent[] = [];
    if (activity.kind === 'function_call') {
      if (callIds.has(activity.id)) return [];
      callIds.add(activity.id);
      out.push({ type: EventType.TOOL_CALL_START, toolCallId: activity.id, toolCallName: activity.name });
      out.push({ type: EventType.TOOL_CALL_ARGS, toolCallId: activity.id, delta: JSON.stringify(activity.args ?? {}) });
      out.push({ type: EventType.TOOL_CALL_END, toolCallId: activity.id });
      return out;
    }
    if (resultIds.has(activity.id)) return [];
    resultIds.add(activity.id);
    if (!callIds.has(activity.id)) {
      callIds.add(activity.id);
      out.push({ type: EventType.TOOL_CALL_START, toolCallId: activity.id, toolCallName: activity.name });
      out.push({ type: EventType.TOOL_CALL_END, toolCallId: activity.id });
    }
    out.push({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${identity.runId}-tool-${activity.id}-result`,
      toolCallId: activity.id,
      content: resultContent(activity.response),
      role: 'tool',
    });
    return out;
  };

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
      if (frame.hitl) hitl = frame.hitl;
      const out: AgUiEvent[] = [];

      // Reasoning first, then the answer: opening the answer closes the thought.
      if (frame.thought) {
        out.push(...openReasoning());
        out.push({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: frame.thought });
      }

      const failure = frame.state !== undefined && FAILURE_STATES.has(frame.state);

      // Tools before the answer: a tool result is what the following text
      // summarizes, and on a failed frame the status message is the payload —
      // a stale mid-flight tool card would only confuse the UI.
      if (!failure && frame.toolCalls) {
        for (const activity of frame.toolCalls) {
          out.push(...toolEvents(activity));
          noteSources(activity);
        }
      }

      // Files after tools and before the text: the artifact is what the
      // following sentence describes, and a failed frame's status message is
      // the payload, exactly as above.
      if (!failure && frame.files) {
        for (const file of frame.files) out.push(...fileEvents(file));
      }

      if (!failure && frame.structured) ui = uiSpecFor(frame.structured.value);

      // `inspectFrame` reads a task's status.message as answer text too, so a
      // FAILED frame would otherwise put the error in the transcript and then
      // say it again on RUN_ERROR. Failed state outranks "it is text".
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
          // The structured request (which tools await approval, which questions
          // await answers) so the UI can render a decision card, not a textbox.
          ...(hitl ? { metadata: { hitl } } : {}),
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
        // Citations land under the answer, once, after the text is closed — a
        // chip list mid-sentence would split the message the human is reading.
        return [...closing, ...sourcesEvent(), ...uiEvent(), ...finishWith({ type: 'success' }, result)];
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
