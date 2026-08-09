'use strict';

/**
 * Transport-agnostic provision/teardown dispatch. The Pub/Sub push surface
 * decodes the message and calls this; tests call it directly with injected deps.
 *
 * Deps (all injectable):
 *   provisionTenant(slug, cfg) -> deployments map
 *   teardownTenant(slug, cfg)  -> {}
 *   writeBack(orgId, deployments) -> persists to the org service
 *   cfg  provisioning config (project/region/urls/SAs/…)
 *   log  optional logger
 *
 * Failure is captured as deployments.status = 'failed' (best-effort write-back)
 * so the SPA/operator can see it rather than the tenant silently hanging.
 */
function nowIso() {
  return new Date().toISOString();
}

async function handleMessage(message, deps) {
  const { provisionTenant, teardownTenant, writeBack, cfg, log } = deps;
  const orgId = message && message.org_id;
  const slug = message && message.slug;
  const action = (message && message.action) || 'provision';

  if (!orgId || !slug) {
    // Malformed / poison — caller should ack so Pub/Sub stops redelivering.
    log && log.error && log.error(`provisioner: malformed message ${JSON.stringify(message)}`);
    return { ok: false, reason: 'malformed' };
  }

  try {
    if (action === 'teardown') {
      await teardownTenant(slug, cfg);
      await writeBack(orgId, { status: 'shared', slug, error: null, updated_at: nowIso() });
      return { ok: true, action };
    }
    const deployments = await provisionTenant(slug, cfg);
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
