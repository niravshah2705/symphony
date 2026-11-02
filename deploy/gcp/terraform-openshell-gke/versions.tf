# =============================================================================
# OpenShell multi-tenant GKE — Terraform
# =============================================================================
# Infrastructure-as-code port of the OpenShell GKE installation
# (setup_openshell_gke.py / deploy.sh from the OpenShell repo).
# Targets the live cluster "openshell-multitenant" in project adlc-9e72f.
#
# Live resources are adopted via the import runbook in IMPORT.md, so this
# config must plan EMPTY against the running cluster once imported.
#
# Initialize with a remote state bucket (never local state — same rule as
# ../terraform/versions.tf):
#   terraform init \
#     -backend-config="bucket=<YOUR_TF_STATE_BUCKET>" \
#     -backend-config="prefix=openshell/gke"
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
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }

  backend "gcs" {}
}
