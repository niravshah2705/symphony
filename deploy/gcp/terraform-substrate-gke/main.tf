provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_client_config" "default" {}

# Provider 6.x has no certificate_authority export; the GKE API still returns
# master_auth.cluster_ca_certificate for this cluster (verified via
# `gcloud container clusters describe`).
locals {
  cluster_host  = "https://${google_container_cluster.primary.endpoint}"
  cluster_ca    = base64decode(google_container_cluster.primary.master_auth[0].cluster_ca_certificate)
  cluster_token = data.google_client_config.default.access_token
}

provider "kubernetes" {
  host                   = local.cluster_host
  token                  = local.cluster_token
  cluster_ca_certificate = local.cluster_ca
}

provider "helm" {
  kubernetes {
    host                   = local.cluster_host
    token                  = local.cluster_token
    cluster_ca_certificate = local.cluster_ca
  }
}

provider "kubectl" {
  host                   = local.cluster_host
  token                  = local.cluster_token
  cluster_ca_certificate = local.cluster_ca
  load_config_file       = false
}
