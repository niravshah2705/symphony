// Offboarding: the onboarding DAG run backwards. One executor per create step, so
// nothing the machine provisioned is left running, orphaned, or unaccounted for on
// a statement.
//
// Every step is written gone-is-fine, because a resumed teardown re-enters at the
// first step that did not report done and a step that died mid-way may well have
// finished its work. The inverse-order rules live with the step list in
// @fleet-local/shared; the two that bite are key-before-namespace (the raw virtual
// key exists only in that Secret) and flexprice-last-but-one (cancelling invoices
// the open usage period, which must happen after the compute has stopped).

import { customerId } from '@fleet-local/shared';
import type { OffboardingStepId } from '@fleet-local/shared';
import { config } from '../config.ts';
import { deleteAll, deleteResource, getJson, helmGetValues, helmUninstall, helmUpgradeInstall, waitForGone } from '../clients/k8s.ts';
import { flexprice } from '../clients/flexprice.ts';
import { HttpError } from '../clients/http.ts';
import { litellm } from '../clients/litellm.ts';
import { detachAgents, listProjects } from '../db/projects.ts';
import { loadStates } from '../db/onboarding.ts';
import { setOrgStatus } from '../db/orgs.ts';
import { countRunningSessions } from '../db/sessions.ts';
import { removeMembers } from '../db/users.ts';
import {
  helmRelease,
  keyAlias,
  litellmSecretKey,
  litellmSecretName,
  orgNamespace,
  workerPoolName,
} from '../onboarding/names.ts';
import type { StepExecutor } from '../onboarding/machine.ts';

export type OffboardExecutor = StepExecutor<OffboardingStepId>;

// A remote object we are being asked to delete is already deleted, or the delete
// reached it through another door (team/delete takes its keys with it). Anything
// else is a real failure and must be retried, so the list stays narrow.
//
// Checked FIRST, because the API-never-reached failures overlap the gone patterns:
// kubectl says `context "kind-cluster" does not exist` and `error: You must be
// logged in`, and a wrong-cluster or dead-credential call that read as "already
// gone" would let the whole teardown report success while deleting nothing — then
// mark a live organisation deleted.
const UNREACHABLE =
  /context "[^"]*" does not exist|current-context|spawn \S+ ENOENT|connection refused|connection reset|i\/o timeout|timed out|no such host|unauthorized|forbidden|cannot load kubeconfig|exit status 127/i;

export function isAlreadyGone(err: unknown): boolean {
  const body = err instanceof HttpError ? err.body : '';
  const message = `${err instanceof Error ? err.message : String(err)} ${body}`;
  if (UNREACHABLE.test(message)) return false;
  if (err instanceof HttpError && err.status === 404) return true;
  // Flexprice spells an already-cancelled subscription with an underscore
  // (`subscription_invalid_status`), and a step that failed there would otherwise
  // park the org in offboarding forever.
  return /not found|does not exist|no such key|already (cancelled|deleted)|invalid[ _](state|status)|no subscription/i.test(
    message,
  );
}

const GONE_IS_FINE = <T>(fn: () => Promise<T>): Promise<T | undefined> =>
  fn().catch((err) => {
    if (isAlreadyGone(err)) return undefined;
    throw err;
  });

export interface NamespacePolicy {
  allowedNamespaces: string[];
  atespace: string;
}

// Drop only this tenant's atespace entry. Everything else in the list — including
// the baseline {atespace:'kagent'} the shared release ships with — is other
// people's access and must survive untouched.
export function withoutNamespacePolicy(policies: readonly NamespacePolicy[], ns: string): NamespacePolicy[] {
  return policies.filter((p) => p.atespace !== ns);
}

const SETTLE_WAIT_MS = 60_000;
const SETTLE_POLL_MS = 3_000;

async function waitForIdleSessions(orgId: string): Promise<boolean> {
  const deadline = Date.now() + SETTLE_WAIT_MS;
  while (Date.now() < deadline) {
    if ((await countRunningSessions(orgId)) === 0) return true;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
  return (await countRunningSessions(orgId)) === 0;
}

// Inverse of workflow: the kagent-tenant release, which owns every Agent,
// AgentTemplate, ModelConfig and Harness the catalog rendered.
export const releaseStep: OffboardExecutor = async (ctx) => {
  const ns = orgNamespace(ctx.orgSlug);
  // Deleting underneath a live stream would kill the actor mid-pump, and a turn the
  // platform broke is not settled — real compute written off. The gate already
  // refuses new turns, so this is bounded by however long the longest honest turn runs.
  const idle = await waitForIdleSessions(ctx.orgId);
  const removed = await helmUninstall(helmRelease(ctx.orgSlug), ns);
  return { release: helmRelease(ctx.orgSlug), namespace: ns, removed, idle };
};

// Inverse of attach. The project rows are history; their agent pointers are not.
export const detachStep: OffboardExecutor = async (ctx) => ({ projects: await detachAgents(ctx.orgId) });

// Inverse of key. The Secret holds the only copy of the raw token, so it is read
// here — before the namespace step deletes it — and the alias is the fallback when
// the Secret is already gone.
export const keyStep: OffboardExecutor = async (ctx) => {
  const ns = orgNamespace(ctx.orgSlug);
  const projects = await listProjects(ctx.orgId);
  const deleted: string[] = [];
  const unresolved: string[] = [];

  for (const project of projects) {
    const secret = await getJson<{ data?: Record<string, string> }>('secret', litellmSecretName(ctx.orgSlug, project.slug), ns);
    const encoded = secret?.data?.[litellmSecretKey];
    let keys = encoded ? [Buffer.from(encoded, 'base64').toString('utf8')] : [];
    if (keys.length === 0) {
      keys = await GONE_IS_FINE(() => litellm.listKeysByAlias(keyAlias(ctx.orgId, project.id))) ?? [];
    }
    if (keys.length === 0) {
      unresolved.push(project.id);
      continue;
    }
    await GONE_IS_FINE(() => litellm.deleteKey(keys));
    deleted.push(project.id);
  }

  // unresolved is reported, not fatal: the team step below is the backstop, and
  // wedging the teardown over one unreadable key would leave the namespace running.
  return { deleted, unresolved };
};

// Inverse of the WorkerPool half of namespace. Going first matters: a namespace
// delete does not necessarily reach the atelet-managed gVisor sandboxes, and a
// worker pool that survives is compute that keeps billing an org nobody can see.
export const workspaceStep: OffboardExecutor = async (ctx) => {
  const ns = orgNamespace(ctx.orgSlug);
  const pool = workerPoolName(ctx.orgSlug);
  await deleteResource('workerpool.ate.dev', pool, ns);
  await deleteResource('serviceaccount', `${pool}-pool`, ns);
  // Any agent the release no longer owns (a catalog entry that came and went).
  await deleteAll('agents.api.kagent.dev', ns, `fleet.local/org-id=${ctx.orgId}`);
  const gone = await waitForGone('workerpool.ate.dev', pool, ns, 180);
  return { workerPool: pool, gone };
};

// Inverse of project: the LiteLLM team, keyed by the canonical project UUID.
export const teamStep: OffboardExecutor = async (ctx) => {
  const teamIds = (await listProjects(ctx.orgId)).map((p) => p.id);
  if (teamIds.length > 0) await GONE_IS_FINE(() => litellm.deleteTeam(teamIds));
  return { teamIds };
};

// Inverse of namespace: the namespace itself, which cascades the Secret, any
// leftover CR, and every pod in the tenant.
export const namespaceStep: OffboardExecutor = async (ctx) => {
  const ns = orgNamespace(ctx.orgSlug);
  await deleteResource('namespace', ns);
  return { namespace: ns, gone: await waitForGone('namespace', ns, undefined, 300) };
};

// Inverse of the substrate credentialProvider policy the namespace step appended to
// the SHARED release. Best-effort by design: a stale entry authorises a namespace
// that no longer exists, so leaving it costs nothing, while a failed write to this
// release would. Every tenant's credential path runs through it.
export const substrateStep: OffboardExecutor = async (ctx) => {
  const ns = orgNamespace(ctx.orgSlug);
  try {
    const values = await helmGetValues('substrate', config.substrateNamespace);
    const cp = (values.credentialProvider ?? {}) as { namespacePolicies?: NamespacePolicy[] };
    const policies = cp.namespacePolicies ?? [];
    const kept = withoutNamespacePolicy(policies, ns);
    // Nothing of ours to remove: say so and leave the release alone. This is the
    // common path on a retry, and it is what makes re-running the step free.
    if (kept.length === policies.length) return { removed: false, reason: 'no policy for this namespace' };
    await helmUpgradeInstall({
      release: 'substrate',
      chart: config.substrateChart,
      namespace: config.substrateNamespace,
      version: config.substrateVersion,
      reuseValues: true,
      values: { credentialProvider: { ...cp, namespacePolicies: kept } },
    });
    return { removed: true };
  } catch (err) {
    return { removed: false, skipped: 'error', error: err instanceof Error ? err.message : String(err) };
  }
};

// Inverse of flexprice: cancel the subscription so the open usage period is billed,
// and stop the plan renewing. The customer and its INR wallet stay — they are the
// statement a deleted org's owner may still have to be answered from, and the
// sweeper can still emit for turns that settled before the teardown.
export const flexpriceStep: OffboardExecutor = async (ctx) => {
  const states = await loadStates(ctx.orgId);
  let subscriptionId = states.flexprice?.result?.subscriptionId as string | undefined;
  if (!subscriptionId) {
    const customer = await GONE_IS_FINE(() => flexprice.findCustomer(customerId(ctx.orgId)));
    if (!customer) return { cancelled: false, reason: 'no customer' };
    subscriptionId = (await GONE_IS_FINE(() => flexprice.findSubscription(customer.id)))?.id;
  }
  if (!subscriptionId) return { cancelled: false, reason: 'no subscription' };
  await GONE_IS_FINE(() => flexprice.cancelSubscription(subscriptionId as string));
  return { cancelled: true, subscriptionId };
};

// Last, and the only step that changes what the org's users can see: membership
// goes, then the row becomes terminal. Configuration and history stay.
export const accessStep: OffboardExecutor = async (ctx) => {
  const members = await removeMembers(ctx.orgId);
  const org = await setOrgStatus(ctx.orgId, ['offboarding'], 'deleted');
  if (!org) {
    throw new Error('organisation is no longer offboarding — refusing to mark a live org deleted');
  }
  return { membersRemoved: members };
};

export const offboardExecutors: Record<OffboardingStepId, OffboardExecutor> = {
  release: releaseStep,
  detach: detachStep,
  key: keyStep,
  workspace: workspaceStep,
  team: teamStep,
  namespace: namespaceStep,
  substrate: substrateStep,
  flexprice: flexpriceStep,
  access: accessStep,
};
