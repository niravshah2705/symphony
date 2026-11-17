# -----------------------------------------------------------------------------
# Durable fixed pipeline — the orchestrator (the single internal agent service:
# browser agent surface + legacy planner queue + plan/code/test stage handlers +
# substrate control plane) and the brokered deployer service, over eight
# stage-specific Pub/Sub channels. The orchestrator is unconditional; the
# deployer and the stage channels remain rollout-gated.
# -----------------------------------------------------------------------------

locals {
  pipeline_on = var.pipeline_orchestrator_enabled

  # The orchestrator IS the agent workload now: it absorbed the retired
  # planner's browser surface + queue and the coder-control/tester stage
  # handlers, so it carries their env: the egress sidecar pair, the skills and
  # memory mounts, and the substrate env. Per substrate.tf, the orchestrator
  # gets the FULL local.substrate_env (control plane + the actor-callback pair,
  # because actors call /internal/plan/run back on this service); the deployer
  # is a stage executor inside the boundary and gets none of it. NEVER set
  # SUBSTRATE_ACTOR_MODE here as a plain env on a normal deployment — it comes
  # only through substrate_actor_env, which is all-or-nothing with the matching
  # run.invoker binding in iam.tf.
  orchestrator_env = merge(local.common_env, local.egress_env, local.skills_env, local.memory_env, local.substrate_env, {
    ORCHESTRATOR_SERVICE_PORT       = "8080"
    AGENT_SERVICE_PORT              = "8080"
    ORCHESTRATOR_URL                = local.orchestrator_url
    AGENT_URL                       = local.orchestrator_url
    SETTINGS_URL                    = local.settings_url
    ORG_URL                         = local.org_url
    EMAIL_TOPIC                     = google_pubsub_topic.email.name
    PIPELINE_STORE_BACKEND          = "firestore"
    PIPELINE_RESULTS_AUDIENCE       = local.orchestrator_url
    PIPELINE_RESULTS_ALLOWED_EMAILS = google_service_account.pubsub_push.email
    PUBSUB_PUSH_AUDIENCE            = local.orchestrator_url
    PUBSUB_PUSH_SA                  = google_service_account.pubsub_push.email
    }, local.pipeline_on ? {
    PUBSUB_PIPELINE_PLAN_RESULTS_TOPIC = var.pipeline_plan_results_topic
    PUBSUB_PIPELINE_CODE_RESULTS_TOPIC = var.pipeline_code_results_topic
    PUBSUB_PIPELINE_TEST_RESULTS_TOPIC = var.pipeline_test_results_topic
    PIPELINE_STAGE_STORE_BACKEND       = "firestore"
  } : {})

  deployer_env = merge(local.common_env, local.egress_env, {
    DEPLOYER_SERVICE_PORT                = "8080"
    DEPLOYER_PORT                        = "8080"
    SETTINGS_URL                         = local.settings_url
    ORG_URL                              = local.org_url
    ORCHESTRATOR_URL                     = local.orchestrator_url
    PUBSUB_PIPELINE_DEPLOY_RESULTS_TOPIC = var.pipeline_deploy_results_topic
    PIPELINE_STAGE_STORE_BACKEND         = "firestore"
    PUBSUB_PUSH_AUDIENCE                 = local.deployer_url
    PUBSUB_PUSH_SA                       = google_service_account.pubsub_push.email
  })
}

check "pipeline_agent_egress_is_brokered" {
  assert {
    condition     = trimspace(nonsensitive(var.internal_api_token)) != ""
    error_message = "mandatory egress proxying requires a non-empty internal_api_token for proxy-to-settings authentication."
  }
}

check "deployment_requires_pipeline" {
  assert {
    condition     = !var.pipeline_deployment_enabled || var.pipeline_orchestrator_enabled
    error_message = "pipeline_deployment_enabled cannot be true while the durable pipeline is disabled."
  }
}

check "pipeline_topics_are_dedicated" {
  assert {
    condition = length(distinct([
      var.planner_topic,
      var.pipeline_plan_topic,
      var.pipeline_code_topic,
      var.pipeline_test_topic,
      var.pipeline_deploy_topic,
      var.pipeline_plan_results_topic,
      var.pipeline_code_results_topic,
      var.pipeline_test_results_topic,
      var.pipeline_deploy_results_topic,
    ])) == 9
    error_message = "Pipeline command/result topics must be stage-specific, unique, and must not reuse the legacy planner topic."
  }
}

# --- Trust roles --------------------------------------------------------------

# Unconditional: the orchestrator serves the browser agent surface and the
# legacy planner queue even when the durable pipeline flag is off — the
# gateway's AGENT_URL points here and nothing else answers those routes.
resource "google_service_account" "orchestrator" {
  project      = var.project_id
  account_id   = "pipeline-orchestrator-sa"
  display_name = "AI Fleet orchestrator + agent surface"
}

resource "google_service_account" "deployer" {
  count        = local.pipeline_on ? 1 : 0
  project      = var.project_id
  account_id   = "pipeline-deployer-sa"
  display_name = "AI Fleet brokered pipeline deployer"
}

resource "google_project_iam_member" "orchestrator_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.orchestrator.email}"
}

resource "google_project_iam_member" "deployer_datastore" {
  count   = local.pipeline_on ? 1 : 0
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Agent sidecars resolve managed/customer credentials through settings. The
# resolver token is scoped to the exact container that needs it; pipeline
# identities receive no Secret Manager accessor role.
resource "google_cloud_run_v2_service_iam_member" "pipeline_proxy_invokes_settings" {
  for_each = local.pipeline_on ? {
    orchestrator = google_service_account.orchestrator.email
    deployer     = google_service_account.deployer[0].email
    } : {
    orchestrator = google_service_account.orchestrator.email
  }
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.settings.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}

# --- Cloud Run control/data plane --------------------------------------------

resource "google_cloud_run_v2_service" "orchestrator" {
  project             = var.project_id
  name                = var.orchestrator_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "pipeline-orchestrator" })
  deletion_protection = false

  lifecycle {
    precondition {
      condition     = var.container_concurrency == 1 || try(tonumber(var.cloud_run_proxy_cpu) >= 1, false)
      error_message = "container_concurrency values above 1 require cloud_run_proxy_cpu to be at least 1 vCPU when the egress proxy is enabled."
    }
    precondition {
      condition     = !local.pipeline_on || var.min_instances <= 1
      error_message = "with pipeline_orchestrator_enabled, the orchestrator caps at one instance for synchronous stage execution; min_instances must be 0 or 1 to match."
    }
  }

  template {
    service_account                  = google_service_account.orchestrator.email
    timeout                          = "3600s"
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = var.container_concurrency

    scaling {
      min_instance_count = var.min_instances
      # Stage execution is synchronous and the pipeline caps at one instance
      # when enabled; otherwise the shared ceiling applies.
      max_instance_count = local.pipeline_on ? 1 : var.max_instances
    }

    # Versioned skills bundle mounted read-only via gcsfuse (skills.tf).
    dynamic "volumes" {
      for_each = local.skills_mount_enabled ? [1] : []
      content {
        name = "skills"
        gcs {
          bucket    = google_storage_bucket.skills[0].name
          read_only = true
        }
      }
    }

    # Cloud SQL Auth Proxy socket + the connection-string secret file
    # (memory.tf). A secret FILE (not secret env) keeps agent primaries
    # secret-env-free (requireSecretFreePrimary).
    dynamic "volumes" {
      for_each = local.memory_enabled ? [1] : []
      content {
        name = "cloudsql"
        cloud_sql {
          instances = [google_sql_database_instance.memory[0].connection_name]
        }
      }
    }

    dynamic "volumes" {
      for_each = local.memory_enabled ? [1] : []
      content {
        name = "memory-db-url"
        secret {
          secret = google_secret_manager_secret.memory_database_url[0].secret_id
          items {
            version = "latest"
            path    = "url"
          }
        }
      }
    }

    containers {
      name       = "app"
      image      = local.orchestrator_image
      depends_on = ["egress-proxy"]

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = local.orchestrator_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "volume_mounts" {
        for_each = local.skills_mount_enabled ? [1] : []
        content {
          name       = "skills"
          mount_path = "/skills"
        }
      }
      dynamic "volume_mounts" {
        for_each = local.memory_enabled ? [1] : []
        content {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
      dynamic "volume_mounts" {
        for_each = local.memory_enabled ? [1] : []
        content {
          name       = "memory-db-url"
          mount_path = "/secrets/memory-db"
        }
      }

      resources {
        limits            = { cpu = var.cloud_run_service_cpu, memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }

    containers {
      name  = "egress-proxy"
      image = local.proxy_image

      dynamic "env" {
        for_each = local.proxy_plain_env
        content {
          name  = env.key
          value = env.value
        }
      }
      # Managed keys are resolved by the settings service (single source) and
      # returned over the S2S the invoker binding below opens — the sidecar
      # mounts no provider secret.
      env {
        name  = "INTERNAL_API_TOKEN"
        value = var.internal_api_token
      }
      startup_probe {
        http_get {
          path = "/healthz"
          port = 4030
        }
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 3
        failure_threshold     = 20
      }
      resources {
        limits   = { cpu = var.cloud_run_proxy_cpu, memory = "512Mi" }
        cpu_idle = true
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.default,
    google_project_iam_member.orchestrator_datastore,
    google_cloud_run_v2_service_iam_member.pipeline_proxy_invokes_settings,
    google_storage_bucket.skills,
    google_sql_database_instance.memory,
    google_secret_manager_secret_version.memory_database_url,
    google_secret_manager_secret_iam_member.orchestrator_memory_database_url,
    google_project_iam_member.orchestrator_memory_db_client,
  ]
}

resource "google_cloud_run_v2_service" "deployer" {
  count               = local.pipeline_on ? 1 : 0
  project             = var.project_id
  name                = var.deployer_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "pipeline-deployer" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.deployer[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 1
    timeout                          = "3600s"
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      name       = "app"
      image      = local.deployer_image
      depends_on = ["egress-proxy"]
      ports { container_port = 8080 }
      dynamic "env" {
        for_each = local.deployer_env
        content {
          name  = env.key
          value = env.value
        }
      }
      resources {
        limits            = { cpu = var.cloud_run_service_cpu, memory = "1Gi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }

    containers {
      name  = "egress-proxy"
      image = local.proxy_image

      dynamic "env" {
        for_each = local.proxy_plain_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name  = "INTERNAL_API_TOKEN"
        value = var.internal_api_token
      }
      startup_probe {
        http_get {
          path = "/healthz"
          port = 4030
        }
        initial_delay_seconds = 0
        timeout_seconds       = 3
        period_seconds        = 3
        failure_threshold     = 20
      }
      resources {
        limits   = { cpu = var.cloud_run_proxy_cpu, memory = "512Mi" }
        cpu_idle = true
      }
    }
  }

  depends_on = [
    google_firestore_database.default,
    google_project_iam_member.deployer_datastore,
    google_cloud_run_v2_service_iam_member.pipeline_proxy_invokes_settings,
  ]
}

# --- Dedicated topics ---------------------------------------------------------

resource "google_pubsub_topic" "pipeline_plan" {
  count      = local.pipeline_on ? 1 : 0
  project    = var.project_id
  name       = var.pipeline_plan_topic
  labels     = merge(local.common_labels, { component = "pipeline-plan" })
  depends_on = [google_project_service.services]
}

resource "google_pubsub_topic" "pipeline_code" {
  count      = local.pipeline_on ? 1 : 0
  project    = var.project_id
  name       = var.pipeline_code_topic
  labels     = merge(local.common_labels, { component = "pipeline-code" })
  depends_on = [google_project_service.services]
}

resource "google_pubsub_topic" "pipeline_test" {
  count      = local.pipeline_on ? 1 : 0
  project    = var.project_id
  name       = var.pipeline_test_topic
  labels     = merge(local.common_labels, { component = "pipeline-test" })
  depends_on = [google_project_service.services]
}

resource "google_pubsub_topic" "pipeline_deploy" {
  count      = local.pipeline_on ? 1 : 0
  project    = var.project_id
  name       = var.pipeline_deploy_topic
  labels     = merge(local.common_labels, { component = "pipeline-deploy" })
  depends_on = [google_project_service.services]
}

resource "google_pubsub_topic" "pipeline_results" {
  for_each = local.pipeline_on ? {
    plan   = var.pipeline_plan_results_topic
    code   = var.pipeline_code_results_topic
    test   = var.pipeline_test_results_topic
    deploy = var.pipeline_deploy_results_topic
  } : {}
  project    = var.project_id
  name       = each.value
  labels     = merge(local.common_labels, { component = "pipeline-${each.key}-results" })
  depends_on = [google_project_service.services]
}

# Only the orchestrator emits StageCommand messages.
resource "google_pubsub_topic_iam_member" "orchestrator_stage_publish" {
  for_each = local.pipeline_on ? {
    plan   = google_pubsub_topic.pipeline_plan[0].name
    code   = google_pubsub_topic.pipeline_code[0].name
    test   = google_pubsub_topic.pipeline_test[0].name
    deploy = google_pubsub_topic.pipeline_deploy[0].name
  } : {}
  project = var.project_id
  topic   = each.value
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.orchestrator.email}"
}

# Stage executors can publish only typed results, not commands. plan/code/test
# all execute inside the orchestrator now (or in its substrate actors, metered
# by the orchestrator), so one publisher identity covers the three; deploy
# stays its own brokered service.
resource "google_pubsub_topic_iam_member" "pipeline_result_publish" {
  for_each = local.pipeline_on ? {
    plan   = google_service_account.orchestrator.email
    code   = google_service_account.orchestrator.email
    test   = google_service_account.orchestrator.email
    deploy = google_service_account.deployer[0].email
  } : {}
  project = var.project_id
  topic   = google_pubsub_topic.pipeline_results[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${each.value}"
}

# --- Authenticated push delivery ---------------------------------------------

resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_orchestrator" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.orchestrator.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_cloud_run_v2_service_iam_member" "push_invokes_pipeline" {
  for_each = local.pipeline_on ? {
    orchestrator = google_cloud_run_v2_service.orchestrator.name
    deployer     = google_cloud_run_v2_service.deployer[0].name
    } : {
    orchestrator = google_cloud_run_v2_service.orchestrator.name
  }
  project  = var.project_id
  location = var.region
  name     = each.value
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

# Command pushes for plan/code/test go to ONE service through THREE
# stage-bound paths. A shared plain path would let one handler silently
# 204-ack another stage's command — the per-tenant provisioning plan
# (packages/shared-core/src/provisioning/plan.js) spells the same contract.
resource "google_pubsub_subscription" "pipeline_command_push" {
  for_each = local.pipeline_on ? {
    plan   = { topic = google_pubsub_topic.pipeline_plan[0], stage = "plan" }
    code   = { topic = google_pubsub_topic.pipeline_code[0], stage = "code" }
    test   = { topic = google_pubsub_topic.pipeline_test[0], stage = "test" }
    deploy = { topic = google_pubsub_topic.pipeline_deploy[0], stage = null }
  } : {}
  project              = var.project_id
  name                 = "${each.value.topic.name}-push"
  topic                = each.value.topic.id
  labels               = merge(local.common_labels, { component = "pipeline-${each.key}" })
  ack_deadline_seconds = 600
  push_config {
    push_endpoint = each.value.stage == null ? "${local.deployer_url}/pubsub/pipeline-stage" : "${local.orchestrator_url}/pubsub/pipeline-stage/${each.value.stage}"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = each.value.stage == null ? local.deployer_url : local.orchestrator_url
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
    google_cloud_run_v2_service_iam_member.push_invokes_pipeline,
    google_service_account_iam_member.pubsub_agent_token_creator,
  ]
}

resource "google_pubsub_subscription" "pipeline_results_push" {
  for_each = local.pipeline_on ? {
    plan   = google_pubsub_topic.pipeline_results["plan"]
    code   = google_pubsub_topic.pipeline_results["code"]
    test   = google_pubsub_topic.pipeline_results["test"]
    deploy = google_pubsub_topic.pipeline_results["deploy"]
  } : {}
  project              = var.project_id
  name                 = "${each.value.name}-push"
  topic                = each.value.id
  labels               = merge(local.common_labels, { component = "pipeline-${each.key}-results" })
  ack_deadline_seconds = var.ack_deadline_seconds
  push_config {
    push_endpoint = "${local.orchestrator_url}/pubsub/pipeline-stage-results/${each.key}"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.orchestrator_url
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
    google_cloud_run_v2_service_iam_member.push_invokes_pipeline,
    google_service_account_iam_member.pubsub_agent_token_creator,
  ]
}

# The four command subscriptions were separate count=1 resources; folding them
# into one for_each map without these moved{} blocks would DESTROY and recreate
# them, and a fresh subscription never receives messages published before it
# existed — in-flight stage commands would be dropped during the cutover.
moved {
  from = google_pubsub_subscription.pipeline_plan_push
  to   = google_pubsub_subscription.pipeline_command_push["plan"]
}
moved {
  from = google_pubsub_subscription.pipeline_code_push
  to   = google_pubsub_subscription.pipeline_command_push["code"]
}
moved {
  from = google_pubsub_subscription.pipeline_test_push
  to   = google_pubsub_subscription.pipeline_command_push["test"]
}
moved {
  from = google_pubsub_subscription.pipeline_deploy_push
  to   = google_pubsub_subscription.pipeline_command_push["deploy"]
}

# Pub/Sub's service agent needs subscriber on every source subscription to make
# dead-letter forwarding work (the DLQ publisher binding is shared in pubsub.tf).
resource "google_pubsub_subscription_iam_member" "pipeline_dead_letter_subscriber" {
  for_each = local.pipeline_on ? {
    plan_command   = google_pubsub_subscription.pipeline_command_push["plan"].name
    code_command   = google_pubsub_subscription.pipeline_command_push["code"].name
    test_command   = google_pubsub_subscription.pipeline_command_push["test"].name
    deploy_command = google_pubsub_subscription.pipeline_command_push["deploy"].name
    plan_result    = google_pubsub_subscription.pipeline_results_push["plan"].name
    code_result    = google_pubsub_subscription.pipeline_results_push["code"].name
    test_result    = google_pubsub_subscription.pipeline_results_push["test"].name
    deploy_result  = google_pubsub_subscription.pipeline_results_push["deploy"].name
  } : {}
  project      = var.project_id
  subscription = each.value
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}
