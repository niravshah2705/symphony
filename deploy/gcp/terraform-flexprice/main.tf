provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_client_config" "default" {}

# The cluster belongs to ../terraform-substrate-gke. Read, never managed: a
# second owner would fight the first over node pools, and `terraform destroy`
# here must be incapable of taking the substrate control plane down.
data "google_container_cluster" "substrate" {
  count    = var.flexprice_enabled ? 1 : 0
  project  = var.project_id
  location = var.zone
  name     = var.cluster_name
}

# Same construction as ../terraform-substrate-gke/main.tf, with the cluster
# swapped for the data source. The token is the CI identity's own access token,
# so every object created here is created by whoever ran the apply — which is
# what makes the RBAC in ci_rbac.tf (there) the whole story.
locals {
  cluster_host  = var.flexprice_enabled ? "https://${data.google_container_cluster.substrate[0].endpoint}" : ""
  cluster_ca    = var.flexprice_enabled ? base64decode(data.google_container_cluster.substrate[0].master_auth[0].cluster_ca_certificate) : ""
  cluster_token = data.google_client_config.default.access_token

  common_labels = {
    "fleet.dev/managed-by" = "terraform"
    "fleet.dev/component"  = "billing"
    "fleet.dev/root"       = "terraform-flexprice"
  }

  # The same three facts in the shape GCP labels accept: a GCP label key may not
  # contain '.', so feeding common_labels to a repository, secret or node pool is
  # a 400 at apply time, not a plan error. Kubernetes objects keep common_labels —
  # there the dot is the namespace separator that makes the key legal.
  gcp_labels = {
    fleet_dev_managed_by = "terraform"
    fleet_dev_component  = "billing"
    fleet_dev_root       = "terraform-flexprice"
  }
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
