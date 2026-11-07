# =============================================================================
# Substrate multi-tenant GKE — Terraform
# =============================================================================
# The substrate platform stack: the cluster the agent-substrate control plane
# and its worker pools run on, plus the Envoy Gateway / cert-manager fronts that
# publish them. It began life as an imperative port of the OpenShell installers
# (setup_openshell_gke.py / deploy.sh); those scripts and the OpenShell pattern
# they installed are retired, and this root is the substrate config now.
#
# GREENFIELD: the cluster this file was transcribed against no longer exists, so
# an apply CREATES rather than adopts. There is no IMPORT.md runbook to run and
# no `terraform state rm` to perform — an empty state at the prefix below is the
# expected starting condition, not a misconfiguration.
#
# Initialize with a remote state bucket (never local state — same rule as
# ../terraform/versions.tf):
#   terraform init \
#     -backend-config="bucket=<YOUR_TF_STATE_BUCKET>" \
#     -backend-config="prefix=substrate/gke"
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
