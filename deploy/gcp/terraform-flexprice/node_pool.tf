# ---------------------------------------------------------------------------
# Dedicated node pool
#
# Separate from `substrate-nodes` / the system pool for one reason beyond tidiness:
# the power workflow stops the pools it knows by name at 03:00. FlexPrice's
# databases are zonal PersistentDisks with a single replica each, so a stopped
# pool is not a paused workload — it is a ClickHouse that comes back as an
# unrecoverable write-ahead state and a Kafka whose cluster id is stored in a
# volume the returned node no longer matches. Keeping this pool's name out of
# that workflow's inputs is a structural guarantee, and
# deploy/gcp/flexprice-infra.test.js is what keeps it true.
# ---------------------------------------------------------------------------

resource "google_container_node_pool" "flexprice" {
  count = var.flexprice_enabled ? 1 : 0

  name     = var.node_pool_name
  project  = var.project_id
  location = var.zone
  cluster  = var.cluster_name

  autoscaling {
    min_node_count  = var.node_min_count
    max_node_count  = var.node_max_count
    location_policy = "BALANCED"
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  upgrade_settings {
    strategy        = "SURGE"
    max_surge       = 1
    max_unavailable = 0
  }

  node_config {
    machine_type = var.node_machine_type
    disk_size_gb = var.node_disk_gb
    # COS here for the same reason the substrate worker pool uses it: it is the
    # image GKE's node auto-repair and container-optimised tooling assume.
    image_type = "COS_CONTAINERD"

    # GCE instance labels reject the dotted fleet.dev/* keys, so this pool takes
    # the underscore form (see main.tf: same facts, GCP-legal shape).
    labels = local.gcp_labels

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    metadata = {
      disable-legacy-endpoints = "true"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    shielded_instance_config {
      enable_integrity_monitoring = true
      enable_secure_boot          = false
    }

    # The taint is what makes the pool dedicated rather than merely named. Every
    # release carries the matching toleration in values/base.yaml, so forgetting
    # one leaves its pods Pending with a taint-and-toleration event instead of
    # quietly sharing a node with an actor plane.
    taint {
      key    = "fleet.dev/dedicated"
      value  = "flexprice"
      effect = "NO_SCHEDULE"
    }
  }

  # The cluster is read, so nothing here waits on cluster creation — but the
  # pool must exist before anything can schedule into it, which is why every
  # release below depends_on it.
  depends_on = [data.google_container_cluster.substrate]
}
