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
