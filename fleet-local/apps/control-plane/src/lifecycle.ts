// Organisation lifecycle: who may still call an agent, and which status changes are
// legal at all.
//
// The two rules worth defending:
//
// 1. DISABLE IS A GATE, NOT A TEARDOWN. It writes one column and touches no
//    infrastructure, which is exactly why disabled -> active needs no re-onboarding.
//    A PATCH handler here must never import a clients/* module.
// 2. TEARDOWN IS ONE-WAY. offboarding -> active would hand the owner a row whose
//    agents, virtual key and LiteLLM team no longer exist; the only way out of
//    offboarding is to finish it.

import type { FacadeCall } from './a2a/translate.ts';
import { A2ARequestError } from './a2a/contract.ts';
import { orgStatus, type OrgStatus } from './db/orgs.ts';
import { assertOwner } from './db/users.ts';

export type { OrgStatus };
export { assertOwner };

const TRANSITIONS: Record<OrgStatus, readonly OrgStatus[]> = {
  active: ['disabled', 'offboarding'],
  disabled: ['active', 'offboarding'],
  offboarding: ['deleted'],
  deleted: [],
};

export function canTransition(from: OrgStatus, to: OrgStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// A new turn is new spend, so it is what a suspended org must not be able to start.
// Everything else stays open on purpose: reading a task, subscribing to the stream
// of a turn that began before the suspension, cancelling that turn (the user's only
// lever on the meter), and the settlement calls that make it billable. Refusing
// those would not save money, it would only hide the money already spent.
const REFUSED_WHILE_SUSPENDED: readonly FacadeCall['kind'][] = ['stream', 'send'];

export function gateDecision(status: OrgStatus, call: FacadeCall['kind']): 'allow' | 'refuse' {
  if (status === 'active') return 'allow';
  return REFUSED_WHILE_SUSPENDED.includes(call) ? 'refuse' : 'allow';
}

function refuse(status: OrgStatus | undefined): never {
  if (status === undefined) {
    throw new A2ARequestError(404, 'organisation not found', { reason: 'org_not_found' });
  }
  throw new A2ARequestError(409, `organisation is ${status} — agent calls are turned off`, { reason: 'org_disabled' });
}

// The gate for a call that always starts compute (the AG-UI run endpoint).
export async function assertOrgActive(orgId: string): Promise<void> {
  const status = await orgStatus(orgId);
  if (status !== 'active') refuse(status);
}

// The gate for the A2A facade, where the call kind decides.
export async function assertFacadeCallAllowed(orgId: string, call: FacadeCall['kind']): Promise<void> {
  const status = await orgStatus(orgId);
  if (status === undefined) refuse(undefined);
  if (gateDecision(status, call) === 'refuse') refuse(status);
}
