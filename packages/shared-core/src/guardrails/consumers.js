'use strict';

/**
 * Guardrail spec CONSUMERS — render one normalized guardrail spec into the
 * low-level artifacts each execution substrate enforces. The operator edits the
 * spec once (settings.guardrailSpec); these functions are the single place that
 * maps it onto OpenShell (Kubernetes NetworkPolicy) and Agent Substrate (atenet
 * EgressPolicy rules + namespace NetworkPolicy + credential-provider read policy).
 *
 * Enforcement is always deny-by-default: a rule appears only if the spec spells it
 * out, and the cloud-metadata CIDR is always denied.
 */

const { normalizeGuardrailSpec, METADATA_DENY_CIDR } = require('./spec');

// TCP ports allowed for egress, deduped, from the spec's port list.
function tcpEgressPorts(spec) {
  const ports = (spec.egress.ports || [])
    .filter((p) => String(p.proto).toUpperCase() === 'TCP')
    .map((p) => p.port);
  return [...new Set(ports)];
}

/**
 * Substrate atenet EgressPolicy rules (the shape createActorEgressPolicy encodes).
 * allowHosts → a single HTTPS rule; ports constrain it. Empty allowHosts → no rules
 * → default-deny (the empty namespace policy the substrate ships still applies).
 */
function buildAtenetEgressPolicy(rawSpec) {
  const spec = normalizeGuardrailSpec(rawSpec);
  const rules = [];
  if (spec.egress.allowHosts.length) {
    rules.push({ https: { hostnames: spec.egress.allowHosts, ports: tcpEgressPorts(spec) } });
  }
  return { rules, denyByDefault: true, denyCidrs: spec.egress.denyCidrs };
}

/**
 * Kubernetes NetworkPolicy YAML for the actor/sandbox namespace, derived from the
 * spec: egress to the DNS + HTTPS ports with the metadata CIDR excepted, ingress
 * restricted to the allow-listed SPIFFE identities / service accounts.
 */
function buildNamespaceNetworkPolicy(rawSpec, { namespace = 'default', podSelectorLabels = {} } = {}) {
  const spec = normalizeGuardrailSpec(rawSpec);
  const tcpPorts = tcpEgressPorts(spec);
  const udpPorts = [...new Set((spec.egress.ports || [])
    .filter((p) => String(p.proto).toUpperCase() === 'UDP').map((p) => p.port))];

  const egressPorts = [
    ...udpPorts.map((p) => ({ protocol: 'UDP', port: p })),
    ...tcpPorts.map((p) => ({ protocol: 'TCP', port: p })),
  ];
  const selectorLines = Object.keys(podSelectorLabels).length
    ? ['    matchLabels:', ...Object.entries(podSelectorLabels).map(([k, v]) => `      ${k}: ${v}`)]
    : ['    {}'];

  const lines = [
    'apiVersion: networking.k8s.io/v1',
    'kind: NetworkPolicy',
    'metadata:',
    '  name: aifleet-guardrail-egress',
    `  namespace: ${namespace}`,
    '  labels:',
    '    app.kubernetes.io/managed-by: ai-fleet',
    `    guardrail.ate.dev/version: "${spec.version}"`,
    'spec:',
    '  podSelector:',
    ...selectorLines,
    '  policyTypes:',
    '    - Ingress',
    '    - Egress',
    '  egress:',
    '    - to:',
    '        - ipBlock:',
    '            cidr: 0.0.0.0/0',
    '            except:',
    ...spec.egress.denyCidrs.map((c) => `              - ${c}`),
    '      ports:',
    ...egressPorts.flatMap((p) => [`        - protocol: ${p.protocol}`, `          port: ${p.port}`]),
  ];

  if (spec.ingress.allowedServiceAccounts.length || spec.ingress.allowedSpiffeIds.length) {
    lines.push('  ingress:');
    lines.push('    - from:');
    for (const sa of spec.ingress.allowedServiceAccounts) {
      const [ns, name] = String(sa).includes('/') ? String(sa).split('/') : [namespace, sa];
      lines.push('        - namespaceSelector:', `            matchLabels:`, `              kubernetes.io/metadata.name: ${ns}`, '          podSelector:', `            matchLabels:`, `              kubernetes.io/service-account.name: ${name}`);
    }
    // SPIFFE ids are enforced by the mesh/atenet router, not the k8s NetworkPolicy,
    // but recorded as an annotation so the intent is auditable in-cluster.
    if (spec.ingress.allowedSpiffeIds.length) {
      lines.push('    # allowedSpiffeIds (enforced at the mTLS router):');
      for (const id of spec.ingress.allowedSpiffeIds) lines.push(`    # - ${id}`);
    }
  } else {
    lines.push('  ingress: []');
  }

  return {
    name: 'aifleet-guardrail-egress',
    namespace,
    enforced: true,
    yaml: lines.join('\n'),
    summary: [
      { rule: 'Metadata SSRF', target: METADATA_DENY_CIDR, effect: 'DENY' },
      { rule: 'Egress ports', target: egressPorts.map((p) => `${p.protocol}/${p.port}`).join(', ') || 'none', effect: 'ALLOW' },
      { rule: 'Ingress', target: spec.ingress.allowedServiceAccounts.join(', ') || 'none', effect: 'ALLOW' },
    ],
  };
}

/**
 * Credential-provider read policy: which per-tenant Secret names the atespace may
 * read, derived from spec.credentials.scopes. The egress gateway (not the actor)
 * reads these; the actor env never sees a raw value.
 */
function buildCredentialProviderPolicy(rawSpec, { namespace = 'substrate-credentials' } = {}) {
  const spec = normalizeGuardrailSpec(rawSpec);
  const scopeToSecret = {
    github: 'ghcr-pull-and-clone',
    openrouter: 'openrouter-api-key',
    'image-registry': 'image-registry-creds',
  };
  const allowedSecrets = spec.credentials.scopes
    .map((scope) => ({ scope, secretName: scopeToSecret[scope] || `cred-${scope}` }))
    .filter((e) => e.secretName);
  return {
    version: spec.version,
    namespace,
    allowedSecrets,
    // The credential source the substrate k8s provider expects.
    credentialProvider: { name: 'k8s.io' },
  };
}

/**
 * OpenShell consumer: the same spec rendered as the operator-facing NetworkPolicy
 * summary + the mitm / runtime knobs. Kept intentionally minimal here; the
 * behavior-identical refactor of openshell.getSampleNetworkPolicy is tracked
 * alongside the OpenShell route wiring.
 */
function buildOpenShellGuardrail(rawSpec, { workspace = 'tenant-a', orgLabel = 'tenant-a' } = {}) {
  const spec = normalizeGuardrailSpec(rawSpec);
  return {
    workspace,
    orgLabel,
    version: spec.version,
    egress: buildAtenetEgressPolicy(spec),
    mitmTrust: spec.egress.mitmTrust,
    networkPolicy: buildNamespaceNetworkPolicy(spec, { namespace: workspace }),
  };
}

module.exports = {
  buildAtenetEgressPolicy,
  buildNamespaceNetworkPolicy,
  buildCredentialProviderPolicy,
  buildOpenShellGuardrail,
  tcpEgressPorts,
};
