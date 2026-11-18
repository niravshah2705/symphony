# ---------------------------------------------------------------------------
# IAM: exactly one grant, and it is a pull permission.
#
# No Workload Identity here, and that is a consequence of the local shape rather
# than an omission: nothing in this stack reaches a Google API. There are no
# FLEXPRICE_S3_* / GCS event-storage settings in deploy/flexprice/compose.yaml, no
# SES, no KMS envelope — the app talks to its own five databases and nothing else.
# `serviceAccount.perComponent` stays false, so no Kubernetes service account is
# annotated with a Google one, and the only Google identity that touches this
# stack from inside the cluster is the node's own, pulling an image.
#
# If event storage is ever turned on, the grant belongs on the component that
# uses it, and the chart already exposes `serviceAccount.components.<x>.annotations`
# for exactly that. It should not be added back here pre-emptively: a binding with
# no consumer is a permission nobody will ever revoke.
# ---------------------------------------------------------------------------

data "google_project" "flexprice" {
  project_id = var.project_id
}

# The nodes pull the app image from var.image_repo. GKE authenticates a node's
# pulls as the pool's service account, which is the project's default compute
# service account because node_config sets no `service_account` (same as every
# other pool in this cluster — see ../terraform-substrate-gke/substrate.tf).
# Without this binding the pods sit in ErrImagePull and the event says
# "You are not allowed to perform this action on this repository", which reads
# like a cluster problem and is a project permission.
resource "google_artifact_registry_repository_iam_member" "flexprice_app_node_reader" {
  count = var.flexprice_enabled ? 1 : 0

  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.flexprice_app[0].name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${data.google_project.flexprice.number}-compute@developer.gserviceaccount.com"
}
