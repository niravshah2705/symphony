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
  description = "Node pool hosting the platform add-ons, so the tenant pool can drain to zero; the power workflow parks it last"
  type        = string
  default     = "openshell-system-node-pool"
}

variable "system_machine_type" {
  description = "Machine type for the system node pool"
  type        = string
  default     = "e2-standard-2"
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

