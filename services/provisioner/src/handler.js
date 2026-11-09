'use strict';

const { getOrgFundStatus } = require('@ai-fleet/shared-core/billing/gate');
const { ensureAtespace, resolveSubstrateUrl } = require('@ai-fleet/shared-core/agent/substrate');

/**
 * Transport-agnostic provision/teardown dispatch. The Pub/Sub push surface
 * decodes the message and calls this; tests call it directly with injected deps.
 *
 * Deps (all injectable):
 *   provisionTenant(slug, cfg) -> deployments map
 *   teardownTenant(slug, cfg)  -> {}
 *   writeBack(orgId, deployments) -> persists to the org service
 *   checkFundStatus(orgId)        -> { fundsAvailable, fundStatus, reason, ... }
 *   ensureAtespace(input)         -> { atespace, created, existed }  (ateapi)
 *   writeStepStatus(orgId, runId, stepKey, { status, detail }) -> settles an
 *       environment-initialization step the org service handed us
 *   cfg  provisioning config (project/region/urls/SAs/…)
 *   log  optional logger
 *
 * Failure is captured as deployments.status = 'failed' (best-effort write-back)
 * so the SPA/operator can see it rather than the tenant silently hanging.
 */
function nowIso() {
  return new Date().toISOString();
}

// The org service owns the environment-run status machine; the provisioner can
// only ever answer a step it was asked to perform, and these are the three
// answers it is allowed to give.
const STEP = { COMPLETED: 'COMPLETED', FAILED: 'FAILED', SKIPPED: 'SKIPPED' };

/**
 * Settle the tenant's Substrate atespace on request of the init job.
 *
 * The namespace NAME arrives in the message — the org service derived it from
 * the deployment slug and persisted the binding before publishing. Re-deriving
 * it here would put the same decision in two services, which is how a tenant
 * ends up with actors in a namespace nothing else looks at. So a name the
 * deployment would not resolve to on its own is refused rather than honored:
 * the atespace is the isolation boundary, and the initiator is not automatically
 * right about what is allowed.
 *
 * Nothing here is Cloud Run-specific, so this action runs even when
 * PROVISIONING_ENABLED is off (a shared-stack deployment still has actors).
 */
async function handleAtespaceStep(message, deps, orgId) {
  const { writeStepStatus, log, cfg } = deps;
  const { run_id: runId, step_key: stepKey, atespace } = message;
  if (!runId || !stepKey || !atespace) {
    log && log.error && log.error('provisioner: substrate-atespace message missing run_id/step_key/atespace');
    return { ok: false, reason: 'malformed' };
  }

  const report = (status, detail) => writeStepStatus(orgId, runId, stepKey, { status, detail });

  if (!resolveSubstrateUrl(cfg && cfg.substrateUrl)) {
    // Not a failure: a deployment that never configured a control plane has no
    // in-cluster space to create. Saying SKIPPED with the reason is what stops
    // the run from looking stuck.
    await report(STEP.SKIPPED, { reason: 'no substrate control plane configured' });
    return { ok: true, action: 'substrate-atespace', skipped: true };
  }

  try {
    const result = await (deps.ensureAtespace || ensureAtespace)({ atespace, organizationId: orgId });
    if (result.atespace !== atespace) {
      throw new Error(
        `deployment resolves ${orgId} to atespace "${result.atespace}", not the requested "${atespace}"`,
      );
    }
    await report(STEP.COMPLETED, {
      atespace: result.atespace,
      created: result.created === true,
      existed: result.existed === true,
    });
    return { ok: true, action: 'substrate-atespace', atespace: result.atespace };
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    log && log.error && log.error(`provisioner substrate-atespace ${atespace} failed: ${detail}`);
    try {
      await report(STEP.FAILED, { error: detail });
    } catch (_) {
      /* best-effort — the step stays RUNNING and the next login retries it */
    }
    return { ok: false, action: 'substrate-atespace', reason: detail };
  }
}

async function handleMessage(message, deps) {
  const { provisionTenant, teardownTenant, writeBack, checkFundStatus = getOrgFundStatus, cfg, log } = deps;
  const orgId = message && message.org_id;
  const slug = message && message.slug;
  const action = (message && message.action) || 'provision';

  if (!orgId || !slug) {
    // Malformed / poison — caller should ack so Pub/Sub stops redelivering.
    log && log.error && log.error(`provisioner: malformed message ${JSON.stringify(message)}`);
    return { ok: false, reason: 'malformed' };
  }

  if (action === 'substrate-atespace') return handleAtespaceStep(message, deps, orgId);

  try {
    if (action === 'teardown') {
      await teardownTenant(slug, cfg);
      await writeBack(orgId, { status: 'shared', slug, error: null, updated_at: nowIso() });
      return { ok: true, action };
    }

    // Organization-level fund gating: refuse sandbox/tenant provisioning if funds are unavailable
    const fundInfo = await Promise.resolve(checkFundStatus(orgId));
    if (fundInfo && fundInfo.fundsAvailable === false) {
      const reason = fundInfo.reason || 'Organization funds unavailable — sandbox creation is disabled.';
      log && log.warn && log.warn(`provisioner ${action} ${slug} blocked: ${reason}`);
      try {
        await writeBack(orgId, {
          status: 'disabled',
          sandbox_creation_disabled: true,
          slug,
          error: reason,
          updated_at: nowIso(),
        });
      } catch (_) {
        /* best-effort */
      }
      return { ok: false, action, reason: 'sandbox_creation_disabled', error: reason };
    }

    // Thread the org id so per-tenant resources are labeled organization=<id>.
    const deployments = await provisionTenant(slug, { ...cfg, orgId });
    await writeBack(orgId, deployments);
    return { ok: true, action };
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    log && log.error && log.error(`provisioner ${action} ${slug} failed: ${detail}`);
    // Record the failure so it is visible; swallow write-back errors.
    try {
      await writeBack(orgId, { status: 'failed', slug, error: detail, updated_at: nowIso() });
    } catch (_) {
      /* best-effort */
    }
    return { ok: false, reason: detail };
  }
}

module.exports = { handleMessage };
