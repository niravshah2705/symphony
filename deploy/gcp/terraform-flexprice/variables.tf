# -----------------------------------------------------------------------------
# Inputs. Anything that decides WHAT runs is a variable; anything that only
# names an object has a default here and is left alone, because a renamed Secret
# or StorageClass is a destroy-and-recreate of a database, not a preference.
# -----------------------------------------------------------------------------

variable "project_id" {
  type        = string
  description = "GCP project hosting the cluster, Artifact Registry and Secret Manager."
}

variable "region" {
  type        = string
  description = "Region for the static IP and the state bucket. Storage is zonal, so this is not where the pods run — see var.zone."
  default     = "asia-south1"
}

variable "zone" {
  type        = string
  description = "The cluster's zone. The node pool and every PersistentDisk are zonal, so this must equal the cluster's location, not the region."
  default     = "asia-south1-a"
}

variable "cluster_name" {
  type = string
  # Read, never created. `substrate-multitenant` is the only cluster this repo
  # runs, and reusing it is a decision, not a default: a second cluster would
  # need its own Envoy Gateway, cert-manager, issuer and snapshot classes before
  # a single FlexPrice pod could schedule.
  description = "Existing GKE cluster to install into. Owned by ../terraform-substrate-gke."
  default     = "substrate-multitenant"
}

variable "system_node_pool_name" {
  type = string
  # The front's Envoy pods belong on the ingress pool, not on the FlexPrice pool:
  # one Envoy per front with the cluster's other fronts, and a data plane that
  # keeps working when the database pool is busy migrating. Created by
  # ../terraform-substrate-gke; the name is read here, never asserted.
  description = "Existing pool that hosts Envoy Gateway data planes."
  default     = "substrate-system-node-pool"
}

variable "flexprice_enabled" {
  type        = bool
  description = "Build the FlexPrice stack at all. False renders every resource in this root zero-count, which is how the module stays reviewable before it is real."
  default     = true
}

variable "namespace" {
  type        = string
  description = "Namespace the releases, Jobs and (when published) the certificate live in."
  default     = "flexprice"
}

# --- Supply chain -------------------------------------------------------------
# Both artifacts are built from ONE pinned checkout (deploy/flexprice/VERSION).
# They cannot be pulled: `ghcr.io/flexprice/flexprice` is a private package and
# `oci://ghcr.io/flexprice/charts/flexprice` answers 401 to an anonymous token
# request. So the CI job builds the image, stages the chart, and pushes both here.

variable "image_repo" {
  type        = string
  description = "Artifact Registry (DOCKER) repository the flexprice-app image is built into."
  default     = "flexprice-app"
}

variable "chart_repo" {
  type        = string
  description = "Artifact Registry (OCI) repository the staged FlexPrice Helm chart is pushed to."
  default     = "flexprice-chart"
}

variable "chart_version" {
  type = string
  # A chart whose templates were patched is not the upstream chart, so its
  # version is ours to pin rather than inherited: an accidental `>=` would pull a
  # different template set than the one the probe widening was derived from.
  description = "Exact version of the staged chart in var.chart_repo. Must match the version CI pushed from the pinned commit."
  default     = "1.10.0+fleet.1"
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+[0-9A-Za-z+.\\-]*$", var.chart_version))
    error_message = "chart_version must be an exact SemVer (optionally with a build suffix), not a range."
  }
}

variable "image_digest" {
  type = string
  # The chart honours this: templates/_helpers.tpl `flexprice.image` renders
  # `repository@digest` whenever `.Values.image.digest` is non-empty and only
  # falls back to `tag | .Chart.AppVersion` otherwise. Pinning a digest is
  # therefore expressible without patching anything, and it is what makes a
  # re-apply reproduce the binary that was probed.
  description = "sha256 digest of the built flexprice-app image. The chart's image helper prefers a digest over a tag."
  default     = ""
  validation {
    condition     = var.image_digest == "" || can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be empty or a sha256:<64 hex> digest."
  }
}

variable "image_tag" {
  type = string
  # Not merely cosmetic next to a digest. templates/jobs/migration.yaml hashes
  # `flexprice.env` PLUS `<repository>:<tag | .Chart.AppVersion>` into the Job's
  # NAME, and this chart's appVersion is the constant "1.0.0". With an empty tag
  # the suffix therefore only moves when the environment moves, and a bump that
  # changes the image but not the config reuses a completed Job name — the new
  # image's versioned migrations never run, and nothing in the app complains
  # because /health does not read the schema. Always set the tag alongside the
  # digest.
  description = "Tag of the built flexprice-app image. Set even when image_digest is present: it is part of the migration Job's name hash."
  default     = ""
}

variable "image_registry_prefix" {
  type = string
  # The five infrastructure images (postgres, clickhouse-server, cp-kafka, redis,
  # temporalio/auto-setup + admin-tools) are third-party and pull from Docker Hub
  # by default, which is how this cluster already runs Envoy Gateway. Docker Hub
  # throttles anonymous pulls per source IP, and GKE nodes share one, so a
  # rate-limited pull is a rollout that fails on the cluster's egress IP rather
  # than on its configuration. Set this to an Artifact Registry Docker-mount or
  # mirror repo prefix (e.g. "asia-south1-docker.pkg.dev/<project>/docker-mirror")
  # to route every one of them through it.
  description = "Registry prefix that replaces docker.io for the infrastructure images. Empty keeps upstream references."
  default     = ""
  validation {
    condition     = var.image_registry_prefix == "" || can(regex("^[a-z0-9.\\-]+/[a-z0-9\\-]+/[a-z0-9\\-]+$", var.image_registry_prefix))
    error_message = "image_registry_prefix must be empty or a host/project/repository prefix with no trailing slash."
  }
}

# --- Placement --------------------------------------------------------------

variable "node_pool_name" {
  type = string
  # Deliberately NOT one of the names .github/workflows/substrate-cluster-power.yml
  # parks. The substrate pools sleep at 03:00; a parked pool holding a ClickHouse
  # or Kafka quorum does not come back as a quorum. deploy/gcp/flexprice-infra.test.js
  # asserts this name is absent from that workflow's pool variables.
  description = "Dedicated node pool for FlexPrice. Must never be named by the substrate power workflow's SUBSTRATE_NODE_POOL / SUBSTRATE_SYSTEM_NODE_POOL."
  default     = "flexprice-pool"
}

variable "node_machine_type" {
  type        = string
  description = "Machine type for the pool. 4 vCPU / 16 GiB is what the four stores plus three apps fit into with headroom for the probe timeouts."
  default     = "e2-standard-4"
}

variable "node_min_count" {
  type = number
  # 1, not 0. A parked pool cannot serve a cold Kafka/ClickHouse quorum, and the
  # StatefulSets below have no placement anywhere else. Cost is the honest
  # argument for 0 and the data plane is the honest argument against it; the
  # AGPL gate keeps this pool off the money path while that is decided.
  description = "Minimum nodes. Below 1 the databases have nowhere to schedule, so the release cannot converge."
  default     = 1
  validation {
    condition     = var.node_min_count >= 1
    error_message = "node_min_count must be at least 1: the infrastructure StatefulSets have no other pool to land on."
  }
}

variable "node_max_count" {
  type        = number
  description = "Maximum nodes for the autoscaler. Kept small: one zonal pool with Retain volumes does not gain anything from spreading."
  default     = 3
}

variable "node_disk_gb" {
  type        = number
  description = "Boot disk size for pool nodes. Image cache lives here; the data lives in the PVCs."
  default     = 100
}

# --- Storage ----------------------------------------------------------------

variable "storage_class_name" {
  type = string
  # Chart-owned, not Terraform-owned: templates/storage/storageclass-retain.yaml
  # creates this class when dataProtection.retainStorage is on, wires every
  # in-cluster component to it through `flexprice.componentStorageClass`, and
  # carries helm.sh/resource-policy: keep so `helm uninstall` leaves the PVs
  # alone. Declaring the same class in Terraform as well is how one object gets
  # two owners and a conflicting field manager.
  description = "StorageClass the chart creates for FlexPrice's volumes. Changing it after the first install orphans existing PVCs."
  default     = "flexprice-retained"
  validation {
    condition     = can(regex("^[a-z0-9.\\-]+$", var.storage_class_name))
    error_message = "storage_class_name must be a lowercase DNS-label-compatible name."
  }
}

variable "postgres_size" {
  type        = string
  description = "Postgres volume size. Mirrors the local shape; billing metadata is small."
  default     = "5Gi"
}

variable "clickhouse_size" {
  type        = string
  description = "ClickHouse volume size — the usage-event store, and the one that grows."
  default     = "5Gi"
}

variable "kafka_size" {
  type        = string
  description = "Kafka volume size. Retention is 7 days by configuration, so this bounds backlog rather than history."
  default     = "5Gi"
}

variable "redis_size" {
  type        = string
  description = "Redis volume size. Cache only."
  default     = "1Gi"
}

# --- Public front -----------------------------------------------------------

variable "ingress_hostname" {
  type = string
  # Empty keeps the whole front at count 0: address, issuer, certificate,
  # Gateway, HTTPRoute. The stack is then reachable only inside the VPC, which is
  # the correct first state — an HTTPS front for a billing API is a decision about
  # exposure, and it should be made after the data plane works.
  #
  # Setting it produces one DNS obligation, surfaced as the flexprice_dns_hint
  # output: the A record for this hostname must point at the module's static IP
  # before cert-manager can answer HTTP-01. Nothing in this repo writes Cloud DNS.
  description = "Fully-qualified public hostname for the FlexPrice API. Empty means no public front."
  default     = ""
  validation {
    condition     = var.ingress_hostname == "" || can(regex("^[a-z0-9]([a-z0-9\\-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9\\-]*[a-z0-9])?)+$", var.ingress_hostname))
    error_message = "ingress_hostname must be empty or a lowercase FQDN."
  }
}

variable "cert_email" {
  type        = string
  description = "ACME account contact for this front's Issuer. Let's Encrypt expiry notices go here."
  default     = ""
}

variable "static_ip_name" {
  type        = string
  description = "Name of the regional static address the front's Envoy Service is pinned to. Create the A record for var.ingress_hostname at its address."
  default     = "flexprice-ip"
}
