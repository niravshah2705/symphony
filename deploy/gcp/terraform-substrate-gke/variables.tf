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
  description = "GKE cluster name. Renamed from openshell-multitenant when OpenShell was retired: nothing live carried the old name (the cluster was destroyed before this root was re-pointed), and the remote state at prefix substrate/gke holds no resources, so this is a create, not a rename."
  type        = string
  default     = "substrate-multitenant"
}

variable "node_pool_name" {
  description = "Name of the dedicated tenant node pool"
  type        = string
  default     = "substrate-node-pool"
}

variable "vpc_name" {
  description = "VPC network name"
  type        = string
  default     = "default"
}

variable "subnet_name" {
  description = "Dedicated subnet name for this cluster"
  type        = string
  default     = "substrate-subnet"
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

variable "cert_email" {
  description = "Email address for ACME / Let's Encrypt certificates"
  type        = string
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

variable "tenant_bindings" {
  description = <<-EOT
    Explicit organization-id -> Substrate atespace bindings, for tenants that this
    root should provision up front. The atespace is a namespace boundary: one
    organization per value, and nothing here is inferred from the shape of an org
    id. Empty by default because the login-triggered environment-init job owns
    binding a live organization (services/provisioner/src/gke-tenant.js) — terraform
    renders this table, it does not read the org database, so that a stale org doc
    can never make a reconcile destroy a namespace that is serving traffic.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = length(distinct(values(var.tenant_bindings))) == length(var.tenant_bindings)
    error_message = "Each organization must bind its own atespace; two organizations in one namespace is not tenancy."
  }
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
  description = "Node pool hosting the platform add-ons, so the tenant pool can drain to zero; the power workflow parks it last"
  type        = string
  default     = "substrate-system-node-pool"
}

variable "system_machine_type" {
  description = "Machine type for the system node pool"
  type        = string
  # e2-standard-2, not e2-standard-4, left no headroom for the bundled
  # PostgreSQL: ate-setup gives postgres-0 a 2 CPU request, which can never
  # schedule on a 2-vCPU node alongside the gateway, cert-manager and the
  # control-plane add-ons, and the install dies waiting for the StatefulSet.
  default     = "e2-standard-4"
}

variable "system_min_nodes" {
  description = "Size of the system node pool when the cluster is started; the power workflow parks it to 0 on stop and deploy.yml feeds the live bounds back, so this is the fresh-stack default"
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
  description = "Provision the Agent Substrate worker pool, namespaces, snapshot storage and actor ingress. This root has no other execution substrate now, so false means the cluster is a bare platform stack with nothing to run agents on. The ate-system control plane is installed by the upstream substrate installer (see docs/SUBSTRATE_INTEGRATION.md), not by this config."
  type        = bool
  default     = false
}

variable "substrate_node_pool_name" {
  description = "Dedicated node pool for Substrate worker pods, isolated from the tenant pool by taint and selector"
  type        = string
  default     = "substrate-worker-pool"
}

variable "substrate_worker_pool_label" {
  description = "Value of the ate.dev/worker-pool node label the actor workerSelector matches. Not the pool name: it must equal what the planner sends as substrateWorkerPool / SUBSTRATE_WORKER_POOL, and a pool that does not carry it schedules no actors."
  type        = string
  default     = "planner-pool"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.substrate_worker_pool_label))
    error_message = "substrate_worker_pool_label must be a lowercase DNS-label-like name."
  }
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

variable "substrate_ingress_hostname" {
  description = "Public hostname fronting the atenet-router actor data plane (substrateIngressUrl). Empty provisions no ingress; a hostname gets its own Envoy data plane bound to the substrate-ip static address."
  type        = string
  default     = ""
}

variable "substrate_ateapi_service" {
  description = "Name of the ateapi Control-plane Service created by `ate-setup deploy ate-system`, used as the control-plane route backend."
  type        = string
  default     = "ateapi"
}

variable "substrate_ateapi_port" {
  description = "Port of the ateapi Control-plane Service, used as the control-plane route backend port."
  type        = number
  default     = 8443
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


# ---------------------------------------------------------------------------
# agentgateway — the in-cluster L7 front in front of LiteLLM (agentgateway.tf)
# ---------------------------------------------------------------------------

variable "agentgateway_enabled" {
  description = "Deploy the agentgateway control plane and its LLM front. Off by default and off in CI until an authenticated Cloud Run <-> GKE path is proven: the mode table stays {langsmith, litellm} either way, so this only decides whether the physical hop exists to be pointed at. See docs/LLM_GATEWAY.md and the risk note in the approved plan."
  type        = bool
  default     = false
}

variable "agentgateway_version" {
  description = "Pinned version for BOTH agentgateway Helm charts (control plane and CRDs). They ship as a pair; two versions in one cluster is an unsupported xDS schema mismatch that surfaces as a Gateway stuck in Accepted=False."
  type        = string
  default     = "v1.7.0"
}

variable "agentgateway_namespace" {
  description = "Namespace for the agentgateway control plane, its CRD release metadata, and its data plane."
  type        = string
  default     = "agentgateway-system"
}

variable "agentgateway_gateway_name" {
  description = "Gateway name. The agentgateway controller names the data plane Deployment AND Service after this value, so it is also the cluster DNS name the egress sidecar reaches: <name>.<agentgateway_namespace>.svc.cluster.local"
  type        = string
  default     = "agentgateway-proxy"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,62}$", var.agentgateway_gateway_name))
    error_message = "agentgateway_gateway_name must be a lowercase DNS label; it becomes the data plane Service name."
  }
}

variable "agentgateway_ingress_hostname" {
  description = "Optional public hostname for the LLM front. Empty keeps the data plane Service ClusterIP, which is the intended posture: this hop holds provider keys. A hostname provisions a static IP (agentgateway-ip), an HTTPS listener and a certificate, and the A record must point at the printed substrate-style output before TLS can issue."
  type        = string
  default     = ""
}

variable "agentgateway_llm_upstream_host" {
  description = "Bare host of the LiteLLM proxy agentgateway forwards to (no scheme, no path), e.g. litellm-proxy-abc123.a.run.app. The egress boundary depends on this being the only LLM target the gateway knows."
  type        = string
  default     = ""

  validation {
    condition     = var.agentgateway_llm_upstream_host == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.agentgateway_llm_upstream_host))
    error_message = "agentgateway_llm_upstream_host must be a bare hostname: no scheme, no port, no path, no credentials."
  }
}

variable "agentgateway_llm_upstream_port" {
  description = "Port of the LiteLLM proxy. 443 for a TLS origin (the Cloud Run default); 8080 only when pointed at a cluster-local Service."
  type        = number
  default     = 443
}

variable "agentgateway_llm_upstream_tls" {
  description = "Forward to LiteLLM over TLS, setting SNI to the upstream host. True for a run.app / public origin; set false only for a cluster-local Service where the mesh or loopback terminates."
  type        = bool
  default     = true
}

variable "agentgateway_provider_key_secret" {
  description = "NAME ONLY of the Secret in the agentgateway namespace holding the LiteLLM key used on the way out. Contents are written by the gw.virtualkey step of environment init, never by terraform: a raw key in config, tfvars or state is readable by anyone with container.admin, which is exactly the identity the CI deployer holds."
  type        = string
  default     = "agentgateway-litellm-key"
}

variable "agentgateway_models" {
  description = <<-EOT
    Model ids the gateway may serve — the allowlist that the tenant's virtual
    key is scoped to. Must equal every `model_name` in
    deploy/litellm/config.yaml, which in turn must equal the `model` field of
    every claude/codex preset in packages/shared/src/agent/model-presets.js.
    deploy/gcp/agentgateway-config.test.js fails CI on drift, because the
    runtime symptom of a missing entry is a 403 in the middle of a coding run.
    Empty renders a deny-everything rule rather than an allow-all rule.
  EOT
  type        = list(string)
  default     = []
}

variable "agentgateway_virtual_keys" {
  description = <<-EOT
    organization-id -> sha256:<hex> hash of that org's agentgateway virtual key.
    Hashes, never keys: the proxy hashes what the client presents and compares,
    so the plaintext key never enters the cluster. Empty means every request
    401s (mode: Strict against zero hashes), which is the correct state for a
    deployment whose gw.virtualkey step has not run. Written by environment
    init; a raw key here is a leaked key, and a rotation is an entry swap.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for k, v in var.agentgateway_virtual_keys : can(regex("^sha256:[0-9a-f]{64}$", v))])
    error_message = "Every agentgateway_virtual_keys value must be a sha256:<64 lowercase hex> hash. Raw keys do not belong in terraform."
  }

  validation {
    condition     = alltrue([for k, _ in var.agentgateway_virtual_keys : can(regex("^[0-9a-z-]{6,64}$", k))])
    error_message = "agentgateway_virtual_keys keys are organization ids and become ConfigMap entry names: lowercase, DNS-safe."
  }
}
