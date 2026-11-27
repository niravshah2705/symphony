// The AG-UI wire vocabulary shared by the BFF run endpoint and the SPA. The rule
// is the one a2a.ts states: a key that drifts on one side stops matching instead
// of failing loudly, so both sides spell it here once.

import { MODEL_METADATA_KEY } from './a2a.ts';

// The same project scope the A2A facade uses, so identity comes from the path and
// never from a handle the client chose.
export function aguiRunPath(origin: string, orgId: string, projectId: string): string {
  return `${origin.replace(/\/+$/, '')}/api/agui/orgs/${orgId}/projects/${projectId}/agent`;
}

// Which model runs the turn is one choice with one name. RunAgentInput has no
// message metadata field, so the AG-UI leg carries it in forwardedProps under the
// key the A2A leg already used rather than inventing a second spelling.
export const AGUI_MODEL_PROP = MODEL_METADATA_KEY;

// Why a paused run stopped waiting: the A2A paused states, written by the encoder
// and matched on by the UI. auth-required asks the human to re-authenticate;
// input-required asks for an answer, which may be a tool approval.
export const INTERRUPT_INPUT_REQUIRED = 'input-required';
export const INTERRUPT_AUTH_REQUIRED = 'auth-required';

// The CUSTOM event name that carries an agent-produced file to the browser. A2A
// has a FilePart; AG-UI has no file event, so the encoder re-speaks it as a
// custom part the SPA renders by name. The BFF writes it, the SPA matches on it.
export const FILE_CUSTOM_EVENT = 'fleet.dev/file';

// The CUSTOM event carrying the pages a web tool fetched during this run. Same
// channel as the file artifact above, because AG-UI has no citation event either;
// `value` is `{ sources: [{url, title?}] }`.
export const SOURCES_CUSTOM_EVENT = 'fleet.dev/sources';

// The CUSTOM event carrying kagent's structured terminal result as generative UI.
// RUN_FINISHED's `result` member is dropped by the browser's AG-UI client (its
// parser keeps only runId and outcome), so the run's structured payload can only
// reach the transcript as an event of its own. `value` is `{kind, props}`.
export const UI_CUSTOM_EVENT = 'fleet.dev/ui';

export interface UiSpec {
  kind: string;
  props: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A model output has no idea it is going to be rendered, so the shape decides
// unless the operator's schema already said: `{kind, props}` (or `{ui, props}`)
// wins, and everything else is read structurally. `json` is the honest fallback —
// the SPA renders unknown kinds as the payload, never as a guess at a widget.
export function uiSpecFor(value: unknown): UiSpec {
  if (isRecord(value)) {
    const declared = typeof value.kind === 'string' ? value.kind : typeof value.ui === 'string' ? value.ui : undefined;
    if (declared) {
      const { kind: _kind, ui: _ui, ...rest } = value;
      const props = isRecord(value.props) ? (value.props as Record<string, unknown>) : rest;
      return { kind: declared, props };
    }
    if (Array.isArray(value.columns) && Array.isArray(value.rows)) {
      return { kind: 'table', props: { columns: value.columns, rows: value.rows } };
    }
    if (Array.isArray(value.labels) && Array.isArray(value.values) && value.labels.length === value.values.length) {
      return { kind: 'chart', props: { labels: value.labels, values: value.values } };
    }
    if (typeof value.before === 'string' && typeof value.after === 'string') {
      return { kind: 'diff', props: { before: value.before, after: value.after } };
    }
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
    const keys: string[] = [];
    for (const row of value) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
    if (keys.length > 0) {
      return { kind: 'table', props: { columns: keys.map((key) => ({ key, title: key })), rows: value } };
    }
  }
  return { kind: 'json', props: { value } };
}
