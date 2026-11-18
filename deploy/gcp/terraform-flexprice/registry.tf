# ---------------------------------------------------------------------------
# Artifact Registry — where this stack's own two build artifacts live.
#
# Both exist because nothing here is pullable. `ghcr.io/flexprice/flexprice` is a
# private package (anonymous token request → UNAUTHORIZED, and there is no Docker
# Hub image: hub.docker.com/v2/repositories/flexprice/flexprice → 404), and
# `oci://ghcr.io/flexprice/charts/flexprice` answers 401 to `helm pull`. The
# pinned checkout in deploy/flexprice/VERSION is therefore the only source for
# both, and a build that only exists on a workstation is not a deployment.
#
# The DOCKER repo holds the built app image. The OCI repo holds the *staged*
# chart — the upstream chart with its four subchart dependencies stripped (Helm
# refuses to install a chart whose declared dependencies are not vendored, and
# every one of their conditions is false here) and the template patches described
# in README.md applied. Publishing it as an artifact rather than rebuilding it on
# the apply machine is what makes `terraform apply` on a laptop and in CI install
# the same chart bytes.
#
# Ordering, stated rather than hidden: CI must create these two before it can push
# into them, so the job runs
#   terraform apply -target=google_artifact_registry_repository.flexprice_app
#                   -target=google_artifact_registry_repository.flexprice_chart
# before the build, then the untargeted apply after. That is the only targeted
# apply in this stack, and it is safe in a fresh state prefix — see APPLY.md for
# what to do if a `moved` block ever makes it refuse.
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "flexprice_app" {
  count = var.flexprice_enabled ? 1 : 0

  project       = var.project_id
  location      = var.region
  repository_id = var.image_repo
  format        = "DOCKER"
  description   = "FlexPrice application image, built from the commit pinned in deploy/flexprice/VERSION."
  labels        = merge(local.common_labels, { component = "flexprice" })

  # No immutability field here on purpose: google provider 6.x exposes neither
  # `docker_immutable_tags` nor a tag-immutability argument on this resource
  # (verified against the schema, not guessed). Tag immutability is therefore an
  # out-of-band repository setting, and the pin that actually binds a deploy to
  # a binary is `var.image_digest` — recorded in deploy/flexprice/VERSION
  # alongside the chart sha256. If the provider ever gains the field, set it
  # here rather than leaving the digest as the only proof.

  depends_on = [google_project_service.flexprice_apis]
}

resource "google_artifact_registry_repository" "flexprice_chart" {
  count = var.flexprice_enabled ? 1 : 0

  project       = var.project_id
  location      = var.region
  repository_id = var.chart_repo
  format        = "OCI"
  description   = "Staged FlexPrice Helm chart (subchart dependencies stripped, infra templates patched)."
  labels        = merge(local.common_labels, { component = "flexprice" })

  depends_on = [google_project_service.flexprice_apis]
}

# The APIs this root needs. Enabled here rather than assumed from the root stack:
# this state prefix is applied independently, and `secretmanager.googleapis.com`
# being on is not something a fresh project guarantees.
resource "google_project_service" "flexprice_apis" {
  for_each = var.flexprice_enabled ? toset([
    "artifactregistry.googleapis.com",
    "container.googleapis.com",
    "secretmanager.googleapis.com",
    "compute.googleapis.com",
  ]) : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
