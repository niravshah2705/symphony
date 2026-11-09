'use strict';

const http2 = require('node:http2');
const crypto = require('node:crypto');
// Destructured, not `const CONFIG = require('../config')`: that bound the module
// object, so every `CONFIG.SUBSTRATE.*` read below resolved to undefined and the
// SUBSTRATE_URL / SUBSTRATE_ATESPACE / SUBSTRATE_WORKER_POOL env was silently
// ignored — only settings.substrateUrl ever reached the control plane.
const { CONFIG } = require('../config');
const { getSettings } = require('../store');
const {
  pbVarint,
  pbString,
  pbBytes,
  pbMessage,
  pbMapStringString,
  decodeFields,
  getString,
  getStrings,
  getVarint,
  getSubmessages,
  getSubmessage,
  getMapStringString,
  frameGrpcMessage,
  unframeGrpcMessages,
} = require('./grpc-wire');

// ── Agent Substrate ateapi client ───────────────────────────────────────────
//
// Zero-trust Kubernetes agent runtime (github.com/agent-substrate/substrate).
// Mirrors ./openshell.js: a hand-rolled gRPC-over-HTTP/2 client driving the
// `substrate.ateapi.v1.Control` service. Field numbers below are read from the
// ateapi .proto, not guessed. Reuses the shared protobuf wire codec (./grpc-wire).
//
// Identity/credentials are always managed OUTSIDE the actor: the egress gateway
// injects them, so we never put a raw token into a Container env. The actor
// reaches the LLM/repo only through the guardrail EgressPolicy we create per actor.

const SERVICE_PATH = '/substrate.ateapi.v1.Control';
const DEFAULT_SUBSTRATE_URL = ''; // substrate is inert until an operator configures it
const DEFAULT_ATESPACE = 'tenant-a';
// Empty: which spaces exist is a deployment fact, read from config. Hardcoding a
// permissive list here is what made an unbound org routable into tenant-b.
const ALLOWED_ATESPACES = [];
const DEFAULT_WORKER_POOL = 'planner-pool';

// ActorState enum (substrate.ateapi.v1.ActorState)
const ACTOR_STATE = {
  0: 'UNSPECIFIED',
  1: 'RESUMING',
  2: 'RUNNING',
  3: 'SUSPENDING',
  4: 'SUSPENDED',
  5: 'CRASHED',
  6: 'DELETING',
  7: 'REVERTING',
};

// gRPC status codes we surface (grpc.io spec).
const GRPC_OK = 0;
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;

// ── URL / atespace resolution (mirror resolveOpenShellUrl / resolveOpenShellWorkspace) ──

function resolveSubstrateUrl(explicitUrl) {
  if (explicitUrl && String(explicitUrl).trim()) {
    return String(explicitUrl).trim().replace(/\/+$/, '');
  }
  try {
    const settings = getSettings?.() || {};
    if (settings.substrateUrl && String(settings.substrateUrl).trim()) {
      return String(settings.substrateUrl).trim().replace(/\/+$/, '');
    }
  } catch {
    // ignore store read errors
  }
  return (CONFIG?.SUBSTRATE?.url || DEFAULT_SUBSTRATE_URL).replace(/\/+$/, '');
}

function resolveSubstrateIngressUrl(explicitUrl) {
  if (explicitUrl && String(explicitUrl).trim()) {
    return String(explicitUrl).trim().replace(/\/+$/, '');
  }
  try {
    const settings = getSettings?.() || {};
    if (settings.substrateIngressUrl && String(settings.substrateIngressUrl).trim()) {
      return String(settings.substrateIngressUrl).trim().replace(/\/+$/, '');
    }
  } catch {
    // ignore
  }
  return (CONFIG?.SUBSTRATE?.ingressUrl || '').replace(/\/+$/, '');
}

/**
 * Resolve the Substrate atespace (tenant isolation scope) for an org/project.
 *
 * An atespace is a namespace boundary: two orgs that land in the same one share
 * actors, worker pools and egress policy. So the answer comes only from the
 * operator's declared routing (allowlist, per-deployment default, or the
 * org→atespace binding table) — never from a string shape inside an org id, which
 * is what the retired `endsWith('-b')` rule did and why an org named `…-b` that
 * was never provisioned as tenant-b got isolated plumbing it did not own.
 *
 * Order:
 *  1. an explicit `atespace`/`workspace`, or the settings value — honored only if
 *     the operator allows that name, since these can originate from a request;
 *  2. the org→atespace binding table (`SUBSTRATE_ATESPACE_BY_ORG`), for a shared
 *     deployment fronting several tenants;
 *  3. the deployment's own configured atespace (`SUBSTRATE_ATESPACE`), which is
 *     what a per-tenant stack pins, derived once at plan time from the validated
 *     deployment slug rather than re-derived per call;
 *  4. the single-space default, but only when no multi-tenant routing is
 *     configured at all.
 *
 * Once an operator HAS declared multiple spaces, an organization that is not bound
 * to any of them is an error rather than a guess: defaulting it into the shared
 * space is how a tenant's run ends up in another tenant's namespace.
 */
function resolveSubstrateAtespace(input = {}) {
  const { atespace, workspace, organizationId } =
    typeof input === 'string' ? { atespace: input } : input || {};
  const configured = CONFIG?.SUBSTRATE || {};
  const bindings = configured.atespaceByOrg || {};
  // The operator's own declarations are also nameable by a caller; a request may
  // not reach a space the deployment has not already put in writing.
  const nameable = new Set([
    ...(configured.allowedAtespaces || ALLOWED_ATESPACES),
    ...Object.values(bindings),
    ...(configured.atespace ? [configured.atespace] : []),
  ]);
  const shape = (raw) => (raw ? String(raw).trim().toLowerCase() : '');
  const pick = (raw) => {
    const v = shape(raw);
    return v && v !== 'default' && nameable.has(v) ? v : '';
  };

  const direct = pick(atespace) || pick(workspace);
  if (direct) return direct;

  try {
    const settings = getSettings?.() || {};
    const cfg = pick(settings.substrateAtespace);
    if (cfg) return cfg;
  } catch {
    // ignore store read errors
  }

  const orgStr = shape(organizationId);
  const bound = orgStr ? shape(bindings[orgStr]) : '';
  if (bound) return bound;

  const own = shape(configured.atespace);
  if (own) return own;

  const multiTenant = nameable.size > 0;
  if (multiTenant) {
    if (orgStr) {
      throw new Error(`substrate: organization ${orgStr} is not bound to any atespace `
        + `(configured: ${[...nameable].join(', ') || 'none'}); set SUBSTRATE_ATESPACE_BY_ORG`);
    }
    throw new Error('substrate: no atespace configured for this deployment; set SUBSTRATE_ATESPACE '
      + 'or SUBSTRATE_ATESPACE_BY_ORG');
  }
  // A deployment that declared no tenancy at all runs the single historical space.
  // projectId is no longer consulted: an org, not a project, owns the namespace.
  return DEFAULT_ATESPACE;
}

function resolveSubstrateWorkerPool(explicit) {
  const v = explicit || CONFIG?.SUBSTRATE?.workerPool || DEFAULT_WORKER_POOL;
  return String(v).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || DEFAULT_WORKER_POOL;
}

/**
 * Normalize a per-run ephemeral actor name. Actors are scoped to an atespace, so
 * the name need not carry the tenant prefix; we still cap and sanitize it.
 */
function normalizeActorName(explicitName, projectId, runId) {
  const base =
    (explicitName && String(explicitName).trim()) ||
    `plan-${String(projectId || 'default').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 12)}-${String(runId || crypto.randomBytes(4).toString('hex'))}`;
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return cleaned || `plan-${crypto.randomBytes(4).toString('hex')}`;
}

// ── gRPC HTTP/2 transport (mirrors openshell grpcCall, adds SPIFFE/mTLS) ──────

/**
 * Perform a unary gRPC call over HTTP/2 against the Substrate ateapi Control plane.
 * Returns `{ status, message, headers, trailers, frames, firstFrame }`.
 * `options.transport` short-circuits the wire for tests/fakes.
 */
async function grpcCall(method, requestPayload = Buffer.alloc(0), options = {}) {
  const baseUrl = resolveSubstrateUrl(options.url);
  if (!baseUrl) {
    throw new Error(`Substrate not configured: no URL for ${method} (set settings.substrateUrl / SUBSTRATE_URL)`);
  }
  const timeoutMs = options.timeoutMs || CONFIG?.SUBSTRATE?.timeoutMs || 60_000;

  if (typeof options.transport === 'function') {
    return options.transport(method, requestPayload, { baseUrl, timeoutMs, ...options });
  }

  return new Promise((resolve, reject) => {
    let client;
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client?.close(); } catch { /* ignore */ }
      fn(val);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`Substrate gRPC timeout after ${timeoutMs}ms calling ${method}`));
    }, timeoutMs);

    // mTLS: our backend presents a projected SPIFFE X.509-SVID to the Control plane.
    const connectOpts = {};
    if (options.ca) connectOpts.ca = options.ca;
    if (options.cert) connectOpts.cert = options.cert;
    if (options.key) connectOpts.key = options.key;
    if (typeof options.rejectUnauthorized === 'boolean') {
      connectOpts.rejectUnauthorized = options.rejectUnauthorized;
    }

    try {
      client = Object.keys(connectOpts).length
        ? http2.connect(baseUrl, connectOpts)
        : http2.connect(baseUrl);
    } catch (err) {
      finish(reject, err);
      return;
    }
    client.on('error', (err) => finish(reject, err));

    const token = options.token || options.apiKey || process.env.SUBSTRATE_TOKEN || '';
    const reqHeaders = {
      ':method': 'POST',
      ':path': `${SERVICE_PATH}/${method}`,
      'content-type': 'application/grpc+proto',
      te: 'trailers',
      'user-agent': 'ai-fleet-substrate-client/1.0',
    };
    if (token) {
      reqHeaders.authorization = /^Bearer\s+/i.test(String(token)) ? String(token) : `Bearer ${String(token).trim()}`;
    }

    const req = client.request(reqHeaders);
    let responseHeaders = {};
    let responseTrailers = {};
    const chunks = [];
    req.on('response', (headers) => { responseHeaders = headers || {}; });
    req.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); });
    req.on('trailers', (trailers) => { responseTrailers = trailers || {}; });
    req.on('error', (err) => finish(reject, err));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const frames = unframeGrpcMessages(raw).map((f) => f.data);
      const grpcStatusRaw = responseTrailers['grpc-status'] ?? responseHeaders['grpc-status'] ?? '0';
      const grpcStatus = Number(grpcStatusRaw);
      const grpcMessageRaw = responseTrailers['grpc-message'] ?? responseHeaders['grpc-message'] ?? '';
      const grpcMessage = grpcMessageRaw ? decodeURIComponent(String(grpcMessageRaw)) : '';
      finish(resolve, {
        status: grpcStatus,
        message: grpcMessage,
        headers: responseHeaders,
        trailers: responseTrailers,
        frames,
        firstFrame: frames[0] || Buffer.alloc(0),
      });
    });
    req.end(frameGrpcMessage(requestPayload));
  });
}

// ── Protobuf builders (field numbers from ateapi.proto) ──────────────────────

// ResourceMetadata: atespace=1, name=2, uid=3, version=4
function encodeMetadata({ atespace, name, uid, version } = {}) {
  return Buffer.concat([
    pbString(1, atespace),
    pbString(2, name),
    pbString(3, uid),
    pbVarint(4, version || 0),
  ]);
}

// ObjectRef: atespace=1, name=2
function encodeObjectRef({ atespace, name } = {}) {
  return Buffer.concat([pbString(1, atespace), pbString(2, name)]);
}

// Selector: match_labels=1 (map<string,string>)
function encodeSelector(matchLabels) {
  return pbMapStringString(1, matchLabels);
}

// EnvVar: name=1, value=2  (Substrate supports LITERAL value only, no valueFrom)
function encodeEnvVar(name, value) {
  return Buffer.concat([pbString(1, name), pbString(2, value)]);
}

// HttpGetAction: path=1, port=2
function encodeHttpGet({ path, port } = {}) {
  return Buffer.concat([pbString(1, path), pbVarint(2, port || 0)]);
}

// WakeupProbe: http_get=1, timeout_seconds=2
function encodeWakeupProbe({ path, port, timeoutSeconds } = {}) {
  return Buffer.concat([
    path ? pbMessage(1, encodeHttpGet({ path, port })) : Buffer.alloc(0),
    pbVarint(2, timeoutSeconds || 0),
  ]);
}

// Container: name=1, image=2, command=3, args=4, env=5, wakeup_probe=6, resources=9
function encodeContainer({ name, image, command, args, env, wakeupProbe, resources } = {}) {
  const parts = [
    pbString(1, name),
    pbString(2, image),
    ...((command || []).map((c) => pbString(3, c))),
    ...((args || []).map((a) => pbString(4, a))),
    ...Object.entries(env || {}).map(([k, v]) => pbMessage(5, encodeEnvVar(k, v))),
    wakeupProbe ? pbMessage(6, encodeWakeupProbe(wakeupProbe)) : Buffer.alloc(0),
    resources ? pbMessage(9, encodeResourceRequirements(resources)) : Buffer.alloc(0),
  ];
  return Buffer.concat(parts);
}

// Resources: cpu_millicores=1, memory_bytes=2 ; ResourceRequirements: limits=1
function encodeResources({ cpuMillicores, memoryBytes } = {}) {
  return Buffer.concat([pbVarint(1, cpuMillicores || 0), pbVarint(2, memoryBytes || 0)]);
}
function encodeResourceRequirements(limits) {
  return pbMessage(1, encodeResources(limits));
}

// ActorTemplate: metadata=1, worker_selector=2, containers=3, resources=6, golden_egress_policy=9
function encodeActorTemplate({ metadata, workerSelector, containers, resources, goldenEgressPolicy } = {}) {
  return Buffer.concat([
    metadata ? pbMessage(1, encodeMetadata(metadata)) : Buffer.alloc(0),
    workerSelector ? pbMessage(2, encodeSelector(workerSelector)) : Buffer.alloc(0),
    ...(containers || []).map((c) => pbMessage(3, encodeContainer(c))),
    resources ? pbMessage(6, encodeResourceRequirements(resources)) : Buffer.alloc(0),
    goldenEgressPolicy ? pbMessage(9, encodeEgressPolicyTemplate(goldenEgressPolicy)) : Buffer.alloc(0),
  ]);
}

// Ports: all=1, numbers=2 (repeated int32, proto3 packed). Serialize the Ports
// message itself: a packed field 2 whose bytes are bare varints (wire type 0).
function encodePortsMessage(numbers) {
  if (!numbers || !numbers.length) return Buffer.alloc(0);
  const packed = Buffer.concat(numbers.map((n) => pbVarint(1, n).subarray(1))); // raw varint bytes only
  return pbMessage(2, packed);
}

// HttpsRule/HttpRule/TlsPassthroughRule: hostnames=1 (repeated string), ports=2 (Ports message)
function encodeHttpEgressRule(kind) {
  return Buffer.concat([
    ...(kind.hostnames || []).map((h) => pbString(1, h)),
    kind.ports && kind.ports.length ? pbMessage(2, encodePortsMessage(kind.ports)) : Buffer.alloc(0),
  ]);
}

// EgressRule: http=1, https=2, tls_passthrough=3
function encodeEgressRule({ https, http, tlsPassthrough } = {}) {
  return Buffer.concat([
    http ? pbMessage(1, encodeHttpEgressRule(http)) : Buffer.alloc(0),
    https ? pbMessage(2, encodeHttpEgressRule(https)) : Buffer.alloc(0),
    tlsPassthrough ? pbMessage(3, encodeHttpEgressRule(tlsPassthrough)) : Buffer.alloc(0),
  ]);
}

function encodeEgressPolicyTemplate(rules) {
  return Buffer.concat((rules || []).map((r) => pbMessage(1, encodeEgressRule(r))));
}
function encodeEgressPolicy({ metadata, rules } = {}) {
  return Buffer.concat([
    metadata ? pbMessage(1, encodeMetadata(metadata)) : Buffer.alloc(0),
    ...(rules || []).map((r) => pbMessage(2, encodeEgressRule(r))),
  ]);
}

// Actor: metadata=1, actor_template=2, worker_selector=3
function encodeActor({ metadata, actorTemplate, workerSelector } = {}) {
  return Buffer.concat([
    metadata ? pbMessage(1, encodeMetadata(metadata)) : Buffer.alloc(0),
    actorTemplate ? pbMessage(2, encodeObjectRef(actorTemplate)) : Buffer.alloc(0),
    workerSelector ? pbMessage(3, encodeSelector(workerSelector)) : Buffer.alloc(0),
  ]);
}

// ── Protobuf decoders ────────────────────────────────────────────────────────

function decodeMetadata(fieldsOrBuf) {
  if (!fieldsOrBuf) return { atespace: '', name: '', uid: '', version: 0 };
  const fields = Buffer.isBuffer(fieldsOrBuf) ? decodeFields(fieldsOrBuf) : fieldsOrBuf;
  return {
    atespace: getString(fields, 1),
    name: getString(fields, 2),
    uid: getString(fields, 3),
    version: getVarint(fields, 4, 0),
  };
}

function decodeActor(fieldsOrBuf) {
  if (!fieldsOrBuf) return null;
  const fields = Buffer.isBuffer(fieldsOrBuf) ? decodeFields(fieldsOrBuf) : fieldsOrBuf;
  const metadata = decodeMetadata(getSubmessage(fields, 1));
  const statusFields = getSubmessage(fields, 5);
  const stateCode = statusFields ? getVarint(statusFields, 1, 0) : 0;
  const assignment = statusFields ? getSubmessage(statusFields, 2) : null;
  return {
    metadata,
    status: {
      state: ACTOR_STATE[stateCode] || 'UNSPECIFIED',
      stateCode,
      workerPod: assignment ? getString(assignment, 3) : '',
      workerPool: assignment ? getString(assignment, 2) : '',
      nodeName: statusFields ? getString(statusFields, 5) : '',
    },
  };
}

function decodeActorTemplate(fieldsOrBuf) {
  if (!fieldsOrBuf) return null;
  const fields = Buffer.isBuffer(fieldsOrBuf) ? decodeFields(fieldsOrBuf) : fieldsOrBuf;
  return {
    metadata: decodeMetadata(getSubmessage(fields, 1)),
    containers: getSubmessages(fields, 3).map((c) => ({
      name: getString(c, 1),
      image: getString(c, 2),
    })),
  };
}

function decodeAtespace(fieldsOrBuf) {
  if (!fieldsOrBuf) return null;
  const fields = Buffer.isBuffer(fieldsOrBuf) ? decodeFields(fieldsOrBuf) : fieldsOrBuf;
  return { metadata: decodeMetadata(getSubmessage(fields, 1)) };
}

function decodeEgressPolicy(fieldsOrBuf) {
  if (!fieldsOrBuf) return { metadata: decodeMetadata(null), rules: [] };
  const fields = Buffer.isBuffer(fieldsOrBuf) ? decodeFields(fieldsOrBuf) : fieldsOrBuf;
  const rules = getSubmessages(fields, 2).map((r) => {
    const https = getSubmessage(r, 2);
    const http = getSubmessage(r, 1);
    const src = https || http;
    return {
      scheme: https ? 'https' : http ? 'http' : 'tls_passthrough',
      hostnames: src ? getStrings(src, 1) : [],
    };
  });
  return { metadata: decodeMetadata(getSubmessage(fields, 1)), rules };
}

function decodeMintActorJwt(fieldsOrBuf) {
  const fields = Buffer.isBuffer(fieldsOrBuf) ? decodeFields(fieldsOrBuf || Buffer.alloc(0)) : fieldsOrBuf;
  return { actorJwt: getString(fields, 1), expireTime: getVarint(fields, 2, 0) };
}

// ── Control-plane operations (mirror the OpenShell equivalents) ──────────────

async function getControlPlaneStatus(options = {}) {
  const url = resolveSubstrateUrl(options.url);
  if (!url) {
    return {
      configured: false,
      connected: false,
      url: '',
      status: 'UNCONFIGURED',
      version: null,
      error: 'Substrate is not configured (set settings.substrateUrl or SUBSTRATE_URL).',
    };
  }
  try {
    // ListActors with an empty atespace is the lightest reachability probe that
    // also exercises RBAC; a 0grpc-status reply means the Control plane answered.
    const reqBuf = pbString(1, resolveSubstrateAtespace(options));
    const res = await grpcCall('ListActors', reqBuf, options);
    return {
      configured: true,
      connected: res.status === GRPC_OK,
      url,
      status: res.status === GRPC_OK ? 'SERVING' : 'DEGRADED',
      grpcStatus: res.status,
      grpcMessage: res.message,
      atespace: resolveSubstrateAtespace(options),
    };
  } catch (err) {
    return {
      configured: true,
      connected: false,
      url,
      status: 'OFFLINE',
      atespace: resolveSubstrateAtespace(options),
      error: err?.message || String(err),
    };
  }
}

async function ensureAtespace(input = {}) {
  const atespace = resolveSubstrateAtespace(input);
  const createReq = pbMessage(1, pbMessage(1, encodeMetadata({ atespace, name: atespace })));
  try {
    const created = await grpcCall('CreateAtespace', createReq, input);
    if (created.status === GRPC_OK || created.status === GRPC_ALREADY_EXISTS) {
      return { atespace, created: created.status === GRPC_OK, existed: created.status === GRPC_ALREADY_EXISTS };
    }
    throw new Error(`CreateAtespace failed (${created.status}): ${created.message}`);
  } catch (err) {
    // Fall back to a read to confirm the atespace is already usable.
    const getReq = pbMessage(1, encodeObjectRef({ atespace, name: atespace }));
    const got = await grpcCall('GetAtespace', getReq, input);
    if (got.status === GRPC_OK) return { atespace, created: false, existed: true };
    throw err;
  }
}

/**
 * Ensure the org's planner ActorTemplate exists (once per tenant). The planner
 * image MUST be pinned by digest (image@sha256:...) per the ActorTemplate schema.
 */
async function upsertActorTemplate(input = {}) {
  const atespace = resolveSubstrateAtespace(input);
  const name = input.name || (await readSetting('substrateActorTemplate')) || 'planner';
  const image = input.image || (await readSetting('substratePlannerImage')) || CONFIG?.SUBSTRATE?.plannerImage || '';
  if (image && !image.includes('@sha256:')) {
    throw new Error('substratePlannerImage must be pinned by digest (name@sha256:...) for ActorTemplate.');
  }
  const workerPool = resolveSubstrateWorkerPool(input.workerPool || (await readSetting('substrateWorkerPool')));
  const containers = [{
    name: 'planner',
    image,
    wakeupProbe: input.wakeupProbe || { path: '/healthz', port: 8080, timeoutSeconds: 5 },
    resources: input.resources || { cpuMillicores: 1000, memoryBytes: 1073741824 },
  }];
  const template = {
    metadata: { atespace, name },
    workerSelector: { 'ate.dev/worker-pool': workerPool },
    containers,
    resources: input.resources || { cpuMillicores: 1000, memoryBytes: 1073741824 },
    goldenEgressPolicy: input.goldenEgressPolicy || [],
  };
  const req = pbMessage(1, encodeActorTemplate(template));
  const res = await grpcCall('CreateActorTemplate', req, input);
  if (res.status === GRPC_OK || res.status === GRPC_ALREADY_EXISTS) {
    return { atespace, name, created: res.status === GRPC_OK, existed: res.status === GRPC_ALREADY_EXISTS };
  }
  throw new Error(`CreateActorTemplate failed (${res.status}): ${res.message}`);
}

async function getActorTemplate(input = {}) {
  const atespace = resolveSubstrateAtespace(input);
  const name = input.name || (await readSetting('substrateActorTemplate')) || 'planner';
  const req = pbMessage(1, encodeObjectRef({ atespace, name }));
  const res = await grpcCall('GetActorTemplate', req, input);
  if (res.status === GRPC_NOT_FOUND) return null;
  if (res.status !== GRPC_OK) throw new Error(`GetActorTemplate failed (${res.status}): ${res.message}`);
  return decodeActorTemplate(res.firstFrame);
}

async function createEphemeralActor(input = {}) {
  const atespace = resolveSubstrateAtespace(input);
  const templateName = input.actorTemplate || (await readSetting('substrateActorTemplate')) || 'planner';
  const name = normalizeActorName(input.actorName, input.projectId, input.runId);
  const workerPool = resolveSubstrateWorkerPool(input.workerPool);
  const actor = {
    metadata: { atespace, name },
    actorTemplate: { atespace, name: templateName },
    workerSelector: { 'ate.dev/worker-pool': workerPool },
  };
  const req = pbMessage(1, encodeActor(actor));
  const res = await grpcCall('CreateActor', req, input);
  if (res.status !== GRPC_OK) throw new Error(`CreateActor failed (${res.status}): ${res.message}`);
  return decodeActor(res.firstFrame) || { metadata: { atespace, name }, status: {} };
}

async function getActorStatus({ atespace, name, ...options } = {}) {
  const req = pbMessage(1, encodeObjectRef({ atespace, name }));
  const res = await grpcCall('GetActor', req, options);
  if (res.status === GRPC_NOT_FOUND) return null;
  if (res.status !== GRPC_OK) throw new Error(`GetActor failed (${res.status}): ${res.message}`);
  return decodeActor(res.firstFrame);
}

async function resumeActor({ atespace, name, ...options } = {}) {
  const req = pbMessage(1, encodeObjectRef({ atespace, name }));
  const res = await grpcCall('ResumeActor', req, options);
  if (res.status !== GRPC_OK) throw new Error(`ResumeActor failed (${res.status}): ${res.message}`);
  const fields = decodeFields(res.firstFrame);
  return { actor: decodeActor(getSubmessage(fields, 1)), resumed: getVarint(fields, 2, 0) === 1 };
}

async function suspendActor({ atespace, name, ...options } = {}) {
  const req = pbMessage(1, encodeObjectRef({ atespace, name }));
  const res = await grpcCall('SuspendActor', req, options);
  if (res.status !== GRPC_OK) throw new Error(`SuspendActor failed (${res.status}): ${res.message}`);
  return decodeActor(getSubmessage(decodeFields(res.firstFrame), 1));
}

async function deleteActor({ atespace, name, ...options } = {}) {
  const req = pbMessage(1, encodeObjectRef({ atespace, name }));
  const res = await grpcCall('DeleteActor', req, options);
  if (res.status !== GRPC_OK && res.status !== GRPC_NOT_FOUND) {
    throw new Error(`DeleteActor failed (${res.status}): ${res.message}`);
  }
  return { deleted: res.status === GRPC_OK, notFound: res.status === GRPC_NOT_FOUND };
}

async function listActors(input = {}) {
  const atespace = resolveSubstrateAtespace(input);
  const req = pbString(1, atespace);
  const res = await grpcCall('ListActors', req, input);
  if (res.status !== GRPC_OK) throw new Error(`ListActors failed (${res.status}): ${res.message}`);
  const fields = decodeFields(res.firstFrame);
  return getSubmessages(fields, 1).map(decodeActor).filter(Boolean);
}

/**
 * Mint a short-lived Substrate-issued JWT asserting the actor identity, for the
 * egress gateway to inject on outbound requests. Never logged or returned raw.
 */
async function mintActorJwt({ atespace, name, audiences = [], expirationSeconds = 120, ...options } = {}) {
  const reqBuf = Buffer.concat([
    pbMessage(1, encodeObjectRef({ atespace, name })),
    ...(audiences || []).map((a) => pbString(2, a)),
    pbVarint(3, expirationSeconds || 120),
  ]);
  const res = await grpcCall('MintActorJwt', reqBuf, options);
  if (res.status !== GRPC_OK) throw new Error(`MintActorJwt failed (${res.status}): ${res.message}`);
  const { actorJwt } = decodeMintActorJwt(res.firstFrame);
  return { tokenPresent: Boolean(actorJwt), fingerprint: actorJwt ? crypto.createHash('sha256').update(actorJwt).digest('hex').slice(0, 12) : '' };
}

/**
 * Create the per-actor EgressPolicy from a normalized guardrail spec. Renders the
 * egress allow-hosts as HTTPS rules; deny-by-default is enforced by the empty
 * namespace policy Substrate ships plus the metadata-CIDR block (see guardrails).
 */
async function createActorEgressPolicy({ atespace, name, guardrailSpec, rules, ...options } = {}) {
  // Prefer prebuilt rules; otherwise derive them from the shared guardrail spec so
  // both substrates render egress from ONE operator-edited object.
  const finalRules = rules || (guardrailSpec ? require('../guardrails/consumers').buildAtenetEgressPolicy(guardrailSpec).rules : []);
  const reqBuf = Buffer.concat([
    pbMessage(1, encodeObjectRef({ atespace, name })),
    pbMessage(2, encodeEgressPolicy({ metadata: { atespace, name: 'default' }, rules: finalRules })),
  ]);
  const res = await grpcCall('CreateActorEgressPolicy', reqBuf, options);
  if (res.status !== GRPC_OK && res.status !== GRPC_ALREADY_EXISTS) {
    throw new Error(`CreateActorEgressPolicy failed (${res.status}): ${res.message}`);
  }
  return decodeEgressPolicy(res.firstFrame);
}

async function readSetting(key) {
  try {
    return getSettings?.()[key] || '';
  } catch {
    return '';
  }
}

module.exports = {
  SERVICE_PATH,
  ACTOR_STATE,
  GRPC_OK,
  GRPC_NOT_FOUND,
  GRPC_ALREADY_EXISTS,
  resolveSubstrateUrl,
  resolveSubstrateIngressUrl,
  resolveSubstrateAtespace,
  resolveSubstrateWorkerPool,
  normalizeActorName,
  grpcCall,
  getControlPlaneStatus,
  ensureAtespace,
  upsertActorTemplate,
  getActorTemplate,
  createEphemeralActor,
  getActorStatus,
  resumeActor,
  suspendActor,
  deleteActor,
  listActors,
  mintActorJwt,
  createActorEgressPolicy,
  // exported for tests
  encodeMetadata,
  encodeObjectRef,
  encodeContainer,
  encodeActorTemplate,
  encodeActor,
  encodeEgressPolicy,
  encodeEgressRule,
  decodeMetadata,
  decodeActor,
  decodeEgressPolicy,
};
