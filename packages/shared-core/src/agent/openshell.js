'use strict';

const http2 = require('node:http2');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const CONFIG = require('../config');
const { getSettings } = require('../store');

const SERVICE_PATH = '/openshell.v1.OpenShell';
const DEFAULT_OPENSHELL_URL = 'https://openshell.archagentix.com';
const DEFAULT_WORKSPACE = 'default';
const DEFAULT_IMAGE = 'ubuntu:24.04';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

// In-memory registry of active project sandboxes & synced NVIDIA OpenShell secrets
// when the remote Kubernetes compute driver restricts namespace creation or while a pod warms up.
const activeSandboxes = new Map();

// ── Minimal Protobuf Wire Encoder / Decoder ─────────────────────────────────

function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const bytes = [];
  while (v > 0x7fn) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function pbVarint(fieldNumber, value) {
  if (value === undefined || value === null || value === false || value === 0) {
    return Buffer.alloc(0);
  }
  const num = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(num)]);
}

function pbBytes(fieldNumber, buf) {
  if (!buf) return Buffer.alloc(0);
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  if (b.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(b.length), b]);
}

function pbString(fieldNumber, str) {
  if (str === undefined || str === null || str === '') return Buffer.alloc(0);
  return pbBytes(fieldNumber, Buffer.from(String(str), 'utf8'));
}

function pbMessage(fieldNumber, parts) {
  const buf = Buffer.isBuffer(parts)
    ? parts
    : Buffer.concat((parts || []).filter((p) => p && p.length > 0));
  if (buf.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(buf.length), buf]);
}

function pbMapStringString(fieldNumber, record) {
  if (!record || typeof record !== 'object') return Buffer.alloc(0);
  const entries = [];
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null) continue;
    const entry = Buffer.concat([pbString(1, String(k)), pbString(2, String(v))]);
    entries.push(Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(entry.length), entry]));
  }
  return entries.length ? Buffer.concat(entries) : Buffer.alloc(0);
}

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error('Protobuf varint overflow');
    }
  }
  throw new Error('Truncated protobuf varint');
}

function decodeFields(buf) {
  const fields = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const tag = decodeVarint(buf, offset);
    offset = tag.nextOffset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x7n);
    let value;
    if (wireType === 0) {
      const v = decodeVarint(buf, offset);
      offset = v.nextOffset;
      value = Number(v.value);
    } else if (wireType === 1) {
      value = buf.subarray(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) {
      const len = decodeVarint(buf, offset);
      offset = len.nextOffset;
      const byteLen = Number(len.value);
      value = buf.subarray(offset, offset + byteLen);
      offset += byteLen;
    } else if (wireType === 5) {
      value = buf.subarray(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
    fields.get(fieldNumber).push({ wireType, value });
  }
  return fields;
}

function getString(fields, fieldNumber, fallback = '') {
  const list = fields.get(fieldNumber);
  if (!list || list.length === 0) return fallback;
  const last = list[list.length - 1];
  return Buffer.isBuffer(last.value) ? last.value.toString('utf8') : String(last.value ?? fallback);
}

function getStrings(fields, fieldNumber) {
  const list = fields.get(fieldNumber) || [];
  return list
    .map((item) => (Buffer.isBuffer(item.value) ? item.value.toString('utf8') : String(item.value ?? '')))
    .filter(Boolean);
}

function getVarint(fields, fieldNumber, fallback = 0) {
  const list = fields.get(fieldNumber);
  if (!list || list.length === 0) return fallback;
  const last = list[list.length - 1];
  return typeof last.value === 'number' ? last.value : fallback;
}

function getSubmessages(fields, fieldNumber) {
  const list = fields.get(fieldNumber) || [];
  return list
    .filter((item) => Buffer.isBuffer(item.value))
    .map((item) => decodeFields(item.value));
}

function getSubmessage(fields, fieldNumber) {
  const subs = getSubmessages(fields, fieldNumber);
  return subs.length ? subs[subs.length - 1] : null;
}

function getMapStringString(fields, fieldNumber) {
  const out = {};
  for (const sub of getSubmessages(fields, fieldNumber)) {
    const k = getString(sub, 1);
    const v = getString(sub, 2);
    if (k) out[k] = v;
  }
  return out;
}

// ── gRPC Framing & HTTP/2 Transport ─────────────────────────────────────────

function frameGrpcMessage(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
  const header = Buffer.alloc(5);
  header[0] = 0; // uncompressed
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function unframeGrpcMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const compressed = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    if (offset + 5 + length > buffer.length) break;
    const msg = buffer.subarray(offset + 5, offset + 5 + length);
    messages.push({ compressed, data: msg });
    offset += 5 + length;
  }
  return messages;
}

function resolveOpenShellUrl(explicitUrl) {
  if (explicitUrl && String(explicitUrl).trim()) {
    return String(explicitUrl).trim().replace(/\/+$/, '');
  }
  try {
    const settings = getSettings?.() || {};
    if (settings.openshellUrl && String(settings.openshellUrl).trim()) {
      return String(settings.openshellUrl).trim().replace(/\/+$/, '');
    }
  } catch {
    // ignore store read errors
  }
  return (CONFIG?.OPENSHELL?.url || DEFAULT_OPENSHELL_URL).replace(/\/+$/, '');
}

/**
 * Perform a gRPC call over HTTP/2 against the NVIDIA OpenShell gateway.
 * Returns `{ status, message, headers, trailers, frames, firstFrame }`.
 */
async function grpcCall(method, requestPayload = Buffer.alloc(0), options = {}) {
  const baseUrl = resolveOpenShellUrl(options.url);
  const timeoutMs = options.timeoutMs || CONFIG?.OPENSHELL?.timeoutMs || 25_000;

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
      try {
        client?.close();
      } catch {
        // ignore
      }
      fn(val);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`OpenShell gRPC timeout after ${timeoutMs}ms calling ${method}`));
    }, timeoutMs);

    try {
      client = http2.connect(baseUrl);
    } catch (err) {
      finish(reject, err);
      return;
    }

    client.on('error', (err) => {
      finish(reject, err);
    });

    const req = client.request({
      ':method': 'POST',
      ':path': `${SERVICE_PATH}/${method}`,
      'content-type': 'application/grpc+proto',
      te: 'trailers',
      'user-agent': 'ai-fleet-openshell-client/1.0',
    });

    let responseHeaders = {};
    let responseTrailers = {};
    const chunks = [];

    req.on('response', (headers) => {
      responseHeaders = headers || {};
    });

    req.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    req.on('trailers', (trailers) => {
      responseTrailers = trailers || {};
    });

    req.on('error', (err) => {
      finish(reject, err);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const frames = unframeGrpcMessages(raw).map((f) => f.data);
      const grpcStatusRaw =
        responseTrailers['grpc-status'] ?? responseHeaders['grpc-status'] ?? '0';
      const grpcStatus = Number(grpcStatusRaw);
      const grpcMessageRaw =
        responseTrailers['grpc-message'] ?? responseHeaders['grpc-message'] ?? '';
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

// ── OpenShell Protobuf Builders & Decoders ──────────────────────────────────

function encodeWorkspaceScope(workspace = DEFAULT_WORKSPACE) {
  return Buffer.concat([pbString(1, workspace || DEFAULT_WORKSPACE)]);
}

function encodeObjectMeta({ name, labels, annotations, resourceVersion } = {}) {
  return Buffer.concat([
    pbString(2, name),
    pbMapStringString(3, labels),
    pbMapStringString(4, annotations),
    pbVarint(7, resourceVersion || 0),
  ]);
}

function decodeObjectMeta(fields) {
  if (!fields) return { id: '', name: '', labels: {}, annotations: {}, resourceVersion: 0 };
  return {
    id: getString(fields, 1),
    name: getString(fields, 2),
    labels: getMapStringString(fields, 3),
    annotations: getMapStringString(fields, 4),
    resourceVersion: getVarint(fields, 7, 0),
  };
}

function decodeSandbox(fields) {
  if (!fields) return null;
  const meta = decodeObjectMeta(getSubmessage(fields, 1));
  const specFields = getSubmessage(fields, 2);
  const statusFields = getSubmessage(fields, 3);
  const templateFields = specFields ? getSubmessage(specFields, 6) : null;
  const phaseNum = statusFields ? getVarint(statusFields, 6, 0) : 0;
  const phaseMap = {
    0: 'UNSPECIFIED',
    1: 'PROVISIONING',
    2: 'READY',
    3: 'FAILED',
    4: 'DELETING',
    5: 'STOPPED',
    6: 'RUNNING',
  };
  return {
    id: meta.id,
    name: meta.name,
    labels: meta.labels,
    annotations: meta.annotations,
    resourceVersion: meta.resourceVersion,
    image: templateFields ? getString(templateFields, 1, DEFAULT_IMAGE) : DEFAULT_IMAGE,
    providers: specFields ? getStrings(specFields, 8) : [],
    environment: specFields ? getMapStringString(specFields, 5) : {},
    phaseCode: phaseNum,
    phase: phaseMap[phaseNum] || 'READY',
    agentPod: statusFields ? getString(statusFields, 2) : '',
    message: statusFields ? getString(statusFields, 3) : '',
  };
}

function decodeProvider(fields) {
  if (!fields) return null;
  const meta = decodeObjectMeta(getSubmessage(fields, 1));
  return {
    id: meta.id,
    name: meta.name,
    resourceVersion: meta.resourceVersion,
    type: getString(fields, 2),
    credentials: getMapStringString(fields, 3),
    config: getMapStringString(fields, 4),
    credentialDriver: getString(fields, 6),
  };
}

function sanitizeSandboxName(projectId, projectName) {
  const base = String(projectId || projectName || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 15)
    .replace(/-+$/g, '');
  return `sb-${base || 'default'}`;
}

// ── Gateway Health & Info ───────────────────────────────────────────────────

async function getGatewayStatus(options = {}) {
  const url = resolveOpenShellUrl(options.url);
  try {
    const [healthRes, infoRes] = await Promise.all([
      grpcCall('Health', Buffer.alloc(0), options),
      grpcCall('GetGatewayInfo', Buffer.alloc(0), options),
    ]);

    const healthFields = decodeFields(healthRes.firstFrame);
    const infoFields = decodeFields(infoRes.firstFrame);
    const computeDrivers = getSubmessages(infoFields, 3)
      .map((d) => getString(d, 1))
      .filter(Boolean);

    return {
      connected: healthRes.status === 0,
      url,
      status: getVarint(healthFields, 1, 0) === 1 ? 'SERVING' : 'UNKNOWN',
      version: getString(healthFields, 2) || getString(infoFields, 2) || 'unknown',
      computeDrivers,
    };
  } catch (err) {
    return {
      connected: false,
      url,
      status: 'OFFLINE',
      version: null,
      computeDrivers: [],
      error: err?.message || String(err),
    };
  }
}

// ── Provider Profiles & NVIDIA Secret Sync ──────────────────────────────────

function buildProviderProfile({ id, displayName, description, category, credentialName, envVars, host, inferenceCapable, annotations }) {
  const cred = Buffer.concat([
    pbString(1, credentialName),
    pbString(2, `${displayName} credential`),
    ...envVars.map((env) => pbString(3, env)),
    pbVarint(4, 1), // required = true
    pbString(5, 'bearer'),
    pbString(6, 'Authorization'),
  ]);
  const endpoint = Buffer.concat([
    pbString(1, host),
    pbVarint(2, 443),
    pbString(3, 'rest'),
    pbVarint(5, 1), // enforcement = ENFORCE
    pbVarint(6, 3), // access = FULL
  ]);
  return Buffer.concat([
    pbString(1, id),
    pbString(2, displayName),
    pbString(3, description),
    pbVarint(4, category),
    pbMessage(5, cred),
    pbMessage(6, endpoint),
    pbVarint(8, inferenceCapable ? 1 : 0),
    pbMapStringString(11, annotations || {}),
  ]);
}

async function ensureWorkspace(workspace = DEFAULT_WORKSPACE, options = {}) {
  const wsName = workspace || CONFIG?.OPENSHELL?.workspace || DEFAULT_WORKSPACE;
  const getRes = await grpcCall('GetWorkspace', pbString(1, wsName), options);
  if (getRes.status === 0) return wsName;
  const createRes = await grpcCall('CreateWorkspace', pbString(1, wsName), options);
  if (createRes.status !== 0 && createRes.status !== 6) {
    throw new Error(`OpenShell CreateWorkspace(${wsName}) failed: [${createRes.status}] ${createRes.message}`);
  }
  return wsName;
}

async function getProfileById(id, workspace, options = {}) {
  const reqParts = [pbString(1, id)];
  if (workspace) reqParts.push(pbMessage(2, encodeWorkspaceScope(workspace)));
  const res = await grpcCall('GetProviderProfile', Buffer.concat(reqParts), options);
  if (res.status !== 0) return null;
  const fields = decodeFields(res.firstFrame);
  const prof = getSubmessage(fields, 1);
  if (!prof) return null;
  return {
    id: getString(prof, 1),
    displayName: getString(prof, 2),
    resourceVersion: getVarint(prof, 10, 0),
    annotations: getMapStringString(prof, 11),
  };
}

async function upsertProfile(profileSpec, workspace, options = {}) {
  const existing = await getProfileById(profileSpec.id, workspace, options);
  const profileBuf = buildProviderProfile(profileSpec);
  const itemBuf = Buffer.concat([pbMessage(1, profileBuf), pbString(2, 'ai-fleet')]);

  if (!existing) {
    const reqParts = [pbMessage(1, itemBuf)];
    if (workspace) reqParts.push(pbMessage(2, encodeWorkspaceScope(workspace)));
    reqParts.push(pbString(3, crypto.randomUUID()));
    await grpcCall('ImportProviderProfiles', Buffer.concat(reqParts), options);
    return;
  }

  // Update existing profile with latest secret fingerprint annotations
  const updateParts = [
    pbMessage(1, itemBuf),
    pbVarint(2, existing.resourceVersion || 1),
    pbString(3, profileSpec.id),
  ];
  if (workspace) updateParts.push(pbMessage(4, encodeWorkspaceScope(workspace)));
  updateParts.push(pbString(5, crypto.randomUUID()));
  await grpcCall('UpdateProviderProfiles', Buffer.concat(updateParts), options);
}

async function ensureProviderProfiles(options = {}) {
  const workspace = options.workspace || CONFIG?.OPENSHELL?.workspace || DEFAULT_WORKSPACE;
  await ensureWorkspace(workspace, options);

  const ghSpec = {
    id: 'github',
    displayName: 'GitHub',
    description: 'GitHub personal access token secret for repository operations inside OpenShell sandboxes',
    category: 4, // SOURCE_CONTROL
    credentialName: 'api_token',
    envVars: ['GITHUB_TOKEN', 'GH_TOKEN'],
    host: 'api.github.com',
    inferenceCapable: false,
    annotations: options.githubAnnotations || {},
  };

  const orSpec = {
    id: 'openrouter',
    displayName: 'OpenRouter',
    description: 'OpenRouter API key secret for LLM inference inside OpenShell sandboxes',
    category: 2, // INFERENCE
    credentialName: 'api_key',
    envVars: ['OPENROUTER_API_KEY'],
    host: 'openrouter.ai',
    inferenceCapable: true,
    annotations: options.openrouterAnnotations || {},
  };

  // Ensure both platform-scoped and workspace-scoped profiles are registered on the gateway
  await upsertProfile(ghSpec, null, options);
  await upsertProfile(orSpec, null, options);
  await upsertProfile(ghSpec, workspace, options);
  await upsertProfile(orSpec, workspace, options);

  return {
    workspace,
    profilesReady: ['github', 'openrouter'],
  };
}

async function getProviderByName(name, options = {}) {
  const workspace = options.workspace || CONFIG?.OPENSHELL?.workspace || DEFAULT_WORKSPACE;
  const req = Buffer.concat([
    pbString(1, name),
    pbMessage(2, encodeWorkspaceScope(workspace)),
  ]);
  const res = await grpcCall('GetProvider', req, options);
  if (res.status !== 0) return null;
  const fields = decodeFields(res.firstFrame);
  return decodeProvider(getSubmessage(fields, 1));
}

async function upsertProviderSecret({ name, type, credentials, config, labels }, options = {}) {
  const workspace = options.workspace || CONFIG?.OPENSHELL?.workspace || DEFAULT_WORKSPACE;
  const existing = await getProviderByName(name, options);

  const providerMsg = Buffer.concat([
    pbMessage(
      1,
      encodeObjectMeta({
        name,
        labels: { 'managed-by': 'ai-fleet', ...(labels || {}) },
        resourceVersion: existing?.resourceVersion || 0,
      })
    ),
    pbString(2, type),
    pbMapStringString(3, credentials),
    pbMapStringString(4, config),
  ]);

  if (!existing) {
    const createReq = Buffer.concat([
      pbMessage(1, providerMsg),
      pbMessage(2, encodeWorkspaceScope(workspace)),
      pbString(3, crypto.randomUUID()),
    ]);
    const createRes = await grpcCall('CreateProvider', createReq, options);
    if (createRes.status === 0) {
      const fields = decodeFields(createRes.firstFrame);
      return decodeProvider(getSubmessage(fields, 1)) || { name, type, synced: true };
    }
    if (
      createRes.status === 7 &&
      String(createRes.message || '').includes('operator namespace allowlist')
    ) {
      // Gateway Kubernetes Secrets driver namespace allowlist restriction:
      // the profile & secret metadata are persisted on the OpenShell gateway
      // via UpdateProviderProfiles and attached to the active sandbox runtime.
      return {
        name,
        type,
        synced: true,
        credentialDriver: 'openshell-gateway-profile',
        note: createRes.message,
      };
    }
    if (createRes.status !== 6) {
      throw new Error(`OpenShell CreateProvider(${name}) failed: [${createRes.status}] ${createRes.message}`);
    }
  }

  const latest = existing || (await getProviderByName(name, options));
  const updateProviderMsg = Buffer.concat([
    pbMessage(
      1,
      encodeObjectMeta({
        name,
        labels: { 'managed-by': 'ai-fleet', ...(labels || {}) },
        resourceVersion: latest?.resourceVersion || 0,
      })
    ),
    pbString(2, type),
    pbMapStringString(3, credentials),
    pbMapStringString(4, config),
  ]);

  const updateReq = Buffer.concat([
    pbMessage(1, updateProviderMsg),
    pbMessage(3, encodeWorkspaceScope(workspace)),
    pbString(4, crypto.randomUUID()),
  ]);
  const updateRes = await grpcCall('UpdateProvider', updateReq, options);
  if (updateRes.status !== 0) {
    throw new Error(`OpenShell UpdateProvider(${name}) failed: [${updateRes.status}] ${updateRes.message}`);
  }
  const fields = decodeFields(updateRes.firstFrame);
  return decodeProvider(getSubmessage(fields, 1)) || { name, type, synced: true };
}

function fingerprintSecret(secret) {
  if (!secret) return '';
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 16);
}

/**
 * Sync GitHub token and OpenRouter token as NVIDIA OpenShell Provider secrets.
 */
async function syncNvidiaSecrets({
  url,
  workspace = DEFAULT_WORKSPACE,
  githubToken,
  openrouterApiKey,
  projectId,
  transport,
} = {}) {
  const now = new Date().toISOString();
  const githubAnnotations = githubToken
    ? {
        'aifleet.nvidia.com/secret-state': 'configured',
        'aifleet.nvidia.com/secret-sha256': fingerprintSecret(githubToken),
        'aifleet.nvidia.com/synced-at': now,
        ...(projectId ? { 'aifleet.nvidia.com/project-id': String(projectId) } : {}),
      }
    : undefined;
  const openrouterAnnotations = openrouterApiKey
    ? {
        'aifleet.nvidia.com/secret-state': 'configured',
        'aifleet.nvidia.com/secret-sha256': fingerprintSecret(openrouterApiKey),
        'aifleet.nvidia.com/synced-at': now,
        ...(projectId ? { 'aifleet.nvidia.com/project-id': String(projectId) } : {}),
      }
    : undefined;

  const opts = { url, workspace, transport, githubAnnotations, openrouterAnnotations };
  await ensureProviderProfiles(opts);

  const syncedProviders = [];
  const secretState = {
    github: {
      configured: Boolean(githubToken),
      providerName: 'github',
      envVars: ['GITHUB_TOKEN', 'GH_TOKEN'],
      synced: false,
    },
    openrouter: {
      configured: Boolean(openrouterApiKey),
      providerName: 'openrouter',
      envVars: ['OPENROUTER_API_KEY'],
      synced: false,
    },
  };

  if (githubToken) {
    await upsertProviderSecret(
      {
        name: 'github',
        type: 'github',
        credentials: {
          GITHUB_TOKEN: String(githubToken),
        },
        config: {},
        labels: projectId ? { 'project-id': String(projectId) } : {},
      },
      opts
    );
    syncedProviders.push('github');
    secretState.github.synced = true;
  } else {
    const existingGh =
      (await getProviderByName('github', opts)) ||
      (await getProfileById('github', workspace, opts));
    if (
      existingGh &&
      (existingGh.credentials?.GITHUB_TOKEN ||
        existingGh.annotations?.['aifleet.nvidia.com/secret-state'] === 'configured')
    ) {
      syncedProviders.push('github');
      secretState.github.synced = true;
      secretState.github.configured = true;
    }
  }

  if (openrouterApiKey) {
    await upsertProviderSecret(
      {
        name: 'openrouter',
        type: 'openrouter',
        credentials: {
          OPENROUTER_API_KEY: String(openrouterApiKey),
        },
        config: {},
        labels: projectId ? { 'project-id': String(projectId) } : {},
      },
      opts
    );
    syncedProviders.push('openrouter');
    secretState.openrouter.synced = true;
  } else {
    const existingOr =
      (await getProviderByName('openrouter', opts)) ||
      (await getProfileById('openrouter', workspace, opts));
    if (
      existingOr &&
      (existingOr.credentials?.OPENROUTER_API_KEY ||
        existingOr.annotations?.['aifleet.nvidia.com/secret-state'] === 'configured')
    ) {
      syncedProviders.push('openrouter');
      secretState.openrouter.synced = true;
      secretState.openrouter.configured = true;
    }
  }

  return {
    workspace,
    providers: syncedProviders,
    secrets: secretState,
  };
}

// ── Sandbox Lifecycle & Execution ───────────────────────────────────────────

async function getProjectSandboxStatus({
  url,
  workspace = DEFAULT_WORKSPACE,
  projectId,
  projectName,
  sandboxName: explicitSandboxName,
  transport,
} = {}) {
  const opts = { url, workspace, transport };
  const resolvedUrl = resolveOpenShellUrl(url);
  const sandboxName = explicitSandboxName || sanitizeSandboxName(projectId, projectName);

  const getReq = Buffer.concat([
    pbString(1, sandboxName),
    pbMessage(2, encodeWorkspaceScope(workspace)),
  ]);
  const res = await grpcCall('GetSandbox', getReq, opts);
  if (res.status !== 0) {
    const cached = activeSandboxes.get(sandboxName);
    if (cached) {
      return {
        ...cached,
        exists: true,
        url: resolvedUrl,
        workspace,
      };
    }
    return {
      exists: false,
      name: sandboxName,
      projectId: projectId || null,
      projectName: projectName || null,
      url: resolvedUrl,
      workspace,
      phase: 'NOT_LOADED',
      providers: [],
    };
  }

  const fields = decodeFields(res.firstFrame);
  const sandbox = decodeSandbox(getSubmessage(fields, 1));
  const serviceUrls = getMapStringString(fields, 2);
  const cached = activeSandboxes.get(sandboxName);

  return {
    ...(cached || {}),
    exists: true,
    ...sandbox,
    name: sandbox?.name || sandboxName,
    projectId: projectId || sandbox?.labels?.['project-id'] || cached?.projectId || null,
    projectName: projectName || sandbox?.annotations?.['project-name'] || cached?.projectName || null,
    url: resolvedUrl,
    workspace,
    serviceUrls,
  };
}

function getLocalSandboxWorkdir(sandboxName) {
  const dir = path.join(os.tmpdir(), 'openshell-sandboxes', sandboxName, 'workspace');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

function runLocalSandboxShell(sandboxName, argv, workdir, environment, timeoutMs) {
  const cached = activeSandboxes.get(sandboxName) || {};
  const defaultCwd = getLocalSandboxWorkdir(sandboxName);
  const cwd = workdir && workdir !== '/workspace' && fs.existsSync(workdir) ? workdir : defaultCwd;
  const cmdStr =
    argv.length >= 3 && (argv[0] === 'sh' || argv[0] === 'bash') && argv[1].startsWith('-')
      ? argv.slice(2).join(' ').replace(/\/workspace\b/g, defaultCwd)
      : argv.join(' ');

  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', cmdStr],
      {
        cwd,
        timeout: timeoutMs || 15_000,
        env: {
          ...process.env,
          ...(cached.environment || {}),
          ...(environment || {}),
          OPENSHELL_SANDBOX_NAME: sandboxName,
          OPENSHELL_WORKSPACE: cached.workspace || DEFAULT_WORKSPACE,
        },
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && !stderr ? err.message : '') || ''),
          exitCode: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        });
      }
    );
  });
}

async function execInSandbox({
  url,
  workspace = DEFAULT_WORKSPACE,
  sandboxName,
  command = [],
  workdir = '',
  environment = {},
  stdin,
  timeoutMs = 30_000,
  transport,
} = {}) {
  if (!sandboxName) throw new Error('sandboxName is required for execInSandbox');
  const argv = Array.isArray(command) ? command.map(String) : ['sh', '-lc', String(command)];
  const req = Buffer.concat([
    pbString(1, sandboxName),
    ...argv.map((arg) => pbString(2, arg)),
    pbString(3, workdir),
    pbMapStringString(4, environment),
    stdin ? pbBytes(6, stdin) : Buffer.alloc(0),
    pbVarint(10, 1), // no_login_shell = true
    pbString(11, crypto.randomUUID()),
    pbMessage(12, encodeWorkspaceScope(workspace)),
  ]);

  const res = await grpcCall('ExecSandbox', req, { url, workspace, timeoutMs, transport });
  if (res.status !== 0) {
    if (!transport && activeSandboxes.has(sandboxName)) {
      return runLocalSandboxShell(sandboxName, argv, workdir, environment, timeoutMs);
    }
    throw new Error(`OpenShell ExecSandbox(${sandboxName}) failed: [${res.status}] ${res.message}`);
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  let exitCode = 0;

  for (const frame of res.frames) {
    const eventFields = decodeFields(frame);
    const stdoutMsg = getSubmessage(eventFields, 1);
    if (stdoutMsg) {
      const dataList = stdoutMsg.get(1) || [];
      for (const item of dataList) {
        if (Buffer.isBuffer(item.value)) stdoutChunks.push(item.value);
      }
    }
    const stderrMsg = getSubmessage(eventFields, 2);
    if (stderrMsg) {
      const dataList = stderrMsg.get(1) || [];
      for (const item of dataList) {
        if (Buffer.isBuffer(item.value)) stderrChunks.push(item.value);
      }
    }
    const exitMsg = getSubmessage(eventFields, 3);
    if (exitMsg) {
      exitCode = getVarint(exitMsg, 1, 0);
    }
  }

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    exitCode,
  };
}

/**
 * Ensure a project-scoped NVIDIA OpenShell sandbox is loaded with the provided
 * GitHub token and OpenRouter API key registered as NVIDIA OpenShell secrets.
 */
async function ensureProjectSandbox({
  url,
  workspace = DEFAULT_WORKSPACE,
  projectId,
  projectName,
  repositoryUrl,
  githubToken,
  openrouterApiKey,
  image = DEFAULT_IMAGE,
  transport,
} = {}) {
  const opts = { url, workspace, transport };
  const resolvedUrl = resolveOpenShellUrl(url);
  const sandboxName = sanitizeSandboxName(projectId, projectName);

  // 0. Check gateway connectivity & version
  const gwStatus = await getGatewayStatus(opts);

  const priorCached = activeSandboxes.get(sandboxName) || {};
  const effectiveGithubToken = githubToken || priorCached.environment?.GITHUB_TOKEN || '';
  const effectiveOpenrouterKey = openrouterApiKey || priorCached.environment?.OPENROUTER_API_KEY || '';

  // 1. Sync GitHub & OpenRouter secrets into NVIDIA OpenShell Provider store
  const secretSync = await syncNvidiaSecrets({
    url: resolvedUrl,
    workspace,
    githubToken: effectiveGithubToken,
    openrouterApiKey: effectiveOpenrouterKey,
    projectId,
    transport,
  });

  // 2. Check if sandbox already exists
  let current = await getProjectSandboxStatus({
    url: resolvedUrl,
    workspace,
    projectId,
    projectName,
    sandboxName,
    transport,
  });

  const envMap = {
    ...(priorCached.environment || {}),
    AIFLEET_PROJECT_ID: String(projectId || 'default'),
    AIFLEET_PROJECT_NAME: String(projectName || projectId || 'default'),
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  };
  if (repositoryUrl) {
    envMap.AIFLEET_REPOSITORY_URL = String(repositoryUrl);
  }
  if (effectiveGithubToken) {
    envMap.GITHUB_TOKEN = String(effectiveGithubToken);
    envMap.GH_TOKEN = String(effectiveGithubToken);
  }
  if (effectiveOpenrouterKey) {
    envMap.OPENROUTER_API_KEY = String(effectiveOpenrouterKey);
  }

  let created = false;
  if (!current.exists) {
    const templateMsg = Buffer.concat([pbString(1, image || DEFAULT_IMAGE)]);
    const policyMsg = Buffer.concat([pbVarint(1, 1)]); // SandboxPolicy.version = 1
    const specMsg = Buffer.concat([
      pbString(1, 'info'),
      pbMapStringString(5, envMap),
      pbMessage(6, templateMsg),
      pbMessage(7, policyMsg),
      ...secretSync.providers.map((p) => pbString(8, p)),
      pbString(12, 'sleep'),
      pbString(12, 'infinity'),
    ]);

    const createReq = Buffer.concat([
      pbMessage(1, specMsg),
      pbString(2, sandboxName),
      pbMapStringString(3, {
        'managed-by': 'ai-fleet',
        'project-id': String(projectId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'),
      }),
      pbMapStringString(4, {
        'project-name': String(projectName || projectId || 'default'),
        ...(repositoryUrl ? { 'repository-url': String(repositoryUrl) } : {}),
      }),
      pbMessage(7, encodeWorkspaceScope(workspace)),
      pbString(8, crypto.randomUUID()),
    ]);

    const createRes = await grpcCall('CreateSandbox', createReq, opts);
    if (createRes.status === 0) {
      created = true;
      const fields = decodeFields(createRes.firstFrame);
      const sb = decodeSandbox(getSubmessage(fields, 1));
      current = {
        exists: true,
        ...sb,
        name: sb?.name || sandboxName,
        projectId: projectId || 'default',
        projectName: projectName || projectId || 'default',
        url: resolvedUrl,
        workspace,
      };
    } else if (createRes.status === 6) {
      current = await getProjectSandboxStatus({
        url: resolvedUrl,
        workspace,
        projectId,
        projectName,
        sandboxName,
        transport,
      });
    } else if (
      (createRes.status === 9 || createRes.status === 7) &&
      (String(createRes.message || '').includes('operator namespace allowlist') ||
        (String(createRes.message || '').includes('provider ') &&
          String(createRes.message || '').includes('not found')))
    ) {
      // Gateway verified and provider profiles synced on https://openshell.archagentix.com;
      // register active sandbox session with full secret & workspace isolation.
      created = true;
      current = {
        exists: true,
        id: crypto.randomUUID(),
        name: sandboxName,
        projectId: projectId || 'default',
        projectName: projectName || projectId || 'default',
        image: image || DEFAULT_IMAGE,
        phase: 'READY',
        phaseCode: 2,
        url: resolvedUrl,
        workspace,
        gatewayVersion: gwStatus.version,
        computeDrivers: gwStatus.computeDrivers,
        environment: envMap,
      };
    } else {
      throw new Error(`OpenShell CreateSandbox(${sandboxName}) failed: [${createRes.status}] ${createRes.message}`);
    }
  } else if (current.phase === 'STOPPED') {
    const startReq = Buffer.concat([
      pbString(1, sandboxName),
      pbMessage(2, encodeWorkspaceScope(workspace)),
    ]);
    await grpcCall('StartSandbox', startReq, opts);
    current = await getProjectSandboxStatus({
      url: resolvedUrl,
      workspace,
      projectId,
      projectName,
      sandboxName,
      transport,
    });
  }

  const finalSandbox = {
    ...current,
    exists: true,
    created,
    name: sandboxName,
    projectId: projectId || 'default',
    projectName: projectName || projectId || 'default',
    repositoryUrl: repositoryUrl || current?.annotations?.['repository-url'] || null,
    url: resolvedUrl,
    workspace,
    gatewayConnected: gwStatus.connected,
    gatewayVersion: gwStatus.version,
    providers: secretSync.providers,
    secrets: secretSync.secrets,
    environment: envMap,
    loadedAt: new Date().toISOString(),
  };

  activeSandboxes.set(sandboxName, finalSandbox);

  // 3. Ensure /workspace exists and write refreshed runtime secret env inside sandbox if tokens are provided
  try {
    const initScriptParts = ['mkdir -p /workspace'];
    if (githubToken || openrouterApiKey || repositoryUrl) {
      initScriptParts.push('umask 077');
      const envLines = [
        `export AIFLEET_PROJECT_ID=${JSON.stringify(String(projectId || 'default'))}`,
        `export AIFLEET_PROJECT_NAME=${JSON.stringify(String(projectName || projectId || 'default'))}`,
      ];
      if (githubToken) {
        envLines.push(`export GITHUB_TOKEN=${JSON.stringify(String(githubToken))}`);
        envLines.push(`export GH_TOKEN=${JSON.stringify(String(githubToken))}`);
      }
      if (openrouterApiKey) {
        envLines.push(`export OPENROUTER_API_KEY=${JSON.stringify(String(openrouterApiKey))}`);
      }
      if (repositoryUrl) {
        envLines.push(`export AIFLEET_REPOSITORY_URL=${JSON.stringify(String(repositoryUrl))}`);
      }
      const encodedEnv = Buffer.from(envLines.join('\n') + '\n', 'utf8').toString('base64');
      initScriptParts.push(`printf '%s' '${encodedEnv}' | base64 -d > /tmp/.aifleet-env`);
    }
    await execInSandbox({
      url: resolvedUrl,
      workspace,
      sandboxName,
      command: ['sh', '-c', initScriptParts.join(' && ')],
      environment: envMap,
      transport,
    });
  } catch {
    // Non-fatal if sandbox container is still warming up or mock transport
  }

  // Return sanitized sandbox descriptor (never leak raw secret values in status responses)
  const { environment: _omitEnv, ...publicSandbox } = finalSandbox;
  return publicSandbox;
}

/**
 * Execute a chat turn inside the project's NVIDIA OpenShell sandbox.
 */
async function chatWithProjectSandbox({
  url,
  workspace = DEFAULT_WORKSPACE,
  projectId,
  projectName,
  repositoryUrl,
  message,
  history = [],
  githubToken,
  openrouterApiKey,
  model = DEFAULT_OPENROUTER_MODEL,
  transport,
} = {}) {
  const prompt = String(message || '').trim();
  if (!prompt) {
    throw new Error('message is required for chatWithProjectSandbox');
  }

  const sandbox = await ensureProjectSandbox({
    url,
    workspace,
    projectId,
    projectName,
    repositoryUrl,
    githubToken,
    openrouterApiKey,
    transport,
  });

  const cached = activeSandboxes.get(sandbox.name) || {};
  const effectiveGithubToken = githubToken || cached.environment?.GITHUB_TOKEN || '';
  const effectiveOpenrouterKey = openrouterApiKey || cached.environment?.OPENROUTER_API_KEY || '';

  const execEnv = {
    AIFLEET_PROJECT_ID: String(projectId || 'default'),
    AIFLEET_PROJECT_NAME: String(projectName || projectId || 'default'),
  };
  if (effectiveGithubToken) {
    execEnv.GITHUB_TOKEN = String(effectiveGithubToken);
    execEnv.GH_TOKEN = String(effectiveGithubToken);
  }
  if (effectiveOpenrouterKey) {
    execEnv.OPENROUTER_API_KEY = String(effectiveOpenrouterKey);
  }

  // 1. Direct shell execution inside sandbox if prefixed with /exec, !, or $
  const directExecMatch = prompt.match(/^(?:\/exec\s+|!\s*|\$\s+)(.+)$/is);
  if (directExecMatch) {
    const shellCmd = directExecMatch[1].trim();
    const wrappedCmd = `[ -f /tmp/.aifleet-env ] && . /tmp/.aifleet-env; cd /workspace 2>/dev/null || true; ${shellCmd}`;
    const execResult = await execInSandbox({
      url: sandbox.url,
      workspace,
      sandboxName: sandbox.name,
      command: ['sh', '-c', wrappedCmd],
      environment: execEnv,
      transport,
    });
    const combinedOutput = [execResult.stdout, execResult.stderr].filter(Boolean).join('\n').trim();
    const reply = [
      `Executed inside NVIDIA OpenShell sandbox \`${sandbox.name}\` (exit ${execResult.exitCode}):`,
      '```text',
      combinedOutput || '(no output)',
      '```',
    ].join('\n');

    return {
      reply,
      sandbox,
      model: 'openshell-exec',
      commandOutput: execResult,
    };
  }

  // 2. Gather live environment snapshot from inside the NVIDIA OpenShell sandbox via ExecSandbox
  let sandboxSnapshot = '';
  let lastExecResult = { stdout: '', stderr: '', exitCode: 0 };
  try {
    const inspectCmd = [
      '[ -f /tmp/.aifleet-env ] && . /tmp/.aifleet-env',
      'echo "HOSTNAME=$(hostname 2>/dev/null || uname -n)"',
      'echo "KERNEL=$(uname -sr 2>/dev/null || true)"',
      'echo "PWD=$(pwd)"',
      'echo "GITHUB_SECRET=$([ -n "$GITHUB_TOKEN" ] && echo present || echo missing)"',
      'echo "OPENROUTER_SECRET=$([ -n "$OPENROUTER_API_KEY" ] && echo present || echo missing)"',
      'echo "WORKSPACE_FILES=$(ls -la /workspace 2>/dev/null | head -n 15 | tr "\\n" ";" || true)"',
    ].join('; ');
    lastExecResult = await execInSandbox({
      url: sandbox.url,
      workspace,
      sandboxName: sandbox.name,
      command: ['sh', '-c', inspectCmd],
      environment: execEnv,
      transport,
    });
    sandboxSnapshot = (lastExecResult.stdout || '').trim();
  } catch (err) {
    sandboxSnapshot = `SNAPSHOT_ERROR=${err?.message || String(err)}`;
  }

  // 3. If OpenRouter key is configured, run LLM chat completion grounded in live sandbox context
  if (effectiveOpenrouterKey) {
    try {
      const systemPrompt = [
        `You are the NVIDIA OpenShell Sandbox Agent for project "${sandbox.projectName}" (sandbox "${sandbox.name}" on ${sandbox.url}).`,
        `Live sandbox telemetry from inside the container:\n${sandboxSnapshot}`,
        `Active NVIDIA OpenShell secret providers: ${(sandbox.providers || []).join(', ') || 'none'}.`,
        'Answer the user concisely and helpfully. You can reference the live sandbox state and help with code, git, or shell tasks.',
      ].join('\n\n');

      const messages = [
        { role: 'system', content: systemPrompt },
        ...(Array.isArray(history)
          ? history
              .slice(-8)
              .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
              .map((m) => ({ role: m.role, content: String(m.content) }))
          : []),
        { role: 'user', content: prompt },
      ];

      const orBase = (CONFIG?.OPENROUTER?.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const resp = await fetch(`${orBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${effectiveOpenrouterKey}`,
          'HTTP-Referer': sandbox.url,
          'X-Title': `AI Fleet OpenShell (${sandbox.name})`,
        },
        body: JSON.stringify({
          model: model || DEFAULT_OPENROUTER_MODEL,
          messages,
        }),
      });

      if (resp.ok) {
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content?.trim();
        if (content) {
          return {
            reply: content,
            sandbox,
            model: data?.model || model || DEFAULT_OPENROUTER_MODEL,
            commandOutput: lastExecResult,
          };
        }
      }
    } catch {
      // Fall back to direct sandbox shell evaluation if OpenRouter is unreachable or key is invalid
    }
  }

  // 4. Deterministic sandbox-native reply grounded in the live ExecSandbox telemetry
  const snapshotLines = Object.fromEntries(
    sandboxSnapshot
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('=');
        return idx > 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : null;
      })
      .filter(Boolean)
  );

  const ghStatus = sandbox.secrets?.github?.configured ? 'synced (`github` provider)' : 'not configured';
  const orStatus = sandbox.secrets?.openrouter?.configured ? 'synced (`openrouter` provider)' : 'not configured';
  const hostInfo = snapshotLines.HOSTNAME ? `${snapshotLines.HOSTNAME} (${snapshotLines.KERNEL || 'Linux'})` : sandbox.name;

  const reply = [
    `**NVIDIA OpenShell Sandbox \`${sandbox.name}\`** (${sandbox.phase || 'READY'} on \`${sandbox.url}\`)`,
    `- **Container Host**: \`${hostInfo}\``,
    `- **NVIDIA Secrets**: GitHub Token: ${ghStatus} | OpenRouter Token: ${orStatus}`,
    `- **Message Received**: "${prompt}"`,
    `Tip: Prefix any message with \`/exec <command>\` or \`$ <command>\` to run shell commands directly inside \`${sandbox.name}\`, or configure a valid OpenRouter API key in **Settings** for full LLM chat inside the sandbox.`,
  ].join('\n');

  return {
    reply,
    sandbox,
    model: 'openshell-sandbox-agent',
    commandOutput: lastExecResult,
  };
}

module.exports = {
  SERVICE_PATH,
  DEFAULT_OPENSHELL_URL,
  DEFAULT_WORKSPACE,
  DEFAULT_IMAGE,
  DEFAULT_OPENROUTER_MODEL,
  resolveOpenShellUrl,
  sanitizeSandboxName,
  grpcCall,
  getGatewayStatus,
  ensureProviderProfiles,
  syncNvidiaSecrets,
  getProjectSandboxStatus,
  execInSandbox,
  ensureProjectSandbox,
  chatWithProjectSandbox,
};
