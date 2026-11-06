# ---------------------------------------------------------------------------
# Agent Substrate — a second, selectable execution substrate that REUSES this
# same "openshell-multitenant" GKE cluster (per the approved plan).
#
# Scope of THIS file (all gated behind var.substrate_enabled so the existing
# OpenShell-only cluster plans EMPTY and stays byte-for-byte unchanged):
#   * a dedicated, tainted worker node pool (isolates Substrate actors from
#     OpenShell tenant nodes),
#   * the WorkerPool CR the control plane synthesises worker pods from — the
#     nodes above are useless without it, and its toleration must be the taint
#     above by construction,
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
#     path-prefix match (var.substrate_control_plane_public, off by default),
#     plus the single Role+RoleBinding that lets the CI rotation job mint the
#     bearer token that control plane requires.
#
# The ate-system CONTROL PLANE itself (ateapi/atelet/atecontroller/
# ate-idp-server/atenet-router/atenet-egress/podcertcontroller + the ate.dev
# CRDs + the gVisor SandboxConfig) is installed by the UPSTREAM substrate
# installer, run from CI by .github/workflows/substrate-control-plane.yml —
# because the manifests only exist inside the installer's own checkout (its
# images are ko-built, so we pass --image-repo/--image-tag to use the published
# release images instead of building any). Terraform never renders them. See
# docs/SUBSTRATE_INTEGRATION.md §5.2. Our backend then talks to it over gRPC only.
# ---------------------------------------------------------------------------

locals {
  substrate_enabled = var.substrate_enabled
  # The public front exists only with a hostname to serve.
  substrate_front_enabled = local.substrate_enabled && var.substrate_ingress_hostname != ""
  # cert-manager presents HTTP-01 by creating one HTTPRoute carrying every one of
  # these parentRefs, so the challenge answers on whichever front the hostname's
  # A record resolves to — an unprogrammed parent still Accepts the route. Listing
  # only openshell-ingress (what this did before) ties a substrate challenge to the
  # OpenShell front by accident; listing both means an operator who points
  # substrate.archagentix.com at either IP gets an issued certificate.
  acme_solver_parent_refs = concat(
    [{ name = "openshell-ingress", namespace = "openshell", kind = "Gateway" }],
    local.substrate_front_enabled ? [{ name = "substrate-ingress", namespace = "ate-system", kind = "Gateway" }] : [],
  )
  # Worker pods carry a toleration for this taint so the scheduler places only
  # Substrate actors here, never generic tenant workloads.
  #
  # WHY this exact key, and not something of our own: atelet is installer-owned
  # and tolerates only ate.dev/sandboxClass; a bespoke taint key strands the
  # pool with no per-node sandbox agent. Observed live on
  # openshell-multitenant:
  #
  #   kubectl -n ate-system get ds atelet \
  #     -o jsonpath='{.spec.template.spec.tolerations}'
  #   -> [{ate.dev/sandboxClass   Exists NoSchedule},
  #       {cloud.google.com/compute-class Exists NoSchedule}]
  #
  # atelet is the per-node agent that actually boots a gVisor sandbox, so a node
  # it cannot join is a node on which no actor can ever run — nothing in this
  # repo or in the cluster tolerated the previous
  # `substrate.ate.dev/workers=true:NO_SCHEDULE`, so every node the pool scaled
  # up would have come up without a sandbox agent on it. The value is the
  # sandbox class (var.substrate_sandbox_class), because that is what the
  # WorkerPool and the atenet data plane key on; the three must be one string.
  #
  # Two more things a reader cannot get from the code:
  #   * Effect spelling differs per layer on purpose. The node-pool API spells
  #     it NO_SCHEDULE, a Kubernetes toleration spells the same taint
  #     NoSchedule; getting either one wrong silently unschedules everything
  #     instead of erroring.
  #   * This block is ForceNew under google provider 6.50 (node_config is
  #     ForceNew), so changing it REPLACES the node pool. That is only safe
  #     while the pool holds no actors — confirm with
  #     `kubectl get nodes -l cloud.google.com/gke-nodepool=<pool>` and the
  #     workerpools.ate.dev ready count before applying.
  substrate_taint = {
    key    = "ate.dev/sandboxClass"
    value  = var.substrate_sandbox_class
    effect = "NO_SCHEDULE"
  }
  # The matching toleration, rendered into the WorkerPool below. Derived from
  # the taint rather than restated, so the two cannot drift apart.
  substrate_taint_toleration = {
    key      = local.substrate_taint.key
    operator = "Equal"
    value    = local.substrate_taint.value
    effect   = "NoSchedule"
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

    # See local.substrate_taint for why this key/value and why the effect is
    # spelled NO_SCHEDULE here but NoSchedule in the WorkerPool toleration.
    # Editing this block replaces the pool (node_config is ForceNew).
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
# The WorkerPool the pool above is only half of.
#
# A tainted node is not something an actor can run on; the unit the control
# plane schedules onto is a worker pod, synthesised from a
# workerpools.ate.dev object. Terraform rendered the nodes and never the pool
# that claims them, so `workerSelector: {"ate.dev/worker-pool": <name>}` (the
# label the backend sends, packages/shared-core/src/agent/substrate.js) had no
# object to resolve to — that key addresses the WorkerPool CR, whose name the
# controller stamps onto the worker pods it creates from it, and NOT a node
# label. Zero instances of the CRD existed live, which is why a run never got
# a sandbox.
#
# Shape confirmed against the live CRD rather than guessed:
#   kubectl get crd workerpools.ate.dev \
#     -o jsonpath='{.spec.group}.{.spec.versions[0].name}'   -> ate.dev/v1
#   kubectl get crd workerpools.ate.dev -o jsonpath='{.spec.scope}'  -> Namespaced
#   spec.required                = [replicas, sandboxClasses, workerImage]
#   spec.sandboxClasses[].name   enum [gvisor, microvm], maxItems 1
#   spec.sandboxClasses[].configRef -> a CLUSTER-scoped SandboxConfig
#   spec.template.properties     = annotations, labels, nodeAffinity,
#                                  nodeSelector, priorityClassName, resources,
#                                  serviceAccountName, tolerations
#   metadata.name CEL rule       = length(self) <= 63 (worker pods use it as a
#                                  label value)
#
# Deliberately NOT set: spec.template.labels. The `ate.dev/` domain there is
# reserved for the controller (CRD CEL: `!key.startsWith('ate.dev/')`), so a
# hand-written `ate.dev/worker-pool` label is rejected outright — that stamp
# belongs to the controller, not to us.
# ---------------------------------------------------------------------------

resource "kubectl_manifest" "substrate_worker_pool" {
  count = local.substrate_enabled ? 1 : 0

  # Heredoc rather than yamlencode: every interpolation here is a single-line
  # scalar. The yamlencode rule in this file (substrate_ateapi_ca) exists for
  # the multi-line PEM specifically — a block scalar assembled by string
  # interpolation breaks on the first indent change upstream, and nothing in
  # this body changes indent.
  yaml_body = <<-YAML
    apiVersion: ate.dev/v1
    kind: WorkerPool
    metadata:
      name: ${var.substrate_worker_pool_name}
      namespace: ate-system
    spec:
      # Warm workers, not a ceiling: a sandbox claims one of these, it does not
      # create one (see var.substrate_worker_pool_replicas).
      replicas: ${var.substrate_worker_pool_replicas}
      # Required by the CRD — the control plane keeps no server-side default
      # for it, so this cannot be left out.
      workerImage: "${var.substrate_worker_image}"
      sandboxClasses:
        - name: ${var.substrate_sandbox_class}
          configRef:
            name: ${var.substrate_sandbox_config_name}
      template:
        nodeSelector:
          # GKE writes this label on every node of the pool, so node selection
          # needs no custom node label — and therefore no node_config.labels,
          # which would be a second ForceNew on the pool for nothing.
          "cloud.google.com/gke-nodepool": "${var.substrate_node_pool_name}"
        tolerations:
          # Exactly the taint the pool is born with, so these pods are the only
          # thing the scheduler places there — and so atelet, which tolerates
          # the same key with Exists, is on the node to boot the sandbox.
          - key: "${local.substrate_taint_toleration.key}"
            operator: "${local.substrate_taint_toleration.operator}"
            value: "${local.substrate_taint_toleration.value}"
            effect: "${local.substrate_taint_toleration.effect}"
  YAML

  # The namespace is Terraform-owned under the same condition this CR is (see
  # kubernetes_namespace_v1.substrate_system). The CRD itself arrives with the
  # upstream installer run, which docs/SUBSTRATE_INTEGRATION.md §5 places AFTER
  # this apply — so a first-time apply fails with `could not find the requested
  # resource, Kind "WorkerPool"` and converges on the next apply. Same
  # chicken-and-egg the §5.3 ingress block documents for ate-system.
  depends_on = [
    google_container_node_pool.substrate_nodes,
    kubernetes_namespace_v1.substrate_system,
  ]
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

# The ingress and the WorkerPool below live in ate-system, and Terraform runs
# BEFORE the installer that normally creates that namespace (§5 step 2 vs step
# 3) — the apply then dies with `namespaces "ate-system" not found` and renders
# nothing. So claim it here, gated on the same condition as its contents:
# substrate enabled, because the WorkerPool is Terraform-owned with or without
# a public hostname (an actor still has to land somewhere). Before the WorkerPool
# existed, nothing in ate-system was Terraform-owned unless a hostname had been
# asked for, and the installer stayed the sole owner otherwise — that is no
# longer true, and the gate has to follow the objects or it silently 404s them.
# The installer's own `kubectl apply` of the namespace merges into this one
# rather than failing.
resource "kubernetes_namespace_v1" "substrate_system" {
  count = local.substrate_enabled ? 1 : 0

  metadata {
    name = "ate-system"
  }

  depends_on = [google_container_node_pool.primary_nodes]
}

resource "google_compute_address" "substrate_ip" {
  count = local.substrate_front_enabled ? 1 : 0

  name    = "substrate-ip"
  project = var.project_id
  region  = var.region

  depends_on = [google_project_service.required_apis]
}

resource "kubectl_manifest" "substrate_certificate" {
  count = local.substrate_front_enabled ? 1 : 0

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

  depends_on = [
    helm_release.cert_manager,
    kubernetes_namespace_v1.substrate_system,
  ]
}

resource "kubectl_manifest" "substrate_envoy_proxy" {
  count = local.substrate_front_enabled ? 1 : 0

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
    kubernetes_namespace_v1.substrate_system,
  ]
}

resource "kubectl_manifest" "substrate_ingress_gateway" {
  count = local.substrate_front_enabled ? 1 : 0

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
        # The front has to have at least one listener Envoy Gateway can build.
        # With only the HTTPS listener, the missing certificate Secret means no
        # data plane at all (Programmed=False, reason=AddressNotAssigned) and
        # HTTP-01 — which connects to port 80 of whatever the A record resolves
        # to — can never reach it. This listener answers the challenge, and 443
        # joins the Service the moment the certificate is issued.
        # substrate_http_redirect below keeps it from being a cleartext path.
        - name: http
          port: 80
          protocol: HTTP
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

resource "kubectl_manifest" "substrate_http_redirect" {
  count = local.substrate_front_enabled ? 1 : 0

  # sectionName pins this to the port-80 listener; the actor and control-plane
  # routes below attach to every listener they match, so without it actor
  # traffic would terminate in plaintext. It cannot shadow the ACME challenge:
  # Envoy Gateway sorts routes by match precedence (Exact > Regex > PathPrefix,
  # and a "/" prefix counts as the least specific of all), so cert-manager's
  # exact-path solver route always wins on this listener.
  yaml_body = <<-YAML
    apiVersion: gateway.networking.k8s.io/v1
    kind: HTTPRoute
    metadata:
      name: substrate-http-redirect
      namespace: ate-system
    spec:
      parentRefs:
        - group: gateway.networking.k8s.io
          kind: Gateway
          name: substrate-ingress
          sectionName: http
      hostnames:
        - "${var.substrate_ingress_hostname}"
      rules:
        - matches:
            - path:
                type: PathPrefix
                value: /
          filters:
            - type: RequestRedirect
              requestRedirect:
                scheme: https
                port: 443
                statusCode: 301
  YAML

  depends_on = [kubectl_manifest.substrate_ingress_gateway]
}

resource "kubectl_manifest" "substrate_actor_route" {
  count = local.substrate_front_enabled ? 1 : 0

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
          # https only. Attaching to the port-80 listener too would tie with the
          # redirect route on match precedence (both are a "/" PathPrefix, which
          # Envoy Gateway scores as zero characters), leaving it to insertion
          # order whether this traffic answers in plaintext.
          sectionName: https
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
  count = local.substrate_front_enabled ? 1 : 0

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
# Control-plane ingress (substrateUrl): serve the Control gRPC service on the
# SAME hostname. Opt-in, because the control plane creates/deletes actors and
# mints actor JWTs. docs/SUBSTRATE_INTEGRATION.md §5.3 records the one thing still
# missing on the caller side: a bearer token this cluster mints.
#
# Four pieces, each one the answer to a failure the previous shape produced:
#   * a ConfigMap holding the CA that signs the api server's serving certificate.
#     podcertificate-controller mints it into the `service-dns-ca-pool` Secret in
#     its own namespace (self-signed, one-year validity), and Gateway API offers no
#     skip-verify, so the front cannot check the leaf without this copy. It refreshes
#     on every apply — a CA rotation between applies leaves the copy stale, which is
#     why §5.3 wants an apply after any podcertificate-controller upgrade.
#   * an Envoy Gateway `Backend` carrying SNI + ALPN h2 + that CA. A Gateway API
#     BackendTLSPolicy cannot express ALPN, and Envoy Gateway's `Backend` API is off
#     unless the cluster's `envoy-gateway-config` sets
#     `extensionApis.enableBackend: true`. This module does not install Envoy
#     Gateway, so it cannot set that; the substrate workflow's preflight reports it.
#   * a GRPCRoute, not an HTTPRoute. The Service port is *named* `grpc`, which Envoy
#     Gateway does not map to HTTP/2, so an HTTPRoute upstreams HTTP/1.1 at a grpc-go
#     server and every stream dies. Envoy Gateway supports both kinds.
#   * a NetworkPolicy. The installer's `ate-api-server` policy admits port 443 only
#     from four ate-system workloads and namespaces labelled `ate.dev/api-access=true`,
#     so the front's proxy pods were dropped without a log line. NetworkPolicy is a
#     union of allows, so this grants the front's proxies and nothing else.
# ---------------------------------------------------------------------------

data "kubernetes_secret" "substrate_ateapi_ca" {
  count = local.substrate_front_enabled && var.substrate_control_plane_public ? 1 : 0

  metadata {
    name      = "service-dns-ca-pool"
    namespace = "podcertificate-controller-system"
  }
}

resource "kubectl_manifest" "substrate_ateapi_ca" {
  count = local.substrate_front_enabled && var.substrate_control_plane_public ? 1 : 0

  # yamlencode rather than a heredoc: the PEM is multi-line, and a block scalar
  # built by string interpolation breaks on the first indent change upstream.
  yaml_body = yamlencode({
    apiVersion = "v1"
    kind       = "ConfigMap"
    metadata = {
      name      = "substrate-ateapi-ca"
      namespace = "ate-system"
    }
    data = {
      "ca.crt" = trimspace(data.kubernetes_secret.substrate_ateapi_ca[0].data["tls.crt"])
    }
  })
}

resource "kubectl_manifest" "substrate_ateapi_backend" {
  count = local.substrate_front_enabled && var.substrate_control_plane_public ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: gateway.envoyproxy.io/v1alpha1
    kind: Backend
    metadata:
      name: substrate-ateapi
      namespace: ate-system
    spec:
      tls:
        sni: ${var.substrate_ateapi_service}.ate-system.svc
        alpnProtocols:
          - h2
        caCertificateRefs:
          - group: ""
            kind: ConfigMap
            name: substrate-ateapi-ca
      endpoints:
        - fqdn:
            hostname: ${var.substrate_ateapi_service}.ate-system.svc.cluster.local
            port: ${var.substrate_ateapi_port}
  YAML

  depends_on = [kubectl_manifest.substrate_ateapi_ca]
}

resource "kubectl_manifest" "substrate_control_plane_route" {
  count = local.substrate_front_enabled && var.substrate_control_plane_public ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: gateway.networking.k8s.io/v1
    kind: GRPCRoute
    metadata:
      name: substrate-control-plane
      namespace: ate-system
    spec:
      parentRefs:
        - name: substrate-ingress
          namespace: ate-system
          # https only. Attaching to the port-80 listener too would tie with the
          # redirect route on match precedence, leaving it to insertion order whether
          # control-plane gRPC — which creates and deletes actors — answers in
          # plaintext.
          sectionName: https
      hostnames:
        - "${var.substrate_ingress_hostname}"
      rules:
        - matches:
            - method:
                # The service half of SERVICE_PATH in
                # packages/shared-core/src/agent/substrate.js, without the leading
                # slash GRPCRoute matches on.
                type: Exact
                service: substrate.ateapi.v1.Control
          backendRefs:
            - group: gateway.envoyproxy.io
              kind: Backend
              name: substrate-ateapi
              weight: 1
  YAML

  depends_on = [kubectl_manifest.substrate_ateapi_backend]
}

resource "kubectl_manifest" "substrate_control_plane_traffic" {
  count = local.substrate_front_enabled && var.substrate_control_plane_public ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: gateway.envoyproxy.io/v1alpha1
    kind: BackendTrafficPolicy
    metadata:
      name: substrate-control-plane-traffic
      namespace: ate-system
    spec:
      targetRefs:
        - group: gateway.networking.k8s.io
          kind: GRPCRoute
          name: substrate-control-plane
      timeout:
        http:
          requestTimeout: 0s
  YAML

  depends_on = [kubectl_manifest.substrate_control_plane_route]
}

resource "kubectl_manifest" "substrate_front_ateapi_policy" {
  count = local.substrate_front_enabled && var.substrate_control_plane_public ? 1 : 0

  # Which proxy pods serve this front is Envoy Gateway's business, and it labels
  # them with the owning Gateway — so the grant follows the front instead of
  # opening envoy-gateway-system as a whole (that namespace also holds the
  # OpenShell front's proxies, which have no reason to reach the control plane).
  yaml_body = <<-YAML
    apiVersion: networking.k8s.io/v1
    kind: NetworkPolicy
    metadata:
      name: substrate-front-to-ateapi
      namespace: ate-system
    spec:
      podSelector:
        matchLabels:
          app: ate-api-server
      policyTypes:
        - Ingress
      ingress:
        - from:
            - namespaceSelector:
                matchLabels:
                  kubernetes.io/metadata.name: envoy-gateway-system
              podSelector:
                matchLabels:
                  gateway.envoyproxy.io/owning-gateway-name: substrate-ingress
          ports:
            - port: ${var.substrate_ateapi_port}
              protocol: TCP
  YAML

  depends_on = [kubectl_manifest.substrate_ingress_gateway]
}

# ---------------------------------------------------------------------------
# Minting the control-plane bearer token, narrowly.
#
# docs/SUBSTRATE_INTEGRATION.md §5.3 item 4: the public control plane admits one
# credential, a projected SA token for `system:serviceaccount:ate-system:
# ate-client` (audience `api.ate-system.svc`), and a Cloud Run workload cannot
# mint one for itself. So a scheduled CI job mints it with
#   kubectl -n ate-system create token ate-client \
#     --audience=api.ate-system.svc --duration=43200s
# and publishes it to Secret Manager (deploy/gcp/terraform/substrate_token.tf
# holds the container and its two IAM grants; the workflow is
# .github/workflows/substrate-token-rotate.yml). Terraform writes none of the
# VALUE — only the permission to create it.
#
# `kubectl create token` is NOT a `serviceaccounts` call: it hits the
# `serviceaccounts/token` SUBRESOURCE with verb `create`. Granting `get` on
# `serviceaccounts`, or `create` on `serviceaccounts`, both leave the command at
# a 403 that reads like a missing role rather than a missing subresource.
#
# Do not lean on roles/container.admin for this. GKE's RBAC model does not
# promise that an IAM role implies a Kubernetes RBAC rule, and the day the
# project swaps container.admin for a narrower pool role the rotation job would
# break in CI rather than at apply. One verb's worth of permission is cheaper
# than that outage, and it is the same argument ci_rbac.tf already makes for the
# power workflow.
#
# Gated with the control-plane route it serves, so a deployment that publishes
# no public control plane never renders cluster RBAC into ate-system at all.
# ---------------------------------------------------------------------------

locals {
  # The condition every §5.3 control-plane object already spells inline. Named
  # once here because the two RBAC objects below need it too.
  substrate_control_plane_public_enabled = local.substrate_front_enabled && var.substrate_control_plane_public

  # The Kubernetes user the rotation job arrives as. See
  # var.substrate_token_creator_user for why a Workload-Identity-Federated GCP
  # service account is a `User` subject and not a `ServiceAccount` one.
  substrate_token_creator_user = var.substrate_token_creator_user != "" ? var.substrate_token_creator_user : "gh-deployer@${var.project_id}.iam.gserviceaccount.com"
}

resource "kubectl_manifest" "substrate_ate_client_token_role" {
  count = local.substrate_control_plane_public_enabled ? 1 : 0

  # The single mint the job may strike: `create` on the token subresource,
  # pinned to ate-client by resourceNames. Without resourceNames this would let
  # the job mint tokens for every service account in ate-system, including the
  # installer's own privileged ones.
  yaml_body = <<-YAML
    apiVersion: rbac.authorization.k8s.io/v1
    kind: Role
    metadata:
      name: substrate-ate-client-token-minter
      namespace: ate-system
    rules:
      - apiGroups: [""]
        resources: ["serviceaccounts/token"]
        resourceNames: ["ate-client"]
        verbs: ["create"]
  YAML

  depends_on = [kubernetes_namespace_v1.substrate_system]
}

resource "kubectl_manifest" "substrate_ate_client_token_role_binding" {
  count = local.substrate_control_plane_public_enabled ? 1 : 0

  yaml_body = <<-YAML
    apiVersion: rbac.authorization.k8s.io/v1
    kind: RoleBinding
    metadata:
      name: substrate-ate-client-token-minter
      namespace: ate-system
    roleRef:
      apiGroup: rbac.authorization.k8s.io
      kind: Role
      name: substrate-ate-client-token-minter
    subjects:
      - apiGroup: rbac.authorization.k8s.io
        kind: User
        name: ${local.substrate_token_creator_user}
  YAML

  depends_on = [kubectl_manifest.substrate_ate_client_token_role]
}
