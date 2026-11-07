# -----------------------------------------------------------------------------
# Provisioner (Phase 1) — INTERNAL, IAM-gated service that stands up / tears down
# per-tenant Cloud Run stacks on tenant-provision events.
# -----------------------------------------------------------------------------
# GATED OFF by default (var.provisioning_enabled = false): none of this is created
# until a deployment opts in, so the shared stack is unaffected. This holds a
# highly privileged SA (run.admin / pubsub.admin / cloudscheduler.admin /
# serviceAccountUser) — WHY it is a separate internal service, never the gateway.
#
# NOTE: this is Phase-1 scaffolding for a flagged-off feature. Run
# `terraform validate` + a scratch-project apply to finalize before enabling.
# Remaining wiring when enabling (documented, not done here to keep the shared
# stack stable): (a) the org service needs the SAME INTERNAL_API_TOKEN in its env
# to verify the write-back; (b) CI must build+push the provisioner image; (c) the
# provisioner-sa needs serviceAccountUser on the runtime SAs it deploys as.

locals {
  provisioning_on = var.provisioning_enabled
  # What has to EXIST for a tenant-provisioning or environment-init event to be
  # answered at all: the SA, the service, its topic + push subscription, and the
  # secrets it mounts. Environment init publishes its `substrate.atespace` step on
  # this same topic, and the handler answers that action even when the container
  # has PROVISIONING_ENABLED unset (services/provisioner/src/handler.js:44), so a
  # deployment that only wants actors to land in their own namespace still needs
  # the receiver — otherwise every login leaves that step RUNNING forever, waiting
  # on a message that has nowhere to go. The receiver is deliberately a smaller
  # ask than the provisioner's roles: see the split below and var.provisioner_enabled.
  tenant_jobs_on = anytrue([
    var.provisioning_enabled,
    var.provisioner_enabled,
    var.environment_init_enabled,
  ])
  provisioner_tag   = coalesce(var.provisioner_image_tag, var.image_tag, "latest")
  provisioner_image = "${local.image_base}/${var.provisioner_service_name}:${local.provisioner_tag}"
  provisioner_url   = "https://${var.provisioner_service_name}-${local.run_url_suffix}"
}

# --- Provisioner service account + privileged roles ---------------------------
# The account exists for either flag (its topic and service do), but the
# project-level roles below are granted ONLY under provisioning_enabled. That
# split is the point: environment init asks for a namespace on a cluster it
# already has, while standing up a whole per-tenant Cloud Run stack needs
# run.admin + pubsub.admin + cloudscheduler.admin + act-as on the runtime
# identities. A deployment that switched on init must not acquire those.
resource "google_service_account" "provisioner" {
  count        = local.tenant_jobs_on ? 1 : 0
  project      = var.project_id
  account_id   = "provisioner-sa"
  display_name = "AI Fleet provisioner (per-tenant Cloud Run lifecycle)"
}

# run.admin: create/delete per-tenant services + jobs and set their IAM.
resource "google_project_iam_member" "provisioner_run_admin" {
  count   = local.provisioning_on ? 1 : 0
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.provisioner[0].email}"
}

# pubsub.admin: create per-tenant topics + push subscriptions.
resource "google_project_iam_member" "provisioner_pubsub_admin" {
  count   = local.provisioning_on ? 1 : 0
  project = var.project_id
  role    = "roles/pubsub.admin"
  member  = "serviceAccount:${google_service_account.provisioner[0].email}"
}

# cloudscheduler.admin: create per-tenant scheduler ticks.
resource "google_project_iam_member" "provisioner_scheduler_admin" {
  count   = local.provisioning_on ? 1 : 0
  project = var.project_id
  role    = "roles/cloudscheduler.admin"
  member  = "serviceAccount:${google_service_account.provisioner[0].email}"
}

# serviceAccountUser on each runtime SA: deploying a service that runs AS that SA
# requires actAs on it. Scoped per-SA (least privilege), not project-wide.
resource "google_service_account_iam_member" "provisioner_actas" {
  for_each = local.provisioning_on ? merge(
    {
      gateway = google_service_account.gateway.name
      planner = google_service_account.planner.name
      coder   = google_service_account.coder.name
      push    = google_service_account.pubsub_push.name
    },
    local.pipeline_on ? {
      orchestrator = google_service_account.orchestrator[0].name
      tester       = google_service_account.tester[0].name
      deployer     = google_service_account.deployer[0].name
    } : {},
  ) : {}
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.provisioner[0].email}"
}

# --- Shared internal S2S token (Secret Manager) -------------------------------
# One shared token guards every token-scoped internal surface:
#   - the provisioner's org write-back (PATCH /internal/orgs/{id}/deployments),
#   - the egress proxy's per-org secret resolve (GET /internal/s2s/orgs/{id}/secrets
#     on the settings service), and
#   - the billing auto-recharge Job's org read (GET /internal/orgs/{id}/billing-context
#     on the org service).
# It is therefore NOT gated on provisioning — it exists whenever a value is set,
# so the proxy↔settings S2S works on the shared stack too. Only the
# provisioner-sa accessor stays provisioning-gated (that SA exists only then).
resource "google_secret_manager_secret" "internal_api_token" {
  count     = var.internal_api_token != "" ? 1 : 0
  project   = var.project_id
  secret_id = "internal-api-token"
  labels    = merge(local.common_labels, { component = "shared" })
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "internal_api_token" {
  count       = var.internal_api_token != "" ? 1 : 0
  secret      = google_secret_manager_secret.internal_api_token[0].id
  secret_data = var.internal_api_token
}

resource "google_secret_manager_secret_iam_member" "provisioner_internal_token" {
  count     = local.tenant_jobs_on && var.internal_api_token != "" ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.internal_api_token[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.provisioner[0].email}"
}

resource "google_secret_manager_secret_iam_member" "provisioner_org_s2s_signing_key" {
  count     = local.tenant_jobs_on ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.org_s2s_signing_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.provisioner[0].email}"
}

# --- tenant-provision topic + push subscription -------------------------------
resource "google_pubsub_topic" "tenant_provision" {
  count      = local.tenant_jobs_on ? 1 : 0
  project    = var.project_id
  name       = var.provisioning_topic
  labels     = merge(local.common_labels, { component = "provisioner" })
  depends_on = [google_project_service.services]
}

# The org service is the publisher on this topic: a tenant-provisioning trigger
# and every environment-init `substrate.atespace` step go out from there using the
# org SA's own ADC (services/org/app/services/provisioning_service.py
# publish_provisioning_request). There was no grant here, so the publish was a
# Permission denied at run time with nothing in the plan to explain it — and the
# symptom was an init step parked in RUNNING, which reads as slowness. Scoped to
# this one topic rather than project-wide: the org SA authenticates users and owns
# no other publishing path.
resource "google_pubsub_topic_iam_member" "org_publish_tenant_provision" {
  count   = local.tenant_jobs_on ? 1 : 0
  project = var.project_id
  topic   = google_pubsub_topic.tenant_provision[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.org.email}"
}

resource "google_cloud_run_v2_service_iam_member" "push_invokes_provisioner" {
  count    = local.tenant_jobs_on ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.provisioner[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

resource "google_pubsub_subscription" "tenant_provision_push" {
  count   = local.tenant_jobs_on ? 1 : 0
  project = var.project_id
  name    = "${var.provisioning_topic}-push"
  topic   = google_pubsub_topic.tenant_provision[0].id
  labels  = merge(local.common_labels, { component = "provisioner" })

  ack_deadline_seconds = var.ack_deadline_seconds

  push_config {
    push_endpoint = "${local.provisioner_url}/pubsub/tenant-provision"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.provisioner_url
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = var.max_delivery_attempts
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  depends_on = [
    google_cloud_run_v2_service.provisioner,
    google_cloud_run_v2_service_iam_member.push_invokes_provisioner,
    google_service_account_iam_member.pubsub_agent_token_creator,
  ]
}

# --- Provisioner Cloud Run service (internal) ---------------------------------
resource "google_cloud_run_v2_service" "provisioner" {
  count               = local.tenant_jobs_on ? 1 : 0
  project             = var.project_id
  name                = var.provisioner_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "provisioner" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.provisioner[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.container_concurrency
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = local.provisioner_image

      dynamic "env" {
        for_each = merge(
          local.common_env,
          {
            # The container's own switch, not the infra's: with
            # environment_init_enabled on and provisioning_enabled off this
            # service exists to answer `substrate-atespace` and nothing else,
            # which is exactly the branch services/provisioner/src/index.js:142
            # takes. Hardcoding "true" here would silently grant tenant-stack
            # creation to an init-only deployment.
            PROVISIONING_ENABLED     = tostring(var.provisioning_enabled)
            MESSAGING_MODE           = "pubsub"
            GCP_PROJECT_ID           = var.project_id
            GCP_REGION               = var.region
            ORG_URL                  = local.org_url
            SETTINGS_URL             = local.settings_url
            STREAM_TOKEN_SERVICE_URL = google_cloud_run_v2_service.stream_token_broker.uri
            SPA_ORIGIN               = var.spa_origin
            FIREBASE_CUSTOM_DOMAIN   = join(",", local.custom_domains)
            FIREBASE_PROJECT_ID      = var.project_id
            PUBSUB_PUSH_AUDIENCE     = local.provisioner_url
            PUBSUB_PUSH_SA           = google_service_account.pubsub_push.email
            PUBSUB_DEADLETTER_TOPIC  = var.dead_letter_topic
            EMAIL_TOPIC              = google_pubsub_topic.email.name
            # Names of the SHARED services to clone images/secrets/config from.
            GATEWAY_SERVICE_NAME      = var.gateway_service_name
            PLANNER_SERVICE_NAME      = var.planner_service_name
            CODER_SERVICE_NAME        = var.coder_service_name
            CODER_JOB_NAME            = var.coder_job_name
            ORCHESTRATOR_SERVICE_NAME = var.orchestrator_service_name
            TESTER_SERVICE_NAME       = var.tester_service_name
            DEPLOYER_SERVICE_NAME     = var.deployer_service_name
            INTERNAL_INGRESS          = var.internal_ingress
            # Runtime SAs the per-tenant services run as.
            GATEWAY_SA = google_service_account.gateway.email
            PLANNER_SA = google_service_account.planner.email
            CODER_SA   = google_service_account.coder.email
          },
          local.pipeline_on ? {
            ORCHESTRATOR_SA = google_service_account.orchestrator[0].email
            TESTER_SA       = google_service_account.tester[0].email
            DEPLOYER_SA     = google_service_account.deployer[0].email
          } : {},
          # The atespace step is a call to the substrate control plane, so this is
          # the workload that most needs SUBSTRATE_URL — without it the handler
          # answers every step SKIPPED ("no substrate control plane configured")
          # and the org's init run sits at RUNNING-then-skipped forever.
          local.substrate_control_env,
        )
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "ORG_S2S_SIGNING_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.org_s2s_signing_key.secret_id
            version = "latest"
          }
        }
      }

      # One env block per existing internal-api-token secret (0 or 1). Driving
      # for_each off the secret's own splat avoids a [0] index into a count=0
      # resource and a conditional for_each that Terraform 1.9.x mis-types.
      dynamic "env" {
        for_each = toset(google_secret_manager_secret.internal_api_token[*].secret_id)
        content {
          name = "INTERNAL_API_TOKEN"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      resources {
        limits   = { cpu = var.cloud_run_service_cpu, memory = "512Mi" }
        cpu_idle = true
      }
    }
  }

  depends_on = [
    google_project_iam_member.provisioner_run_admin,
    google_project_iam_member.provisioner_pubsub_admin,
    google_project_iam_member.provisioner_scheduler_admin,
    google_service_account_iam_member.provisioner_actas,
    google_secret_manager_secret_iam_member.provisioner_org_s2s_signing_key,
  ]
}
