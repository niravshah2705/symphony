variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "region" {
  description = "GCP region for regional resources"
  type        = string
  default     = "asia-south1"
}

variable "zone" {
  description = "GCP zone for the zonal GKE cluster"
  type        = string
  default     = "asia-south1-a"
}

variable "cluster_name" {
  description = "GKE cluster name"
  type        = string
  default     = "openshell-multitenant"
}

variable "node_pool_name" {
  description = "Name of the dedicated GKE node pool"
  type        = string
  default     = "openshell-multitenant-node-pool"
}

variable "vpc_name" {
  description = "VPC network name"
  type        = string
  default     = "default"
}

variable "subnet_name" {
  description = "Dedicated subnet name for OpenShell"
  type        = string
  default     = "openshell-subnet"
}

variable "subnet_primary_cidr" {
  description = "Primary IP range for the subnet"
  type        = string
  default     = "10.10.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary IP range for Pods"
  type        = string
  default     = "10.20.0.0/14"
}

variable "services_cidr" {
  description = "Secondary IP range for Services"
  type        = string
  default     = "10.24.0.0/20"
}

variable "domain" {
  description = "Domain name for the OpenShell gateway"
  type        = string
  default     = "openshell.archagentix.com"
}

variable "cert_email" {
  description = "Email address for ACME / Let's Encrypt certificates"
  type        = string
}

variable "openshell_version" {
  description = "Helm chart version for the OpenShell gateway"
  type        = string
  default     = "0.1.5"
}

variable "cert_manager_version" {
  description = "Helm chart version for cert-manager"
  type        = string
  default     = "v1.20.3"
}

variable "envoy_gateway_version" {
  description = "Helm chart version for Envoy Gateway"
  type        = string
  default     = "v1.8.1"
}

variable "tenants" {
  description = "List of tenant namespace names"
  type        = list(string)
  default     = ["tenant-a", "tenant-b"]
}

variable "machine_type" {
  description = "GKE node machine type"
  type        = string
  default     = "e2-standard-2"
}

variable "disk_size_gb" {
  description = "Node boot disk size in GB"
  type        = number
  default     = 50
}

variable "disk_type" {
  description = "Node boot disk type"
  type        = string
  default     = "pd-standard"
}

variable "min_nodes" {
  description = "Minimum node-pool size when the cluster is 'started' (the power workflow sets this to 0 to stop)"
  type        = number
  default     = 2
}

variable "max_nodes" {
  description = "Maximum node-pool size"
  type        = number
  default     = 8
}

variable "system_node_pool_name" {
  description = "Always-on node pool hosting the platform add-ons, so the tenant pool can drain to zero"
  type        = string
  default     = "openshell-system-node-pool"
}

variable "system_machine_type" {
  description = "Machine type for the system node pool"
  type        = string
  default     = "e2-standard-2"
}

variable "system_min_nodes" {
  description = "Size of the system node pool when the cluster is running; the power workflow never parks it"
  type        = number
  default     = 1
}

variable "system_max_nodes" {
  description = "Maximum size of the system node pool"
  type        = number
  default     = 3
}

variable "power_ci_sa_email" {
  description = "Identity the cluster power workflow drains nodes with, bound to the node-drain ClusterRole. Only needed when that identity holds a pool-scoped IAM role instead of roles/container.admin; empty skips the binding."
  type        = string
  default     = ""
}

variable "master_authorized_networks_cidr" {
  description = "HARDENING TODO: tighten to operator/CI egress CIDRs once verified — 0.0.0.0/0 matches the live cluster today"
  type        = string
  default     = "0.0.0.0/0"
}

variable "deletion_protection" {
  description = "Protect the GKE cluster from terraform destroy"
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Agent Substrate (optional second execution substrate; reuses this cluster)
# ---------------------------------------------------------------------------

variable "substrate_enabled" {
  description = "Provision the Agent Substrate worker pool, namespaces, snapshot storage and actor ingress. Default false keeps the existing OpenShell-only plan empty. The ate-system control plane is installed by the upstream substrate installer (see docs/SUBSTRATE_INTEGRATION.md), not by this config."
  type        = bool
  default     = false
}

variable "substrate_node_pool_name" {
  description = "Dedicated node pool for Substrate worker pods (isolated from OpenShell tenants)"
  type        = string
  default     = "substrate-worker-pool"
}

variable "substrate_machine_type" {
  description = "Machine type for Substrate worker nodes (resume wants headroom memory)"
  type        = string
  default     = "e2-standard-4"
}

variable "substrate_min_nodes" {
  description = "Minimum Substrate worker nodes when started (parked to 0 by the power workflow when stopped)"
  type        = number
  default     = 1
}

variable "substrate_max_nodes" {
  description = "Maximum Substrate worker nodes"
  type        = number
  default     = 6
}

variable "substrate_sandbox_class" {
  description = <<EOT
    Sandbox runtime family the worker pool runs. This is NOT cosmetic: it is the
    VALUE of the ate.dev/sandboxClass taint on the worker nodes, which is the key
    the installer's atelet DaemonSet tolerates, and the class the WorkerPool
    CRD's spec.sandboxClasses[].name must carry (enum gvisor|microvm). All three
    are one string, so they are expressed once.
EOT
  type        = string
  default     = "gvisor"

  validation {
    condition     = contains(["gvisor", "microvm"], var.substrate_sandbox_class)
    error_message = "substrate_sandbox_class must be gvisor or microvm (workerpools.ate.dev enum)."
  }
}

variable "substrate_worker_pool_name" {
  description = <<EOT
    Name of the Substrate WorkerPool custom resource in ate-system. This is the
    string Settings' substrateWorkerPool must equal: the backend sends
    workerSelector {"ate.dev/worker-pool": <this>} (packages/shared-core/src/
    agent/substrate.js), and that label addresses the WorkerPool OBJECT — the
    controller stamps it onto the worker pods it synthesises — not a node label.
    Named the same as the GKE pool by default so the two cannot drift by
    accident, but they are separate concepts.
EOT
  type        = string
  default     = "substrate-worker-pool"

  validation {
    # The CRD enforces this with CEL because worker pods use the name as a
    # label value: a 64-character name is rejected by the API server at apply
    # time, which is a much worse error than a plan-time one.
    condition     = length(var.substrate_worker_pool_name) <= 63
    error_message = "substrate_worker_pool_name must be at most 63 characters (workerpools.ate.dev reserves metadata.name as a worker-pod label value)."
  }
}

variable "substrate_worker_pool_replicas" {
  description = <<EOT
    spec.replicas of the WorkerPool: the number of WARM worker pods kept
    running. This is what an actor lands on when a sandbox is created — an
    actor does not queue for a worker, it claims one — so 0 means every run
    waits (or fails) until a worker is up, and N means N actors run
    concurrently on this pool before anything is missing.
EOT
  type        = number
  default     = 1

  validation {
    condition     = var.substrate_worker_pool_replicas >= 0
    error_message = "substrate_worker_pool_replicas cannot be negative (workerpools.ate.dev spec.replicas has minimum 0)."
  }
}

variable "substrate_sandbox_config_name" {
  description = <<EOT
    Name of the cluster-scoped SandboxConfig (sandboxconfigs.ate.dev) the
    WorkerPool's sandbox class resolves to. Verified live on
    openshell-multitenant: `gvisor-default`, class gvisor, annotated
    sandboxconfig.ate.dev/is-class-default=true, created by the v1.0.0
    installer. The field may legitimately be omitted and the controller would
    pick the class default — it is set explicitly so a second, non-default
    SandboxConfig cannot be resolved silently underneath us.
EOT
  type        = string
  default     = "gvisor-default"
}

variable "substrate_worker_image" {
  description = <<EOT
    Worker container image for the WorkerPool (spec.workerImage). REQUIRED by
    the CRD schema (workerpools.ate.dev spec.required = [replicas,
    sandboxClasses, workerImage]) — there is no server-side default, so this
    cannot be left blank. Image name follows the sandbox class, per the
    installer's own release-image preflight
    (.github/workflows/substrate-control-plane.yml:303-310:
    "the worker image follows the sandbox class" — ateworker-gvisor /
    ateworker-microvm), and the repository + tag follow the convention every
    other ate-system component was observed using live
    (ghcr.io/agent-substrate/substrate/<component>:<release tag>).
    Bump in lockstep with the installer version: ate-setup resolves every tag
    to a digest at install time, so an image here that the pinned release does
    not publish fails the apply.
EOT
  type        = string
  default     = "ghcr.io/agent-substrate/substrate/ateworker-gvisor:v1.0.0"

  validation {
    condition     = trimspace(var.substrate_worker_image) != ""
    error_message = "substrate_worker_image cannot be empty: workerpools.ate.dev requires spec.workerImage."
  }
}

variable "substrate_ingress_hostname" {
  description = "Public hostname fronting the atenet-router actor data plane (substrateIngressUrl). Empty provisions no ingress; a hostname gets its own Envoy data plane bound to the substrate-ip static address."
  type        = string
  default     = ""
}

variable "substrate_ateapi_service" {
  description = <<EOT
    Name of the Control-plane Service created by `ate-setup deploy ate-system`, used as
    the control-plane route backend. `api`, not `ateapi`: that is what the installer
    actually creates (headless, ports grpc=443 and exchange=8445) — see
    docs/SUBSTRATE_INTEGRATION.md §5.3 for why the route still does not carry traffic
    against it.
  EOT
  type        = string
  default     = "api"
}

variable "substrate_ateapi_port" {
  description = "Port of the Control-plane Service, used as the control-plane route backend port. 443 is the gRPC listener; the Service has no plaintext port."
  type        = number
  default     = 443
}

variable "substrate_control_plane_public" {
  description = <<EOT
    Also route the ateapi gRPC control plane over substrate_ingress_hostname
    (path prefix /substrate.ateapi.v1.Control), so substrateUrl can be the same
    public host as substrateIngressUrl. Default false: the control plane creates
    and deletes actors and mints actor JWTs, and this config adds no caller
    authentication in front of it. Leave false until the planner reaches ateapi
    over VPC egress or an authN policy is attached to that route.
EOT
  type        = bool
  default     = false
}

variable "substrate_snapshot_storage_class" {
  description = "StorageClass backing atelet actor snapshots (PersistentVolumes)"
  type        = string
  default     = "substrate-snapshot-pd"
}

variable "substrate_credentials_namespace" {
  description = "Namespace holding the credential-provider Secrets the ate-space may read (raw values never enter the actor)"
  type        = string
  default     = "substrate-credentials"
}

variable "substrate_token_creator_user" {
  description = <<EOT
    Kubernetes USER name allowed to mint the ate-client service-account token
    the substrate-token-rotate workflow runs `kubectl create token ate-client`
    as. Empty derives the deployer identity the workflows authenticate as,
    gh-deployer@<project>.iam.gserviceaccount.com — spelled from var.project_id
    for the same reason deploy/gcp/terraform/substrate_token.tf:50-57 does:
    that service account is created by bootstrap.sh, outside this state, so it
    cannot be read through a data source.

    The subject is a User, not a ServiceAccount, and this is the easy half of
    this file to get wrong. A GCP service account that reaches GKE through
    Workload Identity Federation is presented by the auth webhook with the SA
    email as its Kubernetes USERNAME — see the same statement in ci_rbac.tf:9-12
    — so a `kind: ServiceAccount` subject (which only ever names a
    Kubernetes-native SA in that namespace) binds nothing and the token call
    fails as a 403 on the `serviceaccounts/token` SUBRESOURCE, which is easy to
    misread as "the Role is missing a verb" rather than "the subject never
    matched".
EOT
  type        = string
  default     = ""
}

