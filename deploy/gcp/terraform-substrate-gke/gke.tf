# ---------------------------------------------------------------------------
# GKE cluster (zonal) — greenfield apply; the OpenShell-era cluster this file was
# transcribed from no longer exists, so nothing here is reconciled against a
# live resource any more.
# ---------------------------------------------------------------------------

resource "google_container_cluster" "primary" {
  name     = var.cluster_name
  project  = var.project_id
  location = var.zone

  network    = "projects/${var.project_id}/global/networks/${var.vpc_name}"
  subnetwork = google_compute_subnetwork.subnet.id

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

  # Observability at every layer is part of the approved plan, and the per-hop
  # metrics that Stage G added (deploy/gcp/terraform/observability.tf) want the
  # pod-level series this collection provides. That reverses the earlier
  # "nothing reads it" call in #252, which was correct while no dashboard or
  # alert consumed the samples. The cost is real — billed per monitored pod plus
  # samples ingested — so the tell that this is on remains the `gmp-system` and
  # `gke-managed-cim` pods landing on the nodes; if the bill outruns the value,
  # switch these back to false rather than deleting the block, so the choice
  # stays visible in the plan instead of arriving by default.
  monitoring_config {
    managed_prometheus {
      enabled = true
    }

    advanced_datapath_observability_config {
      enable_metrics = true
      enable_relay   = true
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
    google_compute_subnetwork.subnet,
    google_compute_router_nat.nat,
  ]
}

# ---------------------------------------------------------------------------
# Dedicated node pool
# ---------------------------------------------------------------------------
# Two pools, because one pool cannot be parked at zero: the platform add-ons are
# singletons, so they always leave one tenant node non-empty and the autoscaler
# reports it as `no.scale.down.node.pod.kube.system.unmovable`.
#
# Everything that must not land on a tenant node is pinned with a nodeSelector
# on `cloud.google.com/gke-nodepool`. That label is written by GKE itself on
# every node (verified on the live cluster), unlike a node-pool `labels` entry,
# whose propagation to the Node object is not something the scheduling here
# should bet on.
locals {
  system_node_selector = {
    "cloud.google.com/gke-nodepool" = var.system_node_pool_name
  }
}

resource "google_container_node_pool" "primary_nodes" {
  name     = var.node_pool_name
  project  = var.project_id
  location = var.zone
  cluster  = google_container_cluster.primary.name

  # node_count must stay unset while autoscaling is enabled; the start/stop
  # workflow parks this pool at 0 first, then the system pool.
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

# ---------------------------------------------------------------------------
# System pool — the platform add-ons; drained last and parked by the power workflow
# ---------------------------------------------------------------------------

resource "google_container_node_pool" "system_nodes" {
  name     = var.system_node_pool_name
  project  = var.project_id
  location = var.zone
  cluster  = google_container_cluster.primary.name

  # min 1 is the *running* size: it keeps the pinned add-ons on their own pool
  # while the tenant pool drains, which is what lets `stop` finish at all. The
  # power workflow parks this pool at 0 after the tenant pools are gone (the
  # gateway and cert-manager are down for the stopped window), and deploy.yml's
  # gke_reconcile reads the live bounds back so an apply cannot re-buy a node.
  autoscaling {
    min_node_count  = var.system_min_nodes
    max_node_count  = var.system_max_nodes
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
    machine_type = var.system_machine_type
    disk_size_gb = var.disk_size_gb
    disk_type    = var.disk_type
    image_type   = "UBUNTU_CONTAINERD"

    # No node-pool `labels` here: `cloud.google.com/*` is GKE's own label
    # namespace, and the pools are already identified by it on the Node object.
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
