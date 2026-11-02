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
  default     = "e2-standard-4"
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
