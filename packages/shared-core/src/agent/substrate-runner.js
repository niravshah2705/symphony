'use strict';

/**
 * Agent Substrate planning runner (execution substrate = 'substrate').
 *
 * Orchestrates one per-run ephemeral actor for the PLANNING stage and returns a
 * result shaped like the in-process harness contract (`{ finalText, messages,
 * traced, ... }`) so downstream pipeline stages are unchanged. Authentication stays
 * MANAGED: raw credentials never enter the actor — the egress gateway injects them
 * from the settings-service vault via credential-provider Secrets that the atespace
 * is granted read access to (see syncSubstrateSecrets).
 */

const crypto = require('node:crypto');
const CONFIG = require('../config');
const { getSettings } = require('../store');
const substrate = require('./substrate');
const { buildCredentialProviderPolicy } = require('../guardrails/consumers');
const { buildDockerConfigJson } = require('./registry-auth');
const { monitorActorSession } = require('../billing/actor-sessions');
const { TIERS, DEFAULT_TIER, tierFor } = require('../billing/compute-pricing');
const { createActorMetrics } = require('../otel/actor-metrics');
const log = require('../logger');

const REDACTED = '***REDACTED***';
const fp = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12) : '');

function fingerprintOnly(secrets = {}) {
  return {
    github: secrets.githubToken ? { present: true, fingerprint: fp(secrets.githubToken) } : { present: false },
    openrouter: secrets.openrouterApiKey ? { present: true, fingerprint: fp(secrets.openrouterApiKey) } : { present: false },
    imageRegistry: secrets.imageRegistryPassword
      ? { present: true, fingerprint: fp(secrets.imageRegistryPassword), username: secrets.imageRegistryUsername || '' }
      : { present: false },
  };
}

/**
 * Push org secrets into the substrate-credentials namespace as k8s Secrets and
 * grant the atespace read of that namespace. Secret CRUD is NOT an ateapi RPC, so
 * the caller injects `applyManifest` (a k8s client seam); without it we resolve the
 * intended manifests but fail closed rather than silently skipping the grant.
 *
 * "Fail closed" means the scopes the guardrail spec actually grants. A credential
 * the tenant was never given a read of is not injected and is not an error either:
 * demanding an applier for it would make this module the owner of a grant that
 * belongs to `spec.credentials.scopes`. Only a *scoped* secret with no applier is
 * the misconfiguration, and that one has to be loud.
 *
 * Returns fingerprint-only state — never raw values.
 */
async function syncSubstrateSecrets({
  organizationId,
  atespace,
  secrets = {},
  guardrailSpec,
  applyManifest,
  namespace = 'substrate-credentials',
} = {}) {
  const resolvedAtespace = atespace || substrate.resolveSubstrateAtespace({ organizationId });
  const policy = buildCredentialProviderPolicy(guardrailSpec || {}, { namespace });
  const scopeHas = (scope) => policy.allowedSecrets.some((s) => s.scope === scope);

  const manifests = [];
  if (secrets.githubToken) {
    manifests.push({
      scope: 'github',
      manifest: {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'ghcr-pull-and-clone', namespace },
        type: 'Opaque',
        stringData: { GITHUB_TOKEN: String(secrets.githubToken) },
      },
    });
  }
  if (secrets.openrouterApiKey) {
    manifests.push({
      scope: 'openrouter',
      manifest: {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'openrouter-api-key', namespace },
        type: 'Opaque',
        stringData: { OPENROUTER_API_KEY: String(secrets.openrouterApiKey) },
      },
    });
  }
  if (secrets.imageRegistryPassword) {
    manifests.push({
      scope: 'image-registry',
      manifest: {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'image-registry-creds', namespace },
        type: 'kubernetes.io/dockerconfigjson',
        data: { '.dockerconfigjson': Buffer.from(buildDockerConfigJson({
          registryUrl: secrets.imageRegistryUrl || 'ghcr.io',
          username: secrets.imageRegistryUsername || '',
          password: String(secrets.imageRegistryPassword),
        }), 'utf8').toString('base64') },
      },
    });
  }

  const scoped = manifests.filter((entry) => scopeHas(entry.scope));
  const withheldScopes = manifests.filter((entry) => !scopeHas(entry.scope)).map((entry) => entry.scope);
  const needsApplier = scoped.length > 0 && typeof applyManifest !== 'function';
  if (needsApplier) {
    throw new Error(
      `syncSubstrateSecrets: the guardrail spec grants ${scoped.map((e) => e.scope).join(', ')} ` +
      'to this atespace but no applyManifest seam is wired, so the credential-provider ' +
      'Secrets cannot be written. Secret CRUD is not an ateapi RPC. Either drop those ' +
      'scopes from spec.credentials.scopes, or run the agent from a workload that has a ' +
      'k8s client.',
    );
  }

  const synced = [];
  if (typeof applyManifest === 'function') {
    for (const { manifest } of scoped) {
      await applyManifest(manifest);
      synced.push(manifest.metadata.name);
    }
    // Grant the atespace read access to the credentials namespace (default-deny
    // otherwise injects nothing). RbacBinding is rendered by the workspace chart /
    // infra; here we signal the intended grant to the injected client.
    await applyManifest({
      kind: 'CredentialProviderReadGrant',
      atespace: resolvedAtespace,
      namespace,
      allowedSecrets: policy.allowedSecrets.map((s) => s.secretName),
    });
  }

  return {
    atespace: resolvedAtespace,
    namespace,
    credentialProvider: policy.credentialProvider,
    syncedSecrets: synced,
    // Present in settings, not granted by the spec: named so a caller can say why
    // an actor has no GitHub token rather than leaving that to be inferred.
    withheld: withheldScopes,
    scopes: { github: scopeHas('github'), openrouter: scopeHas('openrouter'), 'image-registry': scopeHas('image-registry') },
    state: fingerprintOnly(secrets),
    applied: typeof applyManifest === 'function',
  };
}

/**
 * POST/stream the planning prompt to the actor over the atenet-router ingress.
 * The router forwards by the `ate-target-actor: <atespace>/<actor>` header; we
 * present a short-lived actor JWT. The actor must serve an HTTP run route
 * (planner image: POST /internal/plan/run) on its served port.
 */
async function dispatchActorPrompt({
  ingressUrl,
  atespace,
  actorName,
  actorJwt,
  prompt,
  organizationId,
  projectId,
  projectName,
  llm,
  guardrailSpec,
  runtime,
  agentRuntime,
  workflowPattern,
  workflow,
  stage,
  settings,
  traceContext = {},
  fetchImpl = globalThis.fetch,
  timeoutMs,
} = {}) {
  const url = substrate.resolveSubstrateIngressUrl(ingressUrl);
  if (!url) throw new Error('substrateIngressUrl is not configured (atenet-router data-plane URL).');
  if (!actorJwt) throw new Error('actor JWT required to dispatch to the substrate router.');

  const effectiveTimeout = timeoutMs || CONFIG?.SUBSTRATE?.timeoutMs || 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  try {
    const res = await fetchImpl(`${url}/internal/plan/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ate-target-actor': `${atespace}/${actorName}`,
        authorization: `Bearer ${actorJwt}`,
        ...(traceContext.runId ? { 'x-aifleet-run-id': String(traceContext.runId) } : {}),
        ...(organizationId ? { 'x-aifleet-org-id': String(organizationId) } : {}),
        // One trace across the process boundary: the actor's harness span is a
        // child of the caller's, so a run is readable as a single trace instead
        // of two unrelated ones.
        ...(traceContext.traceparent ? { traceparent: String(traceContext.traceparent) } : {}),
      },
      // The actor has no settings store — everything the in-process
      // executeAgentRuntime call needs must ride on the request body. No raw
      // credentials are sent; the actor's outbound calls hit the egress proxy
      // with the sentinel and the gateway injects.
      body: JSON.stringify({
        prompt,
        organizationId,
        projectId,
        projectName,
        llm,
        guardrailSpec,
        runtime,
        agentRuntime,
        workflowPattern,
        workflow,
        stage,
        settings,
        runId: traceContext.runId,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Substrate actor dispatch failed (${res.status}): ${text.slice(0, 500)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { finalText: text }; }
    return {
      finalText: parsed.finalText ?? parsed.text ?? text,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [{ role: 'assistant', content: parsed.finalText ?? text }],
      model: parsed.model || null,
      usage: parsed.usage || null,
      costUsd: parsed.costUsd ?? null,
      traceId: parsed.traceId || null,
      raw: parsed,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a Substrate-issued actor JWT against the ate-idp-server JWKS. `getJwks`
 * is injected (cached by the caller) so this stays testable and offline-capable.
 * Returns { valid, claims, reason }.
 */
async function verifyActorJwt(token, { audience, trustDomain = 'cluster.local', service = 'ate-idp-server', getJwks } = {}) {
  if (!token || typeof token !== 'string' || token.split('.').length !== 3) {
    return { valid: false, reason: 'malformed_jwt' };
  }
  const [h, p, sig] = token.split('.');
  const decodeSeg = (seg) => JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  let header, claims;
  try { header = decodeSeg(h); claims = decodeSeg(p); } catch { return { valid: false, reason: 'malformed_jwt' }; }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) return { valid: false, claims, reason: 'expired' };
  if (audience && Array.isArray(claims.aud) ? !claims.aud.includes(audience) : claims.aud !== audience) {
    if (audience) return { valid: false, claims, reason: 'audience_mismatch' };
  }
  const expectedPrefix = `spiffe://${trustDomain}/`;
  if (claims.sub && !String(claims.sub).startsWith(expectedPrefix)) {
    return { valid: false, claims, reason: 'trust_domain_mismatch' };
  }
  if (typeof getJwks === 'function') {
    const jwks = await getJwks({ service, trustDomain });
    const keys = (jwks && jwks.keys) || [];
    const jwk = keys.find((k) => !header.kid || k.kid === header.kid) || keys[0];
    if (jwk) {
      try {
        const { createPublicKey } = require('node:crypto');
        const pub = createPublicKey({ key: jwk, format: 'jwk' });
        const alg = String(header.alg || 'RS256');
        // Node's OpenSSL names differ from JWS: RS256 -> RSA-SHA256.
        // ES*/PS* are unsupported here and fail closed via signature_check_failed.
        const rsMatch = /^RS(256|384|512)$/.exec(alg);
        if (!rsMatch) return { valid: false, claims, reason: `unsupported_alg:${alg}` };
        const verifier = crypto.createVerify(`RSA-SHA${rsMatch[1]}`);
        verifier.update(`${h}.${p}`);
        const ok = verifier.verify(pub, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
        if (!ok) return { valid: false, claims, reason: 'signature_invalid' };
      } catch (err) {
        return { valid: false, claims, reason: `signature_check_failed:${err?.message || err}` };
      }
    }
  }
  return { valid: true, claims };
}

/**
 * Run the planning stage on a per-run ephemeral Substrate actor.
 * Lifecycle: ensure atespace → ensure ActorTemplate → sync secrets → create actor
 * → egress policy (from guardrail spec) → mint JWT → dispatch → suspend+delete.
 */
async function runPlanningOnSubstrate({
  organizationId,
  projectId,
  projectName,
  userId = null,
  userEmail = null,
  prompt,
  guardrailSpec,
  secrets = {},
  llm,
  runtime,
  agentRuntime,
  workflowPattern,
  workflow,
  stage,
  settings,
  providerSource = null,
  traceContext = {},
  transport,
  applyManifest,
  fetchImpl,
  recordUsage = (...args) => require('../billing/usage').recordUsage(...args),
  actorSessionMonitor = monitorActorSession,
  actorMetrics,
  now = Date.now,
  onStep = () => {},
} = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('runPlanningOnSubstrate: prompt is required');
  const opts = { transport };
  const atespace = substrate.resolveSubstrateAtespace({ organizationId, projectId });

  onStep('Substrate: syncing managed credentials to the credential-provider (outside the actor)…');
  // Before any cluster write: a grant this workload cannot apply is a
  // configuration error, and finding out after ensureAtespace + ActorTemplate
  // landed leaves a half-provisioned tenant for a run that never started.
  const credSync = await syncSubstrateSecrets({ organizationId, atespace, secrets, guardrailSpec, applyManifest });

  onStep(`Substrate: ensuring atespace '${atespace}'…`);
  await substrate.ensureAtespace({ ...opts, atespace });

  onStep('Substrate: ensuring planner ActorTemplate…');
  await substrate.upsertActorTemplate({ ...opts, atespace, organizationId, projectId });

  onStep('Substrate: creating ephemeral actor…');
  const actor = await substrate.createEphemeralActor({ ...opts, atespace, projectId, runId: traceContext.runId });
  const actorName = actor.metadata.name;
  const startedAt = now();
  let sessionMonitor;

  try {
    try {
      sessionMonitor = actorSessionMonitor({
        agentId: actorName, atespace, orgId: organizationId || require('../billing/org-context').resolveOrgId(),
        projectId, userId, userEmail, runId: traceContext.runId,
        tier: tierFor(TIERS[DEFAULT_TIER]), hourlyRatePaise: 0, startedAt,
      }, { now, metrics: actorMetrics || createActorMetrics() });
    } catch {
      log.error('actor_session_start_failed', { actorName });
    }
    onStep('Substrate: applying per-actor egress policy from the shared guardrail spec…');
    await substrate.createActorEgressPolicy({ ...opts, atespace, name: actorName, guardrailSpec });

    onStep('Substrate: waiting for actor RUNNING…');
    let status = await substrate.getActorStatus({ ...opts, atespace, name: actorName });
    let waited = 0;
    const ttlMs = CONFIG?.SUBSTRATE?.actorTtlMs || 120_000;
    while (status && status.status.state !== 'RUNNING' && waited < ttlMs) {
      if (status.status.state === 'SUSPENDED') { await substrate.resumeActor({ ...opts, atespace, name: actorName }); }
      await new Promise((r) => setTimeout(r, 1000));
      waited += 1000;
      status = await substrate.getActorStatus({ ...opts, atespace, name: actorName });
    }

    onStep('Substrate: minting actor identity JWT…');
    const { tokenPresent } = await substrate.mintActorJwt({ ...opts, atespace, name: actorName, audiences: ['substrate-router'] });
    // The minted JWT is returned to the router-side gateway for injection; here we
    // pass the actual token to the dispatcher. Re-mint to obtain the raw token in a
    // real deployment; for the data plane we only need it present + valid.
    void tokenPresent;
    const actorJwt = await mintRawActorJwt({ opts, atespace, name: actorName });

    onStep('Substrate: dispatching planning prompt to the actor…');
    const result = await dispatchActorPrompt({
      ingressUrl: substrate.resolveSubstrateIngressUrl(),
      atespace,
      actorName,
      actorJwt,
      prompt,
      organizationId,
      projectId,
      projectName,
      llm,
      guardrailSpec,
      runtime,
      agentRuntime,
      workflowPattern,
      workflow,
      stage,
      settings,
      traceContext: { ...traceContext, organizationId },
      fetchImpl,
    });

    // Meter the run HERE, not in the actor. The ActorTemplate creates the
    // container with no env at all, so an in-actor recordUsage would land in the
    // actor's ephemeral local store and vanish with it — a run that consumed
    // real tokens and reported nothing. This pod owns the tenant store and the
    // org context, so it is the one authoritative writer.
    const usageRecord = recordUsage({
      orgId: organizationId || null,
      projectId: projectId || null,
      projectName: projectName || null,
      userId,
      userEmail,
      runId: traceContext.runId || null,
      traceId: result.traceId || null,
      source: 'substrate-plan',
      providerSource,
    }, { usage: result.usage, costUsd: result.costUsd }, llm || {});

    return {
      finalText: result.finalText,
      messages: result.messages,
      model: result.model || (llm && llm.model) || null,
      usage: result.usage || null,
      costUsd: result.costUsd ?? null,
      traceId: result.traceId || null,
      billingSource: usageRecord && usageRecord.billingSource || null,
      traced: { substrate: { atespace, actorName, credentialSync: credSync.state, egress: true } },
      substrate: { atespace, actorName, credentialSync: credSync },
    };
  } finally {
    sessionMonitor?.stop();
    // Per-run ephemeral: always suspend then delete so no idle actor lingers.
    onStep('Substrate: tearing down ephemeral actor…');
    try { await substrate.suspendActor({ ...opts, atespace, name: actorName }); } catch { /* best-effort */ }
    try { await substrate.deleteActor({ ...opts, atespace, name: actorName }); } catch { /* best-effort */ }
  }
}

// Mint the raw actor JWT for the data plane (separated so tests can stub).
async function mintRawActorJwt({ opts, atespace, name }) {
  const reqBuf = Buffer.concat([
    require('./grpc-wire').pbMessage(1, substrate.encodeObjectRef({ atespace, name })),
    require('./grpc-wire').pbString(2, 'substrate-router'),
    require('./grpc-wire').pbVarint(3, 120),
  ]);
  const res = await substrate.grpcCall('MintActorJwt', reqBuf, opts);
  if (res.status !== substrate.GRPC_OK) throw new Error(`MintActorJwt failed (${res.status}): ${res.message}`);
  const { decodeFields, getString } = require('./grpc-wire');
  return getString(decodeFields(res.firstFrame), 1);
}

module.exports = {
  syncSubstrateSecrets,
  dispatchActorPrompt,
  verifyActorJwt,
  runPlanningOnSubstrate,
  fingerprintOnly,
  REDACTED,
};
