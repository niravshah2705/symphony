// Pure A2A protocol policy: how a wire state classifies, how a finished stream
// settles, and how a failure is described to the client. No I/O, no Fastify —
// everything here is unit-testable and is the single place these rules live.

export type Outcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'upstream_error'
  | 'client_abort'
  | 'no_events'
  | 'awaiting_input';

export type StateClass = 'terminal' | 'paused' | 'running';

export const OUTCOMES: readonly Outcome[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'upstream_error',
  'client_abort',
  'no_events',
  'awaiting_input',
];

// A text column can hold anything; reading it back through this guard is what
// keeps a hand-edited row from becoming a phantom billing outcome.
export function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

// Error messages reach a human; bodies do not.
const REASON_LIMIT = 500;

export function truncate(text: string, limit = REASON_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// The same state arrives in three spellings depending on which A2A binding
// produced it: proto enums (TASK_STATE_INPUT_REQUIRED), the REST/JS SDK's
// snake_case (input_required), and pre-1.0 kebab-case (input-required).
// kagent's controller emits the proto form; assistant-ui's client expects the
// snake_case form and converts on read. Canonicalise to kebab-case internally.
export function normalizeState(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let state = raw.trim();
  if (!state) return undefined;
  if (state.startsWith('TASK_STATE_')) state = state.slice('TASK_STATE_'.length);
  state = state.toLowerCase().replace(/_/g, '-');
  if (state === 'unspecified') return undefined;
  // The proto name is CANCELED (one L). The pre-1.0 codebase spelled it
  // CANCELLED, and the BFF's own terminal set spelled it with two — which is how
  // a cancelled task slipped through unmatched and never got metered.
  if (state === 'canceled') state = 'cancelled';
  return state;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const PAUSED = new Set(['input-required', 'auth-required']);

// kagent reports a broken MODEL CREDENTIAL as an ordinary TASK_STATE_FAILED whose
// status.message is the provider's own text (proved live: "OpenAI API error: 401
// Unauthorized" from an expired OpenRouter key). The user's rule is that a turn
// the platform broke is never billed, so this recognises that class. It is
// deliberately conservative — an unrecognised failure stays 'failed' and is
// billed, because the agent really did run. Written off, never silently charged:
// the reason text still reaches the UI.
const PLATFORM_FAULT =
  /unauthorized|invalid api key|authentication|\b401\b|\b402\b|\b429\b|payment required|rate limit|insufficient (quota|credit|balance)|no healthy upstream|service unavailable|overloaded/i;

export function isPlatformFault(reason: string | undefined): boolean {
  return reason !== undefined && reason !== '' && PLATFORM_FAULT.test(reason);
}

export function classifyState(raw: unknown): StateClass {
  const state = normalizeState(raw);
  if (!state) return 'running';
  if (TERMINAL.has(state)) return 'terminal';
  if (PAUSED.has(state)) return 'paused';
  return 'running';
}

export function outcomeForState(raw: unknown): Outcome {
  const state = normalizeState(raw);
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'rejected') return 'rejected';
  if (state === 'input-required' || state === 'auth-required') return 'awaiting_input';
  return 'completed';
}

export interface StreamEndInput {
  /** Last task state observed on the wire, if any. */
  state?: string;
  /** status.message text from the wire — the agent's own explanation of a failure. */
  failureMessage?: string;
  /** Upstream response status, when the POST itself did not succeed. */
  httpStatus?: number;
  /** Upstream response body, when the POST did not succeed. */
  upstreamBody?: string;
  /** The browser went away before the turn settled. */
  aborted?: boolean;
  /** Transport error thrown while reading the stream. */
  readError?: string;
  /**
   * A JSON-RPC `error` member carried inside a 200 response or an SSE frame.
   * kagent reports an application failure this way, so the HTTP status alone is
   * never the verdict.
   */
  rpcError?: string;
  /** How many SSE data frames were forwarded; 0 means the upstream produced nothing. */
  framesSeen?: number;
  /**
   * False when the turn produced no artifact, message or status part. A task can
   * legitimately complete with nothing in it (the mock worker does exactly that),
   * so "completed" alone does not explain an empty bubble to the user — the
   * reason does, and it is still billable compute.
   */
  answered?: boolean;
}

export interface Settlement {
  outcome: Outcome;
  reason: string | null;
}

// Decide what a finished turn was, in one place, so the session row and the UI
// can never disagree. Order matters: an authoritative terminal state on the wire
// outranks the fact that the client then disconnected, because the run really did
// finish (and really did fail) either way.
export function classifyStreamEnd(input: StreamEndInput): Settlement {
  if (input.httpStatus !== undefined && input.httpStatus >= 400) {
    return {
      outcome: 'upstream_error',
      reason: truncate(`kagent stream failed (${input.httpStatus}): ${input.upstreamBody ?? ''}`),
    };
  }

  const state = normalizeState(input.state);
  if (state && (TERMINAL.has(state) || PAUSED.has(state))) {
    const outcome = outcomeForState(state);
    if (outcome === 'failed') {
      const reason = truncate(input.failureMessage ?? 'the agent reported a failure');
      if (isPlatformFault(input.failureMessage)) return { outcome: 'upstream_error', reason };
      return { outcome, reason };
    }
    if (outcome === 'completed' && input.answered === false) {
      return { outcome, reason: 'the agent completed the turn without producing any output' };
    }
    return { outcome, reason: null };
  }

  if (input.rpcError) {
    // The task never reached a terminal state on the wire, but the agent said
    // why it stopped — that is the failure, not an transport accident.
    const reason = truncate(input.rpcError);
    if (isPlatformFault(input.rpcError)) return { outcome: 'upstream_error', reason };
    return { outcome: 'failed', reason };
  }

  if (input.aborted) {
    return { outcome: 'client_abort', reason: 'the browser disconnected before the turn finished' };
  }
  if (input.readError) {
    return { outcome: 'upstream_error', reason: truncate(`stream error: ${input.readError}`) };
  }
  if (!input.framesSeen) {
    // The dead-end the UI used to render as "(no output)": the upstream closed
    // without ever naming a state.
    return { outcome: 'no_events', reason: 'the agent stream ended without producing any events' };
  }
  return { outcome: 'upstream_error', reason: 'the stream ended before the task reached a terminal state' };
}

// Whether a settled turn becomes a billable fleet.actor_compute event. Two
// rules, both traceable to "depends on the failure type": a turn the PLATFORM
// broke is never billed (upstream_error, no_events), while a turn the user
// abandoned is, because the agent really did run — and the amount billed is
// meter_seconds, the measured stream windows, so a pause on input-required bills
// the compute before it and never the human's think-time. A still-running row is
// not settled at all. Legacy rows carry outcome NULL and stay billable, falling
// back to duration_seconds, so billing history keeps reconciling.
export function settlementPolicy(status: string, outcome: Outcome | string | null | undefined): 'meter' | 'skip' {
  if (status !== 'closed' && status !== 'awaiting_input') return 'skip';
  if (outcome === 'upstream_error' || outcome === 'no_events') return 'skip';
  return 'meter';
}

const A2A_STATUS_BY_HTTP: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'FAILED_PRECONDITION',
  415: 'INVALID_ARGUMENT',
  422: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  501: 'UNIMPLEMENTED',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
  504: 'UNAVAILABLE',
};

export function a2aStatusName(httpStatus: number): string {
  return A2A_STATUS_BY_HTTP[httpStatus] ?? (httpStatus >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT');
}

export interface ErrorInfo {
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

// The A2A client builds an A2AError{code,status,message,details} from exactly
// this shape; anything else (e.g. our old {error:"string"}) loses the reason and
// the UI is left with "A2A request failed: 409".
export function toA2AErrorBody(httpStatus: number, message: string, info?: ErrorInfo): { error: Record<string, unknown> } {
  const error: Record<string, unknown> = {
    code: httpStatus,
    status: a2aStatusName(httpStatus),
    message,
  };
  if (info?.reason) {
    error.details = [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: info.reason,
        domain: info.domain ?? 'fleet.dev',
        ...(info.metadata ? { metadata: info.metadata } : {}),
      },
    ];
  }
  return { error };
}

export class A2ARequestError extends Error {
  statusCode: number;
  info?: ErrorInfo;

  constructor(statusCode: number, message: string, info?: ErrorInfo) {
    super(message);
    this.name = 'A2ARequestError';
    this.statusCode = statusCode;
    this.info = info;
  }
}

export interface TaskRef {
  id?: string;
  contextId?: string;
}

// A task id is not tenant-scoped on its own: kagent will serve GetTask for any id
// its own auth allows. Never let a client pick the project half of the check.
export function assertTaskOwnership(task: TaskRef | undefined, allowedContextIds: Iterable<string>): string | undefined {
  if (!task) return 'task not found';
  const contextId = typeof task.contextId === 'string' ? task.contextId : '';
  if (!contextId) return 'task carries no context id';
  for (const allowed of allowedContextIds) {
    if (allowed === contextId) return undefined;
  }
  return 'task does not belong to this project';
}
