# =============================================================================
# Self-hosted FlexPrice — Terraform
# =============================================================================
# The billing platform, installed the way it is designed to be installed: the
# upstream Helm chart, three releases, on the cluster the substrate root already
# owns. Before this root the same chart only ever ran on a workstation — see
# deploy/flexprice/README.md and scripts/flexprice-helm.js, which stay the
# development path and are what this port was verified against.
#
# This root deliberately does NOT create the cluster. `substrate-multitenant` is
# owned by ../terraform-substrate-gke and is read here through a data source, so
# destroying this stack can never take a cluster (or an actor plane) with it. The
# consequence is a real ordering dependency, not a formality: Envoy Gateway,
# cert-manager, the `eg` GatewayClass and the namespace this stack installs into
# must already exist, and `gke.tf` there must have been applied before `apply`
# runs here. APPLY.md states the check.
#
# Initialize with a remote state bucket (never local state — same rule as
# ../terraform/versions.tf), under its own prefix so this stack's destroys and
# the substrate root's never share a plan:
#   terraform init \
#     -backend-config="bucket=<YOUR_TF_STATE_BUCKET>" \
#     -backend-config="prefix=substrate/flexprice"
# =============================================================================

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.30"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.13"
    }
    kubectl = {
      source  = "gavinbunney/kubectl"
      version = ">= 1.19"
    }
  }

  backend "gcs" {}
}
