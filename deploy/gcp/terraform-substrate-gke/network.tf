# ---------------------------------------------------------------------------
# GCP service APIs
# ---------------------------------------------------------------------------

resource "google_project_service" "required_apis" {
  for_each = toset([
    "container.googleapis.com",
    "compute.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
  ])

  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Subnet with secondary ranges for Pods / Services
# ---------------------------------------------------------------------------

resource "google_compute_subnetwork" "subnet" {
  name                     = var.subnet_name
  project                  = var.project_id
  region                   = var.region
  network                  = var.vpc_name
  ip_cidr_range            = var.subnet_primary_cidr
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }

  depends_on = [google_project_service.required_apis]
}

# ---------------------------------------------------------------------------
# Cloud Router + Cloud NAT (private node egress)
# ---------------------------------------------------------------------------

resource "google_compute_router" "router" {
  name    = "substrate-router"
  project = var.project_id
  region  = var.region
  network = var.vpc_name

  depends_on = [google_project_service.required_apis]
}

resource "google_compute_router_nat" "nat" {
  name                               = "substrate-nat"
  project                            = var.project_id
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  depends_on = [google_compute_router.router]
}

# ---------------------------------------------------------------------------
# Firewall: HTTP/HTTPS + NodePorts into the VPC
# ---------------------------------------------------------------------------

resource "google_compute_firewall" "allow_http_https" {
  name    = "substrate-allow-http-https"
  project = var.project_id
  network = var.vpc_name

  direction = "INGRESS"
  priority  = 1000

  allow {
    protocol = "tcp"
    ports    = ["80", "443", "30000-32767"]
  }

  source_ranges = ["0.0.0.0/0"]

  depends_on = [google_project_service.required_apis]
}
