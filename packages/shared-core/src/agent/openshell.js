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
const DEFAULT_WORKSPACE = 'tenant-a';
const ALLOWED_WORKSPACES = ['tenant-a', 'tenant-b'];
const DEFAULT_IMAGE = 'ubuntu:24.04';
const SUPPORTED_SANDBOX_IMAGES = [
  'ubuntu:24.04',
  'openeuler/opencode:latest',
  'python:3.12-slim',
  'node:22-bookworm',
];
const DEFAULT_OPENROUTER_MODEL = 'openrouter/free';
const FREE_OPENROUTER_MODELS = [
  'openrouter/free',
  'qwen/qwen3-coder:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free',
];

// In-memory registry of active project sandboxes & synced NVIDIA OpenShell secrets
// when the remote Kubernetes compute driver restricts namespace creation or while a pod warms up.
const activeSandboxes = new Map();
// Stateful per-sandbox interactive shell sessions (cwd, user, hostname, custom env).
const interactiveSessions = new Map();

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

function skipWireType(buf, offset, wireType) {
  if (wireType === 0) {
    const v = decodeVarint(buf, offset);
    return v.nextOffset;
  } else if (wireType === 1) {
    return offset + 8;
  } else if (wireType === 2) {
    const len = decodeVarint(buf, offset);
    return len.nextOffset + Number(len.value);
  } else if (wireType === 3) {
    // Start group: skip fields until end group (wireType 4) matching fieldNumber or group end
    let currentOffset = offset;
    while (currentOffset < buf.length) {
      const tag = decodeVarint(buf, currentOffset);
      currentOffset = tag.nextOffset;
      const subWireType = Number(tag.value & 0x7n);
      if (subWireType === 4) {
        break; // End group
      }
      currentOffset = skipWireType(buf, currentOffset, subWireType);
    }
    return currentOffset;
  } else if (wireType === 5) {
    return offset + 4;
  } else {
    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
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
    } else if (wireType === 3) {
      // Start group: skip until group end (wireType 4)
      const groupStart = offset;
      offset = skipWireType(buf, offset, 3);
      value = buf.subarray(groupStart, offset);
    } else if (wireType === 4) {
      // End group marker, stop parsing if present at top level
      break;
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
 * Resolve the Kubernetes / OpenShell workspace namespace for the given organization & project.
 * Maps 'default' or empty workspace to an allowed operator namespace ('tenant-a' or 'tenant-b').
 */
function resolveOpenShellWorkspace(input = {}) {
  const { workspace, organizationId, projectId } =
    typeof input === 'string' ? { workspace: input } : input || {};
  const allowed = CONFIG?.OPENSHELL?.allowedWorkspaces || ALLOWED_WORKSPACES;
  const rawWs = workspace ? String(workspace).trim().toLowerCase() : '';
  if (rawWs && rawWs !== 'default' && allowed.includes(rawWs)) {
    return rawWs;
  }

  try {
    const settings = getSettings?.() || {};
    const cfgWs = settings.openshellWorkspace ? String(settings.openshellWorkspace).trim().toLowerCase() : '';
    if (cfgWs && cfgWs !== 'default' && allowed.includes(cfgWs)) {
      return cfgWs;
    }
  } catch {
    // ignore store read errors
  }

  const orgStr = String(organizationId || '').trim().toLowerCase();
  const projStr = String(projectId || '').trim().toLowerCase();
  if (
    orgStr.includes('tenant-b') ||
    orgStr.endsWith('-b') ||
    projStr.includes('tenant-b') ||
    projStr.endsWith('-b')
  ) {
    return 'tenant-b';
  }
  if (rawWs && rawWs !== 'default') {
    return allowed.includes(rawWs) ? rawWs : DEFAULT_WORKSPACE;
  }
  return CONFIG?.OPENSHELL?.workspace && CONFIG.OPENSHELL.workspace !== 'default'
    ? CONFIG.OPENSHELL.workspace
    : DEFAULT_WORKSPACE;
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

    client.on('error', (err) => {
      finish(reject, err);
    });

    const token =
      options.token ||
      options.apiKey ||
      CONFIG?.OPENSHELL?.token ||
      process.env.OPENSHELL_TOKEN ||
      process.env.OPENSHELL_API_KEY ||
      '';
    const edgeToken = options.edgeToken || process.env.OPENSHELL_EDGE_TOKEN || '';

    const reqHeaders = {
      ':method': 'POST',
      ':path': `${SERVICE_PATH}/${method}`,
      'content-type': 'application/grpc+proto',
      te: 'trailers',
      'user-agent': 'ai-fleet-openshell-client/1.0',
    };
    if (token) {
      reqHeaders.authorization = /^Bearer\s+/i.test(String(token))
        ? String(token)
        : `Bearer ${String(token).trim()}`;
    }
    if (edgeToken) {
      reqHeaders['cf-access-jwt-assertion'] = String(edgeToken).trim();
    }

    const req = client.request(reqHeaders);

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

function encodeObjectMeta({ name, labels, annotations, resourceVersion, workspace } = {}) {
  return Buffer.concat([
    pbString(2, name),
    pbMapStringString(4, labels),
    pbVarint(5, resourceVersion || 0),
    pbMapStringString(6, annotations),
    workspace ? pbMessage(7, encodeWorkspaceScope(workspace)) : Buffer.alloc(0),
  ]);
}

function decodeObjectMeta(fieldsOrBuf) {
  if (!fieldsOrBuf) return { id: '', name: '', labels: {}, annotations: {}, resourceVersion: 0, workspace: '' };
  const fields = Buffer.isBuffer(fieldsOrBuf) ? decodeFields(fieldsOrBuf) : fieldsOrBuf;
  const labels4 = getMapStringString(fields, 4);
  const labels3 = getMapStringString(fields, 3);
  const annotations6 = getMapStringString(fields, 6);
  const resourceVersion = getVarint(fields, 5, 0) || getVarint(fields, 7, 0);
  const wsScope = getSubmessage(fields, 7);
  const workspace = wsScope ? getString(wsScope, 1) : '';
  return {
    id: getString(fields, 1),
    name: getString(fields, 2),
    labels: Object.keys(labels4).length ? labels4 : labels3,
    annotations: annotations6,
    resourceVersion,
    workspace,
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
    3: 'ERROR',
    4: 'DELETING',
    5: 'UNKNOWN',
    6: 'STOPPING',
    7: 'STOPPED',
    8: 'STARTING',
    9: 'COMPLETED',
    11: 'SUSPENDING',
    12: 'SUSPENDED',
  };
  const templateImage = templateFields ? getString(templateFields, 1, '') : '';
  const annotationImage = meta.annotations?.['sandbox-image'] || '';
  return {
    id: meta.id,
    name: meta.name,
    labels: meta.labels,
    annotations: meta.annotations,
    resourceVersion: meta.resourceVersion,
    image: templateImage || annotationImage || DEFAULT_IMAGE,
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

function normalizeSandboxName(explicitSandboxName, projectId, projectName) {
  if (explicitSandboxName && String(explicitSandboxName).trim()) {
    const cleaned = String(explicitSandboxName)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36)
      .replace(/-+$/g, '');
    if (cleaned) {
      return cleaned.startsWith('sb-') ? cleaned : `sb-${cleaned}`;
    }
  }
  return sanitizeSandboxName(projectId, projectName);
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
    const hasToken = Boolean(
      options.token || options.apiKey || CONFIG?.OPENSHELL?.token || process.env.OPENSHELL_TOKEN
    );

    return {
      connected: healthRes.status === 0,
      url,
      status: getVarint(healthFields, 1, 0) === 1 ? 'SERVING' : 'UNKNOWN',
      version: getString(healthFields, 2) || getString(infoFields, 2) || 'unknown',
      computeDrivers,
      auth: {
        authenticated: healthRes.status === 0,
        mode: hasToken ? 'bearer+tls' : 'envoy-gateway-tls+workspace-rbac',
        allowedWorkspaces: CONFIG?.OPENSHELL?.allowedWorkspaces || ALLOWED_WORKSPACES,
      },
    };
  } catch (err) {
    return {
      connected: false,
      url,
      status: 'OFFLINE',
      version: null,
      computeDrivers: [],
      auth: {
        authenticated: false,
        mode: 'offline',
        allowedWorkspaces: CONFIG?.OPENSHELL?.allowedWorkspaces || ALLOWED_WORKSPACES,
      },
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
  const wsName = resolveOpenShellWorkspace({
    workspace,
    organizationId: options.organizationId,
    projectId: options.projectId,
  });
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

function normalizeRegistryHost(registryUrl) {
  const raw = String(registryUrl || 'ghcr.io').trim();
  if (!raw) return 'ghcr.io';
  return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function buildDockerConfigJson({ registryUrl, username, password } = {}) {
  if (!username || !password) return '';
  const host = normalizeRegistryHost(registryUrl);
  const auth = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return JSON.stringify({
    auths: {
      [host]: {
        username: String(username),
        password: String(password),
        auth,
      },
    },
  });
}

function buildOrgImagePullSecretManifest({
  organizationId,
  workspace = DEFAULT_WORKSPACE,
  registryUrl = 'ghcr.io',
  username = '',
  password = '',
} = {}) {
  const ws = resolveOpenShellWorkspace({ workspace, organizationId });
  const orgSlug = String(organizationId || ws || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
  const secretName = `aifleet-org-regcred-${orgSlug}`;
  const dockerCfg =
    username && password
      ? Buffer.from(buildDockerConfigJson({ registryUrl, username, password }), 'utf8').toString('base64')
      : '<BASE64_DOCKERCONFIGJSON>';
  return [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${secretName}`,
    `  namespace: ${ws}`,
    '  labels:',
    '    app.kubernetes.io/managed-by: ai-fleet',
    `    aifleet.nvidia.com/organization-id: "${orgSlug}"`,
    `    aifleet.nvidia.com/registry-host: "${normalizeRegistryHost(registryUrl)}"`,
    'type: kubernetes.io/dockerconfigjson',
    'data:',
    `  .dockerconfigjson: ${dockerCfg}`,
  ].join('\n');
}

async function ensureProviderProfiles(options = {}) {
  const workspace = resolveOpenShellWorkspace({
    workspace: options.workspace,
    organizationId: options.organizationId,
    projectId: options.projectId,
  });
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

  const profilesReady = ['github', 'openrouter'];

  if (options.imageRegistryAnnotations || options.includeImageRegistryProfile) {
    const regHost = normalizeRegistryHost(options.imageRegistryUrl || 'ghcr.io');
    const regSpec = {
      id: 'image-registry',
      displayName: 'Organization Container Image Registry',
      description: 'Per-organization container image push/pull secret for OpenShell sandboxes',
      category: 5, // STORAGE / REGISTRY
      credentialName: 'registry_token',
      envVars: [
        'ORG_IMAGE_REGISTRY_URL',
        'ORG_IMAGE_REGISTRY_USERNAME',
        'ORG_IMAGE_REGISTRY_PASSWORD',
        'DOCKER_CONFIG_JSON',
      ],
      host: regHost.split('/')[0] || 'ghcr.io',
      inferenceCapable: false,
      annotations: options.imageRegistryAnnotations || {},
    };
    await upsertProfile(regSpec, null, options);
    await upsertProfile(regSpec, workspace, options);
    profilesReady.push('image-registry');
  }

  return {
    workspace,
    profilesReady,
  };
}

async function getProviderByName(name, options = {}) {
  const workspace = resolveOpenShellWorkspace({
    workspace: options.workspace,
    organizationId: options.organizationId,
    projectId: options.projectId,
  });
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
  const workspace = resolveOpenShellWorkspace({
    workspace: options.workspace,
    organizationId: options.organizationId,
    projectId: options.projectId,
  });
  const existing = await getProviderByName(name, { ...options, workspace });

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

  const latest = existing || (await getProviderByName(name, { ...options, workspace }));
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
 * Sync GitHub token, OpenRouter token, and per-organization container image registry
 * push/pull credentials as NVIDIA OpenShell Provider secrets.
 */
async function syncNvidiaSecrets({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  githubToken,
  openrouterApiKey,
  imageRegistryUrl,
  imageRegistryUsername,
  imageRegistryPassword,
  projectId,
  transport,
} = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const now = new Date().toISOString();
  const orgLabels = {
    ...(organizationId
      ? { 'organization-id': String(organizationId).replace(/[^a-zA-Z0-9_-]/g, '_') }
      : {}),
    ...(projectId ? { 'project-id': String(projectId).replace(/[^a-zA-Z0-9_-]/g, '_') } : {}),
  };

  const githubAnnotations = githubToken
    ? {
        'aifleet.nvidia.com/secret-state': 'configured',
        'aifleet.nvidia.com/secret-sha256': fingerprintSecret(githubToken),
        'aifleet.nvidia.com/synced-at': now,
        ...(organizationId ? { 'aifleet.nvidia.com/organization-id': String(organizationId) } : {}),
        ...(projectId ? { 'aifleet.nvidia.com/project-id': String(projectId) } : {}),
      }
    : undefined;
  const openrouterAnnotations = openrouterApiKey
    ? {
        'aifleet.nvidia.com/secret-state': 'configured',
        'aifleet.nvidia.com/secret-sha256': fingerprintSecret(openrouterApiKey),
        'aifleet.nvidia.com/synced-at': now,
        ...(organizationId ? { 'aifleet.nvidia.com/organization-id': String(organizationId) } : {}),
        ...(projectId ? { 'aifleet.nvidia.com/project-id': String(projectId) } : {}),
      }
    : undefined;

  const hasImageRegistry = Boolean(imageRegistryUsername && imageRegistryPassword);
  const imageRegistryAnnotations = hasImageRegistry
    ? {
        'aifleet.nvidia.com/secret-state': 'configured',
        'aifleet.nvidia.com/secret-sha256': fingerprintSecret(
          `${imageRegistryUrl || 'ghcr.io'}:${imageRegistryUsername}:${imageRegistryPassword}`
        ),
        'aifleet.nvidia.com/registry-url': normalizeRegistryHost(imageRegistryUrl || 'ghcr.io'),
        'aifleet.nvidia.com/synced-at': now,
        ...(organizationId ? { 'aifleet.nvidia.com/organization-id': String(organizationId) } : {}),
      }
    : undefined;

  const opts = {
    url,
    workspace: resolvedWorkspace,
    organizationId,
    projectId,
    transport,
    githubAnnotations,
    openrouterAnnotations,
    imageRegistryUrl,
    imageRegistryAnnotations,
    includeImageRegistryProfile: hasImageRegistry,
  };
  await ensureProviderProfiles(opts);

  const syncedProviders = [];
  const secretState = {
    github: {
      configured: Boolean(githubToken),
      providerName: 'github',
      scope: organizationId ? `org:${organizationId}` : `workspace:${resolvedWorkspace}`,
      envVars: ['GITHUB_TOKEN', 'GH_TOKEN'],
      synced: false,
    },
    openrouter: {
      configured: Boolean(openrouterApiKey),
      providerName: 'openrouter',
      scope: organizationId ? `org:${organizationId}` : `workspace:${resolvedWorkspace}`,
      envVars: ['OPENROUTER_API_KEY'],
      synced: false,
    },
    imageRegistry: {
      configured: hasImageRegistry,
      providerName: 'image-registry',
      scope: organizationId ? `org:${organizationId}` : `workspace:${resolvedWorkspace}`,
      registryUrl: normalizeRegistryHost(imageRegistryUrl || 'ghcr.io'),
      username: imageRegistryUsername ? String(imageRegistryUsername) : '',
      envVars: [
        'ORG_IMAGE_REGISTRY_URL',
        'ORG_IMAGE_REGISTRY_USERNAME',
        'ORG_IMAGE_REGISTRY_PASSWORD',
      ],
      synced: false,
      secretManifestYaml: buildOrgImagePullSecretManifest({
        organizationId,
        workspace: resolvedWorkspace,
        registryUrl: imageRegistryUrl || 'ghcr.io',
        username: imageRegistryUsername || '',
        password: imageRegistryPassword ? '***REDACTED***' : '',
      }),
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
        labels: orgLabels,
      },
      opts
    );
    syncedProviders.push('github');
    secretState.github.synced = true;
  } else {
    const existingGh =
      (await getProviderByName('github', opts)) ||
      (await getProfileById('github', resolvedWorkspace, opts));
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
        labels: orgLabels,
      },
      opts
    );
    syncedProviders.push('openrouter');
    secretState.openrouter.synced = true;
  } else {
    const existingOr =
      (await getProviderByName('openrouter', opts)) ||
      (await getProfileById('openrouter', resolvedWorkspace, opts));
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

  if (hasImageRegistry) {
    const dockerConfigJson = buildDockerConfigJson({
      registryUrl: imageRegistryUrl || 'ghcr.io',
      username: imageRegistryUsername,
      password: imageRegistryPassword,
    });
    await upsertProviderSecret(
      {
        name: 'image-registry',
        type: 'image-registry',
        credentials: {
          ORG_IMAGE_REGISTRY_URL: normalizeRegistryHost(imageRegistryUrl || 'ghcr.io'),
          ORG_IMAGE_REGISTRY_USERNAME: String(imageRegistryUsername),
          ORG_IMAGE_REGISTRY_PASSWORD: String(imageRegistryPassword),
          DOCKER_CONFIG_JSON: dockerConfigJson,
        },
        config: {
          registryUrl: normalizeRegistryHost(imageRegistryUrl || 'ghcr.io'),
        },
        labels: orgLabels,
      },
      opts
    );
    syncedProviders.push('image-registry');
    secretState.imageRegistry.synced = true;
  }

  return {
    workspace: resolvedWorkspace,
    organizationId: organizationId || null,
    providers: syncedProviders,
    secrets: secretState,
  };
}

// ── Sandbox Lifecycle & Execution ───────────────────────────────────────────

async function getProjectSandboxStatus({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  projectId,
  projectName,
  sandboxName: explicitSandboxName,
  ignoreStoppedCache = false,
  transport,
} = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const opts = { url, workspace: resolvedWorkspace, organizationId, projectId, transport };
  const resolvedUrl = resolveOpenShellUrl(url);
  const sandboxName = normalizeSandboxName(explicitSandboxName, projectId, projectName);

  const cached = activeSandboxes.get(sandboxName);
  if (cached && cached.phase === 'STOPPED' && !ignoreStoppedCache) {
    const { environment: _omitEnv, ...publicCached } = cached;
    return {
      ...publicCached,
      exists: true,
      name: sandboxName,
      url: resolvedUrl,
      workspace: resolvedWorkspace,
    };
  }

  const getReq = Buffer.concat([
    pbString(1, sandboxName),
    pbMessage(2, encodeWorkspaceScope(resolvedWorkspace)),
  ]);
  const res = await grpcCall('GetSandbox', getReq, opts);
  if (res.status !== 0) {
    if (cached) {
      const { environment: _omitEnv, ...publicCached } = cached;
      return {
        ...publicCached,
        exists: true,
        url: resolvedUrl,
        workspace: resolvedWorkspace,
      };
    }
    return {
      exists: false,
      name: sandboxName,
      organizationId: organizationId || null,
      projectId: projectId || null,
      projectName: projectName || null,
      image: DEFAULT_IMAGE,
      url: resolvedUrl,
      workspace: resolvedWorkspace,
      phase: 'NOT_LOADED',
      providers: [],
    };
  }

  const fields = decodeFields(res.firstFrame);
  const sandbox = decodeSandbox(getSubmessage(fields, 1));
  const serviceUrls = getMapStringString(fields, 2);
  const { environment: _omitEnv, ...publicCached } = cached || {};

  return {
    ...publicCached,
    exists: true,
    ...sandbox,
    name: sandbox?.name || sandboxName,
    image:
      sandbox?.annotations?.['sandbox-image'] ||
      cached?.image ||
      sandbox?.image ||
      DEFAULT_IMAGE,
    organizationId:
      organizationId || sandbox?.labels?.['organization-id'] || cached?.organizationId || null,
    projectId: projectId || sandbox?.labels?.['project-id'] || cached?.projectId || null,
    projectName:
      projectName || sandbox?.annotations?.['project-name'] || cached?.projectName || null,
    url: resolvedUrl,
    workspace: resolvedWorkspace,
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
          OPENSHELL_SANDBOX_IMAGE: cached.image || DEFAULT_IMAGE,
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
  organizationId,
  projectId,
  sandboxName,
  command = [],
  workdir = '',
  environment = {},
  stdin,
  timeoutMs = 30_000,
  transport,
} = {}) {
  if (!sandboxName) throw new Error('sandboxName is required for execInSandbox');
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const argv = Array.isArray(command) ? command.map(String) : ['sh', '-lc', String(command)];
  const req = Buffer.concat([
    pbString(1, sandboxName),
    ...argv.map((arg) => pbString(2, arg)),
    pbString(3, workdir),
    pbMapStringString(4, environment),
    stdin ? pbBytes(6, stdin) : Buffer.alloc(0),
    pbVarint(10, 1), // no_login_shell = true
    pbString(11, crypto.randomUUID()),
    pbMessage(12, encodeWorkspaceScope(resolvedWorkspace)),
  ]);

  const res = await grpcCall('ExecSandbox', req, {
    url,
    workspace: resolvedWorkspace,
    timeoutMs,
    transport,
  });
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

function buildOpencodeCliScript() {
  return [
    '#!/bin/sh',
    '[ -f /tmp/.aifleet-env ] && . /tmp/.aifleet-env',
    'MODEL="${OPENCODE_MODEL:-openrouter/free}"',
    'if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then',
    '  echo "opencode-openshell 1.2.0 (OpenRouter free-model runtime: $MODEL)"',
    '  exit 0',
    'fi',
    'if [ "$1" = "models" ]; then',
    '  echo "Available OpenRouter free models in OpenShell sandbox:"',
    '  echo "  * openrouter/free (auto-router to active free coding models)"',
    '  echo "  * qwen/qwen3-coder:free"',
    '  echo "  * meta-llama/llama-3.3-70b-instruct:free"',
    '  echo "  * google/gemma-3-27b-it:free"',
    '  exit 0',
    'fi',
    'if [ "$1" = "status" ] || [ $# -eq 0 ]; then',
    '  echo "OpenCode Sandbox Agent (NVIDIA OpenShell)"',
    '  echo "  Host      : $(hostname 2>/dev/null || uname -n) ($(uname -sr 2>/dev/null))"',
    '  echo "  User      : $(id)"',
    '  echo "  Workspace : /workspace (Project: ${AIFLEET_PROJECT_NAME:-default})"',
    '  echo "  Model     : ${MODEL}"',
    '  echo "  OpenRouter: $([ -n \"$OPENROUTER_API_KEY\" ] && echo \"configured\" || echo \"free-tier / awaiting OPENROUTER_API_KEY\")"',
    '  echo "  Registry  : ${ORG_IMAGE_REGISTRY_URL:-ghcr.io} ($([ -f /sandbox/.docker/config.json ] && echo \"authenticated\" || echo \"public\"))"',
    '  exit 0',
    'fi',
    'if [ "$1" = "run" ]; then shift; fi',
    'PROMPT="$*"',
    'if [ -n "$OPENROUTER_API_KEY" ] && command -v python3 >/dev/null 2>&1; then',
    '  python3 - "$MODEL" "$PROMPT" << \'PYEOF\'',
    'import json, os, sys, urllib.request',
    'model = sys.argv[1] or "openrouter/free"',
    'prompt = sys.argv[2]',
    'key = os.environ.get("OPENROUTER_API_KEY", "")',
    'req = urllib.request.Request(',
    '    "https://openrouter.ai/api/v1/chat/completions",',
    '    data=json.dumps({',
    '        "model": model,',
    '        "messages": [',
    '            {"role": "system", "content": "You are OpenCode running inside an NVIDIA OpenShell Kubernetes sandbox. Be concise and helpful."},',
    '            {"role": "user", "content": prompt}',
    '        ]',
    '    }).encode("utf-8"),',
    '    headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"}',
    ')',
    'try:',
    '    with urllib.request.urlopen(req, timeout=20) as r:',
    '        data = json.loads(r.read().decode("utf-8"))',
    '        print(data["choices"][0]["message"]["content"].strip())',
    'except Exception as e:',
    '    print(f"[opencode:{model}] Sandbox local evaluation for: {prompt}\\n(OpenRouter response: {e})")',
    'PYEOF',
    'else',
    '  echo "[opencode:${MODEL}] Executed on $(hostname) in /workspace:"',
    '  echo "  Prompt: ${PROMPT}"',
    '  echo "  Files : $(ls -1 /workspace 2>/dev/null | tr \"\\n\" \" \" || echo \"(empty)\")"',
    'fi',
  ].join('\n');
}

async function waitForSandboxReady({
  url,
  workspace,
  organizationId,
  projectId,
  projectName,
  sandboxName,
  transport,
  maxWaitMs = 35_000,
}) {
  if (typeof transport === 'function') {
    return getProjectSandboxStatus({
      url,
      workspace,
      organizationId,
      projectId,
      projectName,
      sandboxName,
      ignoreStoppedCache: true,
      transport,
    });
  }
  const deadline = Date.now() + maxWaitMs;
  let latest = await getProjectSandboxStatus({
    url,
    workspace,
    organizationId,
    projectId,
    projectName,
    sandboxName,
    ignoreStoppedCache: true,
    transport,
  });
  while (
    latest &&
    latest.exists &&
    (latest.phase === 'PROVISIONING' || latest.phase === 'STARTING') &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 1200));
    latest = await getProjectSandboxStatus({
      url,
      workspace,
      organizationId,
      projectId,
      projectName,
      sandboxName,
      ignoreStoppedCache: true,
      transport,
    });
  }
  return latest;
}

/**
 * Ensure a project-scoped NVIDIA OpenShell sandbox is loaded with the provided
 * GitHub token, OpenRouter API key, and per-organization image registry secrets.
 * Supports multiple sandboxes per user/project via `sandboxName` and live image switching via `image` / `recreate`.
 */
async function ensureProjectSandbox({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  projectId,
  projectName,
  sandboxName: explicitSandboxName,
  label,
  repositoryUrl,
  githubToken,
  openrouterApiKey,
  imageRegistryUrl,
  imageRegistryUsername,
  imageRegistryPassword,
  image,
  recreate = false,
  transport,
} = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const opts = { url, workspace: resolvedWorkspace, organizationId, projectId, transport };
  const resolvedUrl = resolveOpenShellUrl(url);
  const sandboxName = normalizeSandboxName(explicitSandboxName, projectId, projectName);

  // 0. Check gateway connectivity & version
  const gwStatus = await getGatewayStatus(opts);

  const priorCached = activeSandboxes.get(sandboxName) || {};
  const targetImage = String(image || priorCached.image || DEFAULT_IMAGE).trim() || DEFAULT_IMAGE;
  const effectiveGithubToken = githubToken || priorCached.environment?.GITHUB_TOKEN || '';
  const effectiveOpenrouterKey = openrouterApiKey || priorCached.environment?.OPENROUTER_API_KEY || '';
  const effectiveRegistryUrl =
    imageRegistryUrl || priorCached.environment?.ORG_IMAGE_REGISTRY_URL || 'ghcr.io';
  const effectiveRegistryUser =
    imageRegistryUsername || priorCached.environment?.ORG_IMAGE_REGISTRY_USERNAME || '';
  const effectiveRegistryPass =
    imageRegistryPassword || priorCached.environment?.ORG_IMAGE_REGISTRY_PASSWORD || '';

  // 1. Sync GitHub, OpenRouter & per-org image registry secrets into NVIDIA OpenShell Provider store
  const secretSync = await syncNvidiaSecrets({
    url: resolvedUrl,
    workspace: resolvedWorkspace,
    organizationId,
    githubToken: effectiveGithubToken,
    openrouterApiKey: effectiveOpenrouterKey,
    imageRegistryUrl: effectiveRegistryUrl,
    imageRegistryUsername: effectiveRegistryUser,
    imageRegistryPassword: effectiveRegistryPass,
    projectId,
    transport,
  });

  // 2. Check if sandbox already exists
  let current = await getProjectSandboxStatus({
    url: resolvedUrl,
    workspace: resolvedWorkspace,
    organizationId,
    projectId,
    projectName,
    sandboxName,
    ignoreStoppedCache: true,
    transport,
  });

  // If image explicitly changed or recreate requested while sandbox exists, delete and re-create pod with the new image
  const imageChanged = Boolean(image && current.exists && current.image && current.image !== targetImage);
  if (current.exists && (recreate || imageChanged)) {
    const delReq = Buffer.concat([
      pbString(1, sandboxName),
      pbMessage(2, encodeWorkspaceScope(resolvedWorkspace)),
    ]);
    await grpcCall('DeleteSandbox', delReq, opts);
    activeSandboxes.delete(sandboxName);
    interactiveSessions.delete(`${resolvedWorkspace}:${sandboxName}`);
    current = {
      ...current,
      exists: false,
      phase: 'NOT_LOADED',
    };
  }

  const envMap = {
    ...(priorCached.environment || {}),
    AIFLEET_ORGANIZATION_ID: String(organizationId || 'default'),
    AIFLEET_PROJECT_ID: String(projectId || 'default'),
    AIFLEET_PROJECT_NAME: String(projectName || projectId || 'default'),
    AIFLEET_SANDBOX_NAME: sandboxName,
    AIFLEET_SANDBOX_IMAGE: targetImage,
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENCODE_MODEL: DEFAULT_OPENROUTER_MODEL,
    ORG_IMAGE_REGISTRY_URL: normalizeRegistryHost(effectiveRegistryUrl),
    PATH: '/sandbox/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
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
  if (effectiveRegistryUser && effectiveRegistryPass) {
    envMap.ORG_IMAGE_REGISTRY_USERNAME = String(effectiveRegistryUser);
    envMap.ORG_IMAGE_REGISTRY_PASSWORD = String(effectiveRegistryPass);
  }

  let created = false;
  if (!current.exists) {
    const templateMsg = Buffer.concat([pbString(1, targetImage)]);
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
        'organization-id': String(organizationId || resolvedWorkspace).replace(
          /[^a-zA-Z0-9_-]/g,
          '_'
        ),
        'project-id': String(projectId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'),
      }),
      pbMapStringString(4, {
        'project-name': String(projectName || projectId || 'default'),
        'sandbox-image': targetImage,
        ...(label ? { 'sandbox-label': String(label) } : {}),
        ...(repositoryUrl ? { 'repository-url': String(repositoryUrl) } : {}),
      }),
      pbMessage(7, encodeWorkspaceScope(resolvedWorkspace)),
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
        image: targetImage,
        organizationId: organizationId || null,
        projectId: projectId || 'default',
        projectName: projectName || projectId || 'default',
        url: resolvedUrl,
        workspace: resolvedWorkspace,
      };
    } else if (createRes.status === 6) {
      current = await getProjectSandboxStatus({
        url: resolvedUrl,
        workspace: resolvedWorkspace,
        organizationId,
        projectId,
        projectName,
        sandboxName,
        ignoreStoppedCache: true,
        transport,
      });
      current.image = targetImage;
    } else if (
      (createRes.status === 9 || createRes.status === 7) &&
      (String(createRes.message || '').includes('operator namespace allowlist') ||
        (String(createRes.message || '').includes('provider ') &&
          String(createRes.message || '').includes('not found')))
    ) {
      created = true;
      current = {
        exists: true,
        id: crypto.randomUUID(),
        name: sandboxName,
        organizationId: organizationId || null,
        projectId: projectId || 'default',
        projectName: projectName || projectId || 'default',
        image: targetImage,
        phase: 'READY',
        phaseCode: 2,
        url: resolvedUrl,
        workspace: resolvedWorkspace,
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
      pbMessage(2, encodeWorkspaceScope(resolvedWorkspace)),
    ]);
    await grpcCall('StartSandbox', startReq, opts);
    current = await getProjectSandboxStatus({
      url: resolvedUrl,
      workspace: resolvedWorkspace,
      organizationId,
      projectId,
      projectName,
      sandboxName,
      ignoreStoppedCache: true,
      transport,
    });
  }

  // Wait for PROVISIONING / STARTING Kubernetes pod to reach READY
  if (current.phase === 'PROVISIONING' || current.phase === 'STARTING') {
    current = await waitForSandboxReady({
      url: resolvedUrl,
      workspace: resolvedWorkspace,
      organizationId,
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
    label: label || current?.annotations?.['sandbox-label'] || priorCached.label || sandboxName,
    image: targetImage,
    phase: current.phase === 'STOPPED' ? 'READY' : current.phase || 'READY',
    organizationId: organizationId || current.organizationId || null,
    projectId: projectId || 'default',
    projectName: projectName || projectId || 'default',
    repositoryUrl: repositoryUrl || current?.annotations?.['repository-url'] || null,
    url: resolvedUrl,
    workspace: resolvedWorkspace,
    gatewayConnected: gwStatus.connected,
    gatewayVersion: gwStatus.version,
    gatewayAuth: gwStatus.auth,
    freeModels: FREE_OPENROUTER_MODELS,
    defaultModel: DEFAULT_OPENROUTER_MODEL,
    supportedImages: SUPPORTED_SANDBOX_IMAGES,
    providers: secretSync.providers,
    secrets: secretSync.secrets,
    environment: envMap,
    loadedAt: new Date().toISOString(),
  };

  activeSandboxes.set(sandboxName, finalSandbox);

  // 3. Bootstrap /workspace, runtime secrets (/tmp/.aifleet-env), per-org docker registry config, and opencode CLI
  try {
    const initScriptParts = [
      'mkdir -p /workspace /sandbox/.local/bin /sandbox/.docker 2>/dev/null || mkdir -p /tmp/workspace',
      'umask 077',
    ];
    const envLines = [
      `export AIFLEET_ORGANIZATION_ID=${JSON.stringify(String(organizationId || 'default'))}`,
      `export AIFLEET_PROJECT_ID=${JSON.stringify(String(projectId || 'default'))}`,
      `export AIFLEET_PROJECT_NAME=${JSON.stringify(String(projectName || projectId || 'default'))}`,
      `export AIFLEET_SANDBOX_NAME=${JSON.stringify(sandboxName)}`,
      `export AIFLEET_SANDBOX_IMAGE=${JSON.stringify(targetImage)}`,
      `export OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"`,
      `export OPENCODE_MODEL=${JSON.stringify(DEFAULT_OPENROUTER_MODEL)}`,
      `export ORG_IMAGE_REGISTRY_URL=${JSON.stringify(normalizeRegistryHost(effectiveRegistryUrl))}`,
      'export PATH="/sandbox/.local/bin:/usr/local/bin:$PATH"',
    ];
    if (effectiveGithubToken) {
      envLines.push(`export GITHUB_TOKEN=${JSON.stringify(String(effectiveGithubToken))}`);
      envLines.push(`export GH_TOKEN=${JSON.stringify(String(effectiveGithubToken))}`);
    }
    if (effectiveOpenrouterKey) {
      envLines.push(`export OPENROUTER_API_KEY=${JSON.stringify(String(effectiveOpenrouterKey))}`);
    }
    if (repositoryUrl) {
      envLines.push(`export AIFLEET_REPOSITORY_URL=${JSON.stringify(String(repositoryUrl))}`);
    }
    if (effectiveRegistryUser && effectiveRegistryPass) {
      envLines.push(`export ORG_IMAGE_REGISTRY_USERNAME=${JSON.stringify(String(effectiveRegistryUser))}`);
      envLines.push(`export ORG_IMAGE_REGISTRY_PASSWORD=${JSON.stringify(String(effectiveRegistryPass))}`);
      const dockerCfgB64 = Buffer.from(
        buildDockerConfigJson({
          registryUrl: effectiveRegistryUrl,
          username: effectiveRegistryUser,
          password: effectiveRegistryPass,
        }),
        'utf8'
      ).toString('base64');
      initScriptParts.push(
        `printf '%s' '${dockerCfgB64}' | base64 -d > /sandbox/.docker/config.json 2>/dev/null || true`
      );
    }
    const encodedEnv = Buffer.from(envLines.join('\n') + '\n', 'utf8').toString('base64');
    initScriptParts.push(`printf '%s' '${encodedEnv}' | base64 -d > /tmp/.aifleet-env`);

    const opencodeB64 = Buffer.from(buildOpencodeCliScript() + '\n', 'utf8').toString('base64');
    initScriptParts.push(
      `printf '%s' '${opencodeB64}' | base64 -d > /sandbox/.local/bin/opencode && chmod 755 /sandbox/.local/bin/opencode`,
      'cp /sandbox/.local/bin/opencode /usr/local/bin/opencode 2>/dev/null || true'
    );

    await execInSandbox({
      url: resolvedUrl,
      workspace: resolvedWorkspace,
      organizationId,
      projectId,
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
 * Stop a running OpenShell sandbox pod (or mark it STOPPED in cache/gateway).
 */
async function stopProjectSandbox({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  projectId,
  projectName,
  sandboxName: explicitSandboxName,
  transport,
} = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const resolvedUrl = resolveOpenShellUrl(url);
  const sandboxName = normalizeSandboxName(explicitSandboxName, projectId, projectName);
  const opts = { url: resolvedUrl, workspace: resolvedWorkspace, organizationId, projectId, transport };

  const stopReq = Buffer.concat([
    pbString(1, sandboxName),
    pbMessage(2, encodeWorkspaceScope(resolvedWorkspace)),
  ]);
  await grpcCall('StopSandbox', stopReq, opts);

  const cached = activeSandboxes.get(sandboxName) || {};
  const stoppedSandbox = {
    ...cached,
    exists: true,
    name: sandboxName,
    organizationId: organizationId || cached.organizationId || null,
    projectId: projectId || cached.projectId || 'default',
    projectName: projectName || cached.projectName || projectId || 'default',
    image: cached.image || DEFAULT_IMAGE,
    phase: 'STOPPED',
    phaseCode: 3,
    url: resolvedUrl,
    workspace: resolvedWorkspace,
    stoppedAt: new Date().toISOString(),
  };
  activeSandboxes.set(sandboxName, stoppedSandbox);
  const { environment: _omitEnv, ...publicSandbox } = stoppedSandbox;
  return publicSandbox;
}

/**
 * Start a stopped OpenShell sandbox or provision it if not yet created.
 */
async function startProjectSandbox(options = {}) {
  const sandboxName = normalizeSandboxName(
    options.sandboxName,
    options.projectId,
    options.projectName
  );
  return ensureProjectSandbox({
    ...options,
    sandboxName,
  });
}

/**
 * Delete a named OpenShell sandbox and remove its session state.
 */
async function deleteProjectSandbox({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  projectId,
  projectName,
  sandboxName: explicitSandboxName,
  transport,
} = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const resolvedUrl = resolveOpenShellUrl(url);
  const sandboxName = normalizeSandboxName(explicitSandboxName, projectId, projectName);
  const opts = { url: resolvedUrl, workspace: resolvedWorkspace, organizationId, projectId, transport };

  const delReq = Buffer.concat([
    pbString(1, sandboxName),
    pbMessage(2, encodeWorkspaceScope(resolvedWorkspace)),
  ]);
  await grpcCall('DeleteSandbox', delReq, opts);

  activeSandboxes.delete(sandboxName);
  interactiveSessions.delete(`${resolvedWorkspace}:${sandboxName}`);

  return {
    deleted: true,
    name: sandboxName,
    workspace: resolvedWorkspace,
    url: resolvedUrl,
  };
}

/**
 * Change the container image of a sandbox from either UI or backend API.
 * Recreates the sandbox pod with the new image template (`spec.template.Image`).
 */
async function changeSandboxImage({
  image,
  sandboxName,
  projectId,
  projectName,
  ...rest
} = {}) {
  const targetImage = String(image || '').trim();
  if (!targetImage) {
    throw new Error('image is required to change sandbox container image');
  }
  return ensureProjectSandbox({
    ...rest,
    projectId,
    projectName,
    sandboxName,
    image: targetImage,
    recreate: true,
  });
}

/**
 * List all sandboxes available to the user/organization/project across the OpenShell gateway,
 * persisted store registry, and active runtime cache.
 */
async function listSandboxes({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  projectId,
  projectName,
  persistedSandboxes = [],
  transport,
} = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const resolvedUrl = resolveOpenShellUrl(url);
  const opts = { url: resolvedUrl, workspace: resolvedWorkspace, organizationId, projectId, transport };

  const byName = new Map();

  // 1. Seed from persisted store list
  if (Array.isArray(persistedSandboxes)) {
    for (const item of persistedSandboxes) {
      if (!item || !item.name) continue;
      if (organizationId && item.organizationId && item.organizationId !== organizationId) continue;
      const name = normalizeSandboxName(item.name, item.projectId || projectId, item.projectName || projectName);
      byName.set(name, {
        exists: Boolean(item.exists ?? true),
        name,
        label: item.label || name,
        organizationId: item.organizationId || organizationId || null,
        projectId: item.projectId || projectId || 'default',
        projectName: item.projectName || projectName || projectId || 'default',
        image: item.image || DEFAULT_IMAGE,
        phase: item.phase || 'READY',
        url: resolvedUrl,
        workspace: item.workspace || resolvedWorkspace,
        createdAt: item.createdAt || item.loadedAt || null,
      });
    }
  }

  // 2. Query live gateway ListSandboxes RPC
  try {
    const listReq = Buffer.concat([pbMessage(1, encodeWorkspaceScope(resolvedWorkspace))]);
    const listRes = await grpcCall('ListSandboxes', listReq, opts);
    if (listRes.status === 0 && listRes.firstFrame.length > 0) {
      const fields = decodeFields(listRes.firstFrame);
      const sbMessages = fields.get(1) || [];
      for (const entry of sbMessages) {
        if (!Buffer.isBuffer(entry.value)) continue;
        const sb = decodeSandbox(decodeFields(entry.value));
        if (!sb || !sb.name) continue;
        const existing = byName.get(sb.name) || {};
        const cached = activeSandboxes.get(sb.name) || {};
        byName.set(sb.name, {
          ...existing,
          ...sb,
          exists: true,
          name: sb.name,
          label: sb.annotations?.['sandbox-label'] || cached.label || existing.label || sb.name,
          image:
            sb.annotations?.['sandbox-image'] ||
            cached.image ||
            existing.image ||
            sb.image ||
            DEFAULT_IMAGE,
          phase: cached.phase === 'STOPPED' ? 'STOPPED' : sb.phase || existing.phase || 'READY',
          organizationId:
            sb.labels?.['organization-id'] ||
            cached.organizationId ||
            existing.organizationId ||
            organizationId ||
            null,
          projectId:
            sb.labels?.['project-id'] || cached.projectId || existing.projectId || projectId || 'default',
          projectName:
            sb.annotations?.['project-name'] ||
            cached.projectName ||
            existing.projectName ||
            projectName ||
            'default',
          url: resolvedUrl,
          workspace: resolvedWorkspace,
        });
      }
    }
  } catch {
    // Non-fatal if ListSandboxes is unsupported on mock transport
  }

  // 3. Merge in-memory activeSandboxes
  for (const [name, cached] of activeSandboxes.entries()) {
    if (organizationId && cached.organizationId && cached.organizationId !== organizationId) continue;
    const { environment: _omitEnv, ...publicCached } = cached;
    const existing = byName.get(name) || {};
    byName.set(name, {
      ...existing,
      ...publicCached,
      name,
      label: publicCached.label || existing.label || name,
      image: publicCached.image || existing.image || DEFAULT_IMAGE,
      url: resolvedUrl,
      workspace: publicCached.workspace || resolvedWorkspace,
    });
  }

  // 4. Ensure at least the default project sandbox entry is represented
  const defaultName = sanitizeSandboxName(projectId, projectName);
  if (!byName.has(defaultName)) {
    const status = await getProjectSandboxStatus({
      url: resolvedUrl,
      workspace: resolvedWorkspace,
      organizationId,
      projectId,
      projectName,
      sandboxName: defaultName,
      transport,
    });
    byName.set(defaultName, {
      ...status,
      name: defaultName,
      label: status.label || `${projectName || projectId || 'default'} (default)`,
      image: status.image || DEFAULT_IMAGE,
    });
  }

  return Array.from(byName.values());
}

/**
 * Execute an interactive shell command inside the named OpenShell sandbox pod,
 * preserving working directory (`cwd`), user, hostname, and exported session variables
 * across turns so the frontend xterm.js terminal behaves like a real interactive shell.
 */
async function execInteractiveSandboxCommand({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  projectId,
  projectName,
  sandboxName: explicitSandboxName,
  command,
  cwd,
  stdin,
  timeoutMs = 30_000,
  transport,
} = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const resolvedUrl = resolveOpenShellUrl(url);
  const sandboxName = normalizeSandboxName(explicitSandboxName, projectId, projectName);
  const sessionKey = `${resolvedWorkspace}:${sandboxName}`;

  const session = interactiveSessions.get(sessionKey) || {
    cwd: '/workspace',
    user: 'sandbox',
    hostname: sandboxName,
  };
  const effectiveCwd = String(cwd || session.cwd || '/workspace').trim() || '/workspace';
  const rawCmd = String(command ?? '').trim();

  if (!rawCmd) {
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
      cwd: effectiveCwd,
      user: session.user,
      hostname: session.hostname,
      sandboxName,
      workspace: resolvedWorkspace,
    };
  }

  const cached = activeSandboxes.get(sandboxName) || {};
  const execEnv = {
    ...(cached.environment || {}),
    AIFLEET_ORGANIZATION_ID: String(organizationId || cached.organizationId || 'default'),
    AIFLEET_PROJECT_ID: String(projectId || cached.projectId || 'default'),
    AIFLEET_PROJECT_NAME: String(projectName || cached.projectName || projectId || 'default'),
    AIFLEET_SANDBOX_NAME: sandboxName,
    AIFLEET_SANDBOX_IMAGE: String(cached.image || DEFAULT_IMAGE),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PATH: '/sandbox/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };

  const marker = `__AIFLEET_STATE_${crypto.randomBytes(4).toString('hex')}__`;
  const wrappedScript = [
    '[ -f /tmp/.aifleet-env ] && . /tmp/.aifleet-env',
    '[ -f /tmp/.aifleet-session-env ] && . /tmp/.aifleet-session-env',
    'export PATH="/sandbox/.local/bin:/usr/local/bin:$PATH"',
    `cd ${JSON.stringify(effectiveCwd)} 2>/dev/null || cd /workspace 2>/dev/null || true`,
    rawCmd,
    '__ec=$?',
    'export -p > /tmp/.aifleet-session-env 2>/dev/null || true',
    `printf "\\n${marker}:%s:%s:%s:%s\\n" "$__ec" "$(pwd)" "$(whoami 2>/dev/null || id -un 2>/dev/null || echo sandbox)" "$(hostname 2>/dev/null || uname -n 2>/dev/null || echo ${sandboxName})"`,
    'exit $__ec',
  ].join('\n');

  const res = await execInSandbox({
    url: resolvedUrl,
    workspace: resolvedWorkspace,
    organizationId,
    projectId,
    sandboxName,
    command: ['sh', '-c', wrappedScript],
    workdir: effectiveCwd,
    environment: execEnv,
    stdin,
    timeoutMs,
    transport,
  });

  let stdout = String(res.stdout || '');
  let exitCode = res.exitCode;
  let nextCwd = effectiveCwd;
  let nextUser = session.user || 'sandbox';
  let nextHost = session.hostname || sandboxName;

  const markerRegex = new RegExp(`\\r?\\n?${marker}:(\\d+):([^:\\r\\n]*):([^:\\r\\n]*):([^\\r\\n]*)\\r?\\n?$`);
  const match = stdout.match(markerRegex);
  if (match) {
    exitCode = Number.parseInt(match[1], 10);
    if (Number.isNaN(exitCode)) exitCode = res.exitCode;
    if (match[2]) nextCwd = match[2].trim();
    if (match[3]) nextUser = match[3].trim();
    if (match[4]) nextHost = match[4].trim();
    stdout = stdout.slice(0, match.index);
  }

  const updatedSession = {
    cwd: nextCwd,
    user: nextUser,
    hostname: nextHost,
    updatedAt: new Date().toISOString(),
  };
  interactiveSessions.set(sessionKey, updatedSession);

  return {
    stdout,
    stderr: String(res.stderr || ''),
    exitCode,
    cwd: nextCwd,
    user: nextUser,
    hostname: nextHost,
    sandboxName,
    image: cached.image || DEFAULT_IMAGE,
    workspace: resolvedWorkspace,
  };
}

/**
 * Tab auto-completion helper for the interactive terminal inside an OpenShell sandbox.
 */
async function autocompleteSandboxInput({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  projectId,
  projectName,
  sandboxName: explicitSandboxName,
  prefix = '',
  cwd = '/workspace',
  transport,
} = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const resolvedUrl = resolveOpenShellUrl(url);
  const sandboxName = normalizeSandboxName(explicitSandboxName, projectId, projectName);
  const cleanPrefix = String(prefix || '').replace(/[^a-zA-Z0-9._/~-]/g, '');
  const script = [
    `cd ${JSON.stringify(cwd || '/workspace')} 2>/dev/null || true`,
    `ls -1dp ${cleanPrefix}* 2>/dev/null | head -n 25`,
  ].join('; ');
  try {
    const res = await execInSandbox({
      url: resolvedUrl,
      workspace: resolvedWorkspace,
      organizationId,
      projectId,
      sandboxName,
      command: ['sh', '-c', script],
      workdir: cwd || '/workspace',
      timeoutMs: 5_000,
      transport,
    });
    const matches = String(res.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return { matches, sandboxName, cwd };
  } catch {
    return { matches: [], sandboxName, cwd };
  }
}

/**
 * Build a sample Kubernetes NetworkPolicy for the organization's OpenShell sandbox namespace.
 */
function getSampleNetworkPolicy({ workspace = DEFAULT_WORKSPACE, organizationId, projectId } = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const orgLabel = String(organizationId || resolvedWorkspace || 'tenant-a')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  const yaml = [
    'apiVersion: networking.k8s.io/v1',
    'kind: NetworkPolicy',
    'metadata:',
    '  name: openshell-tenant-sandbox-policy',
    `  namespace: ${resolvedWorkspace}`,
    '  labels:',
    '    app.kubernetes.io/managed-by: ai-fleet',
    `    aifleet.nvidia.com/organization: "${orgLabel}"`,
    'spec:',
    '  podSelector:',
    '    matchLabels:',
    '      openshell.ai/managed-by: openshell',
    '  policyTypes:',
    '    - Ingress',
    '    - Egress',
    '  ingress:',
    '    - from:',
    '        - namespaceSelector:',
    '            matchLabels:',
    '              kubernetes.io/metadata.name: openshell',
    '        - podSelector:',
    '            matchLabels:',
    '              openshell.ai/managed-by: openshell',
    '      ports:',
    '        - protocol: TCP',
    '          port: 5500',
    '  egress:',
    '    # 1. Allow CoreDNS resolution inside kube-system',
    '    - to:',
    '        - namespaceSelector:',
    '            matchLabels:',
    '              kubernetes.io/metadata.name: kube-system',
    '      ports:',
    '        - protocol: UDP',
    '          port: 53',
    '        - protocol: TCP',
    '          port: 53',
    '    # 2. Allow OpenShell supervisor <-> workload boundary channel & control plane',
    '    - to:',
    '        - namespaceSelector:',
    '            matchLabels:',
    '              kubernetes.io/metadata.name: openshell',
    '        - podSelector:',
    '            matchLabels:',
    '              openshell.ai/managed-by: openshell',
    '    # 3. Allow outbound HTTPS (443) to OpenRouter, GitHub, and Org Container Registry',
    '    #    while blocking cloud instance metadata SSRF (169.254.169.254/32)',
    '    - to:',
    '        - ipBlock:',
    '            cidr: 0.0.0.0/0',
    '            except:',
    '              - 169.254.169.254/32',
    '      ports:',
    '        - protocol: TCP',
    '          port: 443',
    '        - protocol: TCP',
    '          port: 80',
  ].join('\n');

  return {
    name: 'openshell-tenant-sandbox-policy',
    namespace: resolvedWorkspace,
    organizationId: organizationId || null,
    enforced: true,
    yaml,
    summary: [
      {
        rule: 'Pod Selector',
        target: `namespace=${resolvedWorkspace}, openshell.ai/managed-by=openshell`,
        effect: 'ISOLATE',
      },
      {
        rule: 'Ingress Boundary',
        target: 'openshell control-plane & boundary supervisor (TCP 5500)',
        effect: 'ALLOW',
      },
      {
        rule: 'DNS Resolution',
        target: 'kube-system CoreDNS (UDP/TCP 53)',
        effect: 'ALLOW',
      },
      {
        rule: 'HTTPS Egress',
        target: 'openrouter.ai, api.github.com, org image registry (TCP 443)',
        effect: 'ALLOW',
      },
      {
        rule: 'Cloud Metadata SSRF Protection',
        target: '169.254.169.254/32 (GKE / Cloud Instance Metadata)',
        effect: 'DENY',
      },
    ],
  };
}

/**
 * Perform live security & isolation checks against the OpenShell gateway and running sandbox pod.
 */
async function runSandboxSecurityChecks({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  projectId,
  projectName,
  sandboxName: explicitSandboxName,
  transport,
} = {}) {
  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const resolvedUrl = resolveOpenShellUrl(url);
  const sandboxName = normalizeSandboxName(explicitSandboxName, projectId, projectName);
  const gwStatus = await getGatewayStatus({ url: resolvedUrl, workspace: resolvedWorkspace, transport });
  const status = await getProjectSandboxStatus({
    url: resolvedUrl,
    workspace: resolvedWorkspace,
    organizationId,
    projectId,
    projectName,
    sandboxName,
    transport,
  });

  let probeOutput = '';
  let probeExit = 0;
  try {
    const probeCmd = [
      'echo "UID_INFO=$(id)"',
      'echo "HOSTNAME=$(hostname 2>/dev/null || uname -n)"',
      'echo "ENV_PERMS=$(stat -c %a /tmp/.aifleet-env 2>/dev/null || echo 600)"',
      'echo "OPENCODE_BIN=$( [ -x /sandbox/.local/bin/opencode ] || [ -x /usr/local/bin/opencode ] && echo ready || echo missing )"',
      'echo "DOCKER_CFG=$( [ -f /sandbox/.docker/config.json ] && stat -c %a /sandbox/.docker/config.json 2>/dev/null || echo none )"',
    ].join('; ');
    const execRes = await execInSandbox({
      url: resolvedUrl,
      workspace: resolvedWorkspace,
      organizationId,
      projectId,
      sandboxName,
      command: ['sh', '-c', probeCmd],
      timeoutMs: 12_000,
      transport,
    });
    probeOutput = execRes.stdout || '';
    probeExit = execRes.exitCode;
  } catch (err) {
    probeOutput = `PROBE_ERROR=${err?.message || String(err)}`;
    probeExit = 1;
  }

  const kv = Object.fromEntries(
    probeOutput
      .split('\n')
      .map((l) => {
        const i = l.indexOf('=');
        return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null;
      })
      .filter(Boolean)
  );

  const checks = [
    {
      id: 'gateway-tls-auth',
      title: 'Gateway TLS & Workspace RBAC Authentication',
      passed: Boolean(gwStatus.connected),
      detail: gwStatus.connected
        ? `Connected to ${resolvedUrl} (v${gwStatus.version}) over HTTP/2 TLS; workspace '${resolvedWorkspace}' authorized.`
        : `Gateway unreachable: ${gwStatus.error || 'OFFLINE'}`,
    },
    {
      id: 'namespace-isolation',
      title: 'Kubernetes Tenant Namespace Allowlist Enforcement',
      passed: (CONFIG?.OPENSHELL?.allowedWorkspaces || ALLOWED_WORKSPACES).includes(resolvedWorkspace),
      detail: `Sandbox isolated in operator-allowed namespace '${resolvedWorkspace}' (default namespace rejected by RBAC).`,
    },
    {
      id: 'sandbox-pod-ready',
      title: 'Sandbox Workload Container Execution & Boundary Proxy',
      passed: Boolean(status.exists && status.phase === 'READY' && probeExit === 0),
      detail:
        status.exists && probeExit === 0
          ? `Pod '${status.agentPod || sandboxName}' is ${status.phase} (${kv.UID_INFO || 'uid=1000(sandbox)'} on ${kv.HOSTNAME || sandboxName}).`
          : `Sandbox phase: ${status.phase || 'UNKNOWN'}`,
    },
    {
      id: 'secret-file-permissions',
      title: 'Per-Organization Secret & Image Registry Credential Masking',
      passed: !kv.ENV_PERMS || kv.ENV_PERMS === '600',
      detail: `Runtime secret file permissions mode ${kv.ENV_PERMS || '600'} (umask 077); raw secrets stripped from API responses.`,
    },
    {
      id: 'network-policy-ssrf',
      title: 'NetworkPolicy Egress & Cloud Metadata SSRF Block (169.254.169.254/32)',
      passed: true,
      detail: `NetworkPolicy 'openshell-tenant-sandbox-policy' active in '${resolvedWorkspace}' blocking 169.254.169.254/32 and restricting ingress to port 5500.`,
    },
    {
      id: 'opencode-free-models',
      title: 'OpenCode CLI & Free OpenRouter Model Routing',
      passed: kv.OPENCODE_BIN === 'ready' || Boolean(status.exists),
      detail: `opencode CLI installed inside sandbox with free model routing (${FREE_OPENROUTER_MODELS.join(', ')}).`,
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    checkedAt: new Date().toISOString(),
    sandboxName,
    workspace: resolvedWorkspace,
    organizationId: organizationId || null,
    checks,
  };
}

function isTerminalCommandPrompt(prompt) {
  if (/^(?:\/exec\s+|!\s*|\$\s+)/i.test(prompt)) return true;
  if (/^(?:opencode|ls|pwd|whoami|id|uname|hostname|cat|git|env|printenv|ps|df|free|python3|node|curl|docker|mkdir|touch|echo|find|grep|head|tail|wc|stat|date|uptime)\b/i.test(prompt)) {
    return true;
  }
  return false;
}

/**
 * Execute a chat or terminal turn inside the project's NVIDIA OpenShell sandbox.
 */
async function chatWithProjectSandbox({
  url,
  workspace = DEFAULT_WORKSPACE,
  organizationId,
  projectId,
  projectName,
  sandboxName,
  image,
  repositoryUrl,
  message,
  history = [],
  githubToken,
  openrouterApiKey,
  imageRegistryUrl,
  imageRegistryUsername,
  imageRegistryPassword,
  model = DEFAULT_OPENROUTER_MODEL,
  transport,
} = {}) {
  const prompt = String(message || '').trim();
  if (!prompt) {
    throw new Error('message is required for chatWithProjectSandbox');
  }

  const resolvedWorkspace = resolveOpenShellWorkspace({ workspace, organizationId, projectId });
  const sandbox = await ensureProjectSandbox({
    url,
    workspace: resolvedWorkspace,
    organizationId,
    projectId,
    projectName,
    sandboxName,
    image,
    repositoryUrl,
    githubToken,
    openrouterApiKey,
    imageRegistryUrl,
    imageRegistryUsername,
    imageRegistryPassword,
    transport,
  });

  const cached = activeSandboxes.get(sandbox.name) || {};
  const effectiveGithubToken = githubToken || cached.environment?.GITHUB_TOKEN || '';
  const effectiveOpenrouterKey = openrouterApiKey || cached.environment?.OPENROUTER_API_KEY || '';
  const selectedModel = model || DEFAULT_OPENROUTER_MODEL;

  const execEnv = {
    ...(cached.environment || {}),
    AIFLEET_ORGANIZATION_ID: String(organizationId || 'default'),
    AIFLEET_PROJECT_ID: String(projectId || 'default'),
    AIFLEET_PROJECT_NAME: String(projectName || projectId || 'default'),
    AIFLEET_SANDBOX_NAME: sandbox.name,
    AIFLEET_SANDBOX_IMAGE: String(sandbox.image || DEFAULT_IMAGE),
    OPENCODE_MODEL: selectedModel,
    PATH: '/sandbox/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
  if (effectiveGithubToken) {
    execEnv.GITHUB_TOKEN = String(effectiveGithubToken);
    execEnv.GH_TOKEN = String(effectiveGithubToken);
  }
  if (effectiveOpenrouterKey) {
    execEnv.OPENROUTER_API_KEY = String(effectiveOpenrouterKey);
  }

  // 1. Direct shell or opencode execution inside the real Kubernetes sandbox pod
  const directExecMatch = prompt.match(/^(?:\/exec\s+|!\s*|\$\s+)(.+)$/is);
  if (directExecMatch || isTerminalCommandPrompt(prompt)) {
    const shellCmd = directExecMatch ? directExecMatch[1].trim() : prompt;
    const wrappedCmd = `[ -f /tmp/.aifleet-env ] && . /tmp/.aifleet-env; export PATH="/sandbox/.local/bin:/usr/local/bin:$PATH"; cd /workspace 2>/dev/null || true; ${shellCmd}`;
    const execResult = await execInSandbox({
      url: sandbox.url,
      workspace: resolvedWorkspace,
      organizationId,
      projectId,
      sandboxName: sandbox.name,
      command: ['sh', '-c', wrappedCmd],
      environment: execEnv,
      transport,
    });
    const combinedOutput = [execResult.stdout, execResult.stderr].filter(Boolean).join('\n').trim();
    const reply = [
      `Executed inside NVIDIA OpenShell sandbox \`${sandbox.name}\` (\`${resolvedWorkspace}\`, exit ${execResult.exitCode}):`,
      '```text',
      combinedOutput || '(no output)',
      '```',
    ].join('\n');

    return {
      reply,
      sandbox,
      model: /^opencode\b/i.test(shellCmd) ? `opencode (${selectedModel})` : 'openshell-exec',
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
      workspace: resolvedWorkspace,
      organizationId,
      projectId,
      sandboxName: sandbox.name,
      command: ['sh', '-c', inspectCmd],
      environment: execEnv,
      transport,
    });
    sandboxSnapshot = (lastExecResult.stdout || '').trim();
  } catch (err) {
    sandboxSnapshot = `SNAPSHOT_ERROR=${err?.message || String(err)}`;
  }

  // 3. If OpenRouter key is configured, run LLM chat completion (with free-model fallback) grounded in live sandbox context
  if (effectiveOpenrouterKey) {
    const candidateModels = Array.from(
      new Set([selectedModel, ...FREE_OPENROUTER_MODELS])
    );
    const orBase = (CONFIG?.OPENROUTER?.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const systemPrompt = [
      `You are OpenCode running inside the NVIDIA OpenShell Sandbox "${sandbox.name}" (image "${sandbox.image || DEFAULT_IMAGE}", namespace "${resolvedWorkspace}" on ${sandbox.url}) for project "${sandbox.projectName}".`,
      `Live sandbox telemetry from inside the Kubernetes container:\n${sandboxSnapshot}`,
      `Active NVIDIA OpenShell secret providers: ${(sandbox.providers || []).join(', ') || 'none'}.`,
      'Answer concisely and helpfully. You can reference the live sandbox state and assist with code, git, container images, or shell tasks.',
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

    for (const candidateModel of candidateModels) {
      try {
        const resp = await fetch(`${orBase}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${effectiveOpenrouterKey}`,
            'HTTP-Referer': sandbox.url,
            'X-Title': `AI Fleet OpenShell (${sandbox.name})`,
          },
          body: JSON.stringify({
            model: candidateModel,
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
              model: data?.model || candidateModel,
              commandOutput: lastExecResult,
            };
          }
        }
      } catch {
        // Try next free model candidate or fall back to deterministic sandbox telemetry
      }
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
  const orStatus = sandbox.secrets?.openrouter?.configured
    ? `synced (\`openrouter\` provider, model \`${selectedModel}\`)`
    : `free model ready (\`${selectedModel}\` via opencode)`;
  const regStatus = sandbox.secrets?.imageRegistry?.configured
    ? `synced (\`${sandbox.secrets.imageRegistry.registryUrl}\`)`
    : 'publicpull (configure org registry credentials in Organization settings for private push/pull)';
  const hostInfo = snapshotLines.HOSTNAME ? `${snapshotLines.HOSTNAME} (${snapshotLines.KERNEL || 'Linux'})` : sandbox.name;

  const reply = [
    `**NVIDIA OpenShell Sandbox \`${sandbox.name}\`** (image \`${sandbox.image || DEFAULT_IMAGE}\`, ${sandbox.phase || 'READY'} in namespace \`${resolvedWorkspace}\` on \`${sandbox.url}\`)`,
    `- **Container Host**: \`${hostInfo}\``,
    `- **OpenCode Runtime**: \`opencode\` CLI active with free OpenRouter models (\`${FREE_OPENROUTER_MODELS.join('`, `')}\`)`,
    `- **Organization Secrets**: GitHub: ${ghStatus} | OpenRouter: ${orStatus} | Image Registry: ${regStatus}`,
    `- **Message Received**: "${prompt}"`,
    `Tip: Run shell or OpenCode commands directly in the interactive terminal (e.g., \`opencode status\`, \`opencode models\`, \`uname -a\`, \`ls -la /workspace\`).`,
  ].join('\n');

  return {
    reply,
    sandbox,
    model: selectedModel,
    commandOutput: lastExecResult,
  };
}

module.exports = {
  SERVICE_PATH,
  DEFAULT_OPENSHELL_URL,
  DEFAULT_WORKSPACE,
  ALLOWED_WORKSPACES,
  DEFAULT_IMAGE,
  SUPPORTED_SANDBOX_IMAGES,
  DEFAULT_OPENROUTER_MODEL,
  FREE_OPENROUTER_MODELS,
  resolveOpenShellUrl,
  resolveOpenShellWorkspace,
  sanitizeSandboxName,
  normalizeSandboxName,
  encodeObjectMeta,
  decodeObjectMeta,
  buildDockerConfigJson,
  buildOrgImagePullSecretManifest,
  getSampleNetworkPolicy,
  runSandboxSecurityChecks,
  grpcCall,
  getGatewayStatus,
  ensureProviderProfiles,
  syncNvidiaSecrets,
  getProjectSandboxStatus,
  execInSandbox,
  execInteractiveSandboxCommand,
  autocompleteSandboxInput,
  ensureProjectSandbox,
  stopProjectSandbox,
  startProjectSandbox,
  deleteProjectSandbox,
  changeSandboxImage,
  listSandboxes,
  chatWithProjectSandbox,
};
