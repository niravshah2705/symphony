# ---------------------------------------------------------------------------
# GKE cluster (zonal) — matches live openshell-multitenant config
# ---------------------------------------------------------------------------

resource "google_container_cluster" "primary" {
  name     = var.cluster_name
  project  = var.project_id
  location = var.zone

  network    = "projects/${var.project_id}/global/networks/${var.vpc_name}"
  subnetwork = google_compute_subnetwork.openshell_subnet.id

  deletion_protection = var.deletion_protection

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
  }

  master_authorized_networks_config {
    cidr_blocks {
      cidr_block   = var.master_authorized_networks_cidr
      display_name = "Allowed Networks"
    }
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Dataplane V2 — tenant NetworkPolicies are enforced by this, so the legacy
  # networkPolicy addon stays disabled (matches live).
  datapath_provider = "ADVANCED_DATAPATH"

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  release_channel {
    channel = "REGULAR"
  }

  addons_config {
    dns_cache_config {
      enabled = true
    }
    gce_persistent_disk_csi_driver_config {
      enabled = true
    }
    gcp_filestore_csi_driver_config {
      enabled = true
    }
    network_policy_config {
      disabled = true
    }
  }

  # The dedicated node pool below is authoritative.
  remove_default_node_pool = true
  initial_node_count       = 1

  lifecycle {
    ignore_changes = [
      initial_node_count,
      remove_default_node_pool,
    ]
  }

  depends_on = [
    google_project_service.required_apis,
    google_compute_subnetwork.openshell_subnet,
    google_compute_router_nat.nat,
  ]
}

# ---------------------------------------------------------------------------
# Dedicated node pool
# ---------------------------------------------------------------------------

resource "google_container_node_pool" "primary_nodes" {
  name     = var.node_pool_name
  project  = var.project_id
  location = var.zone
  cluster  = google_container_cluster.primary.name

  # node_count must stay unset while autoscaling is enabled; the start/stop
  # workflow only touches min/max.
  autoscaling {
    min_node_count  = var.min_nodes
    max_node_count  = var.max_nodes
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
    machine_type = var.machine_type
    disk_size_gb = var.disk_size_gb
    disk_type    = var.disk_type
    image_type   = "UBUNTU_CONTAINERD"

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

    kubelet_config {
      insecure_kubelet_readonly_port_enabled = "FALSE"
      max_parallel_image_pulls               = 2
    }
  }

  depends_on = [google_container_cluster.primary]
}
