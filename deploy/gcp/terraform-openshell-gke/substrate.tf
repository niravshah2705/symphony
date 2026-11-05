# ---------------------------------------------------------------------------
# Agent Substrate — a second, selectable execution substrate that REUSES this
# same "openshell-multitenant" GKE cluster (per the approved plan).
#
# Scope of THIS file (all gated behind var.substrate_enabled so the existing
# OpenShell-only cluster plans EMPTY and stays byte-for-byte unchanged):
#   * a dedicated, tainted worker node pool (isolates Substrate actors from
#     OpenShell tenant nodes),
#   * snapshot StorageClass + VolumeSnapshotClass for atelet actor snapshots,
#   * the credential-provider read grant (raw Secrets live only in the
#     substrate-credentials namespace; the egress gateway reads them, the actor
#     never does),
#   * a public actor data-plane ingress (Gateway + HTTPRoute) fronting
#     atenet-router, reusing the same Envoy Gateway + cert-manager stack, on its
#     OWN Envoy data plane bound to the substrate-ip static address (the
#     GatewayClass-level EnvoyProxy pins the openshell IP, so a substrate
#     Gateway left on the shared infra would claim the wrong address),
#   * optionally, the ateapi control plane on that same hostname behind a
#     path-prefix match (var.substrate_control_plane_public, off by default).
#
# The ate-system CONTROL PLANE itself (ateapi/atelet/atecontroller/
# ate-idp-server/atenet-router/atenet-egress/podcertcontroller + the ate.dev
# CRDs + the gVisor SandboxConfig) is installed by the UPSTREAM substrate
# installer — `go run ./cmd/ate-setup deploy ate-system` (or the
# ai-on-gke/substrate-gke setup) — because those images are built dynamically
# with `ko` and are not static manifests we can vendor faithfully. See
# docs/SUBSTRATE_INTEGRATION.md. Our backend then talks to it over gRPC only.
# ---------------------------------------------------------------------------

locals {
  substrate_enabled = var.substrate_enabled
  # Worker pods carry a toleration for this taint so the scheduler places only
  # Substrate actors here, never generic tenant workloads.
  substrate_taint = {
    key    = "substrate.ate.dev/workers"
    value  = "true"
    effect = "NO_SCHEDULE"
  }
}

# ---------------------------------------------------------------------------
# Dedicated worker node pool (parked to 0 by the power workflow, like primary)
# ---------------------------------------------------------------------------

resource "google_container_node_pool" "substrate_nodes" {
  count = local.substrate_enabled ? 1 : 0

  name     = var.substrate_node_pool_name
  project  = var.project_id
  location = var.zone
  cluster  = google_container_cluster.primary.name

  autoscaling {
    min_node_count  = var.substrate_min_nodes
    max_node_count  = var.substrate_max_nodes
    location_policy = "BALANCED"
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    strategy        = "SURGE"
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    machine_type = var.substrate_machine_type
    disk_size_gb = var.disk_size_gb
    disk_type    = var.disk_type
    # UBUNTU_CONTAINERD matches the existing pools; the substrate installer
    # installs runsc (gVisor) itself on these nodes.
    image_type = "UBUNTU_CONTAINERD"

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    metadata = {
      disable-legacy-endpoints = "true"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_integrity_monitoring = true
      enable_secure_boot          = false
    }

    taint {
      key    = local.substrate_taint.key
      value  = local.substrate_taint.value
      effect = local.substrate_taint.effect
    }

    kubelet_config {
      insecure_kubelet_readonly_port_enabled = "FALSE"
      max_parallel_image_pulls               = 2
    }
  }

  depends_on = [google_container_cluster.primary]
}

# ---------------------------------------------------------------------------
# Snapshot storage for atelet (actors snapshot to PersistentVolumes)
# ---------------------------------------------------------------------------

resource "kubernetes_storage_class_v1" "substrate_snapshots" {
  count = local.substrate_enabled ? 1 : 0

  metadata {
    name = var.substrate_snapshot_storage_class
  }

  storage_provisioner = "pd.csi.storage.gke.io"
  reclaim_policy      = "Retain"
  volume_binding_mode = "WaitForFirstConsumer"

  parameters = {
    type = "pd-balanced"
  }
}

resource "kubernetes_namespace_v1" "substrate_snapshots" {
  count = local.substrate_enabled ? 1 : 0

  metadata {
    name = "substrate-snapshots"

    labels = {
      "substrate.ate.dev/snapshots"        = "true"
      "pod-security.kubernetes.io/enforce" = "restricted"
    }
  }

  depends_on = [google_container_node_pool.primary_nodes]
}

# The kubernetes provider has no VolumeSnapshotClass resource, so render the
# CRD directly. Snapshots bound to substrate-snapshots' StorageClass persist
# actor suspend/resume state.
resource "kubectl_manifest" "substrate_snapshot_class" {
  count = local.substrate_enabled ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: snapshot.storage.k8s.io/v1
    kind: VolumeSnapshotClass
    metadata:
      name: substrate-snapshot-class
    deletionPolicy: Retain
    driver: pd.csi.storage.gke.io
    parameters:
      namespace: ${kubernetes_namespace_v1.substrate_snapshots[0].metadata[0].name}
  YAML

  depends_on = [kubernetes_storage_class_v1.substrate_snapshots]
}

# ---------------------------------------------------------------------------
# Credential-provider read grant (the step the substrate "Important" note
# requires before ANY credential is injected): the egress gateway's service
# account may read Secrets ONLY in the substrate-credentials namespace.
#
# Default deny is preserved: no wildcards, secrets-only, get/list/watch.
# ---------------------------------------------------------------------------

resource "kubernetes_role_v1" "substrate_credential_reader" {
  count = local.substrate_enabled ? 1 : 0

  metadata {
    name      = "substrate-credential-reader"
    namespace = kubernetes_namespace_v1.substrate_credentials[0].metadata[0].name
  }

  rule {
    api_groups = [""]
    resources  = ["secrets"]
    verbs      = ["get", "list", "watch"]
  }
}

# The ate-system namespace + egress gateway ServiceAccount are created by the
# upstream installer; the subject is parameterized so it can be corrected without
# editing resources. Bound to the installer's atenet-egress SA by default.
resource "kubernetes_role_binding_v1" "substrate_credential_reader" {
  count = local.substrate_enabled ? 1 : 0

  metadata {
    name      = "substrate-credential-reader"
    namespace = kubernetes_namespace_v1.substrate_credentials[0].metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = "atenet-egress"
    namespace = "ate-system"
  }

  role_ref {
    kind      = "Role"
    name      = kubernetes_role_v1.substrate_credential_reader[0].metadata[0].name
    api_group = "rbac.authorization.k8s.io"
  }

  depends_on = [kubernetes_role_v1.substrate_credential_reader]
}

# ---------------------------------------------------------------------------
# Actor data-plane ingress (substrateIngressUrl): front atenet-router over the
# public static IP + LE cert, reusing the existing Envoy Gateway + cert-manager.
# Skipped entirely when substrate_ingress_hostname is empty.
# ---------------------------------------------------------------------------

resource "google_compute_address" "substrate_ip" {
  count = local.substrate_enabled && var.substrate_ingress_hostname != "" ? 1 : 0

  name    = "substrate-ip"
  project = var.project_id
  region  = var.region

  depends_on = [google_project_service.required_apis]
}

resource "kubectl_manifest" "substrate_certificate" {
  count = local.substrate_enabled && var.substrate_ingress_hostname != "" ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: cert-manager.io/v1
    kind: Certificate
    metadata:
      name: substrate-server-tls
      namespace: ate-system
    spec:
      secretName: substrate-server-external-tls
      issuerRef:
        name: letsencrypt-prod
        kind: ClusterIssuer
        group: cert-manager.io
      dnsNames:
        - "${var.substrate_ingress_hostname}"
  YAML

  depends_on = [helm_release.cert_manager]
}

resource "kubectl_manifest" "substrate_envoy_proxy" {
  count = local.substrate_enabled && var.substrate_ingress_hostname != "" ? 1 : 0

  # The GatewayClass-level EnvoyProxy pins the OPENSELL static IP, so every
  # Gateway on class `eg` would claim that address. This per-Gateway override
  # gives the substrate its own Envoy data plane on substrate-ip and lives in
  # ate-system so parametersRef needs no cross-namespace ReferenceGrant.
  yaml_body = <<-YAML
    apiVersion: gateway.envoyproxy.io/v1alpha1
    kind: EnvoyProxy
    metadata:
      name: substrate-proxy-config
      namespace: ate-system
    spec:
      provider:
        type: Kubernetes
        kubernetes:
          envoyDeployment:
            pod:
              nodeSelector:
                "cloud.google.com/gke-nodepool": "${var.system_node_pool_name}"
          envoyService:
            type: LoadBalancer
            loadBalancerIP: "${google_compute_address.substrate_ip[0].address}"
            externalTrafficPolicy: Local
            annotations:
              networking.gke.io/load-balancer-ip-addresses: "${google_compute_address.substrate_ip[0].address}"
  YAML

  depends_on = [
    helm_release.envoy_gateway,
    google_compute_address.substrate_ip,
  ]
}

resource "kubectl_manifest" "substrate_ingress_gateway" {
  count = local.substrate_enabled && var.substrate_ingress_hostname != "" ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: gateway.networking.k8s.io/v1
    kind: Gateway
    metadata:
      name: substrate-ingress
      namespace: ate-system
    spec:
      gatewayClassName: eg
      infrastructure:
        parametersRef:
          group: gateway.envoyproxy.io
          kind: EnvoyProxy
          name: substrate-proxy-config
      listeners:
        - name: https
          port: 443
          protocol: HTTPS
          tls:
            mode: Terminate
            certificateRefs:
              - name: substrate-server-external-tls
          allowedRoutes:
            namespaces:
              from: Same
  YAML

  depends_on = [
    kubectl_manifest.gateway_class,
    kubectl_manifest.substrate_certificate,
    kubectl_manifest.substrate_envoy_proxy,
  ]
}

resource "kubectl_manifest" "substrate_actor_route" {
  count = local.substrate_enabled && var.substrate_ingress_hostname != "" ? 1 : 0

  # atenet-router forwards to the target actor via the `ate-target-actor`
  # header the backend sets; the router service/port come from the installer.
  yaml_body = <<-YAML
    apiVersion: gateway.networking.k8s.io/v1
    kind: HTTPRoute
    metadata:
      name: substrate-actors
      namespace: ate-system
    spec:
      parentRefs:
        - name: substrate-ingress
          namespace: ate-system
      hostnames:
        - "${var.substrate_ingress_hostname}"
      rules:
        - matches:
            - path:
                type: PathPrefix
                value: /
          backendRefs:
            - name: atenet-router
              port: 8444
  YAML

  depends_on = [kubectl_manifest.substrate_ingress_gateway]
}

# ---------------------------------------------------------------------------
# Long-lived request overrides. Envoy's default request timeout would abort a
# streaming planning run (the actor data plane holds one POST open for the whole
# run) and a control-plane gRPC stream; the client-side SUBSTRATE_TIMEOUT_MS is
# the real bound. Same override openshell-backend-traffic applies.
# ---------------------------------------------------------------------------

resource "kubectl_manifest" "substrate_actor_route_traffic" {
  count = local.substrate_enabled && var.substrate_ingress_hostname != "" ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: gateway.envoyproxy.io/v1alpha1
    kind: BackendTrafficPolicy
    metadata:
      name: substrate-actors-traffic
      namespace: ate-system
    spec:
      targetRefs:
        - group: gateway.networking.k8s.io
          kind: HTTPRoute
          name: substrate-actors
      timeout:
        http:
          requestTimeout: 0s
  YAML

  depends_on = [kubectl_manifest.substrate_actor_route]
}

# ---------------------------------------------------------------------------
# Control-plane ingress (substrateUrl): serve the ateapi gRPC service on the
# SAME hostname, matched by its service-path prefix so it outranks the actor
# route's "/" catch-all. Opt-in, because this adds no caller authentication and
# ateapi creates/deletes actors and mints actor JWTs.
# ---------------------------------------------------------------------------

resource "kubectl_manifest" "substrate_control_plane_route" {
  count = local.substrate_enabled && var.substrate_ingress_hostname != "" && var.substrate_control_plane_public ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: gateway.networking.k8s.io/v1
    kind: HTTPRoute
    metadata:
      name: substrate-control-plane
      namespace: ate-system
    spec:
      parentRefs:
        - name: substrate-ingress
          namespace: ate-system
      hostnames:
        - "${var.substrate_ingress_hostname}"
      rules:
        - matches:
            - path:
                type: PathPrefix
                # SERVICE_PATH in packages/shared-core/src/agent/substrate.js
                value: /substrate.ateapi.v1.Control
          backendRefs:
            - name: ${var.substrate_ateapi_service}
              port: ${var.substrate_ateapi_port}
  YAML

  depends_on = [kubectl_manifest.substrate_ingress_gateway]
}

resource "kubectl_manifest" "substrate_control_plane_traffic" {
  count = local.substrate_enabled && var.substrate_ingress_hostname != "" && var.substrate_control_plane_public ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: gateway.envoyproxy.io/v1alpha1
    kind: BackendTrafficPolicy
    metadata:
      name: substrate-control-plane-traffic
      namespace: ate-system
    spec:
      targetRefs:
        - group: gateway.networking.k8s.io
          kind: HTTPRoute
          name: substrate-control-plane
      timeout:
        http:
          requestTimeout: 0s
  YAML

  depends_on = [kubectl_manifest.substrate_control_plane_route]
}
