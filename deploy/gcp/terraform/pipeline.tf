# -----------------------------------------------------------------------------
# Durable fixed pipeline — orchestrator + brokered tester/deployer services and
# eight stage-specific Pub/Sub channels. The entire topology is rollout-gated. The
# legacy planner/coder topics are intentionally never referenced here.
# -----------------------------------------------------------------------------

locals {
  pipeline_on = var.pipeline_orchestrator_enabled

  orchestrator_env = merge(local.common_env, {
    ORCHESTRATOR_SERVICE_PORT       = "8080"
    ORCHESTRATOR_URL                = local.orchestrator_url
    SETTINGS_URL                    = local.settings_url
    PIPELINE_STORE_BACKEND          = "firestore"
    PIPELINE_RESULTS_AUDIENCE       = local.orchestrator_url
    PIPELINE_RESULTS_ALLOWED_EMAILS = google_service_account.pubsub_push.email
    PUBSUB_PUSH_AUDIENCE            = local.orchestrator_url
    PUBSUB_PUSH_SA                  = google_service_account.pubsub_push.email
  })

  tester_env = merge(local.common_env, local.egress_env, {
    TESTER_SERVICE_PORT                = "8080"
    TESTER_PORT                        = "8080"
    SETTINGS_URL                       = local.settings_url
    ORG_URL                            = local.org_url
    ORCHESTRATOR_URL                   = local.orchestrator_url
    PUBSUB_PIPELINE_TEST_RESULTS_TOPIC = var.pipeline_test_results_topic
    PIPELINE_STAGE_STORE_BACKEND       = "firestore"
    PUBSUB_PUSH_AUDIENCE               = local.tester_url
    PUBSUB_PUSH_SA                     = google_service_account.pubsub_push.email
  })

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
    condition     = !var.pipeline_orchestrator_enabled || var.egress_proxy_enabled
    error_message = "pipeline_orchestrator_enabled requires egress_proxy_enabled: tester/deployer may never receive raw provider or repository credentials."
  }

  assert {
    condition     = !var.pipeline_orchestrator_enabled || trimspace(nonsensitive(var.internal_api_token)) != ""
    error_message = "pipeline_orchestrator_enabled requires a non-empty internal_api_token for proxy-to-settings authentication."
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
      var.coder_topic,
      var.pipeline_plan_topic,
      var.pipeline_code_topic,
      var.pipeline_test_topic,
      var.pipeline_deploy_topic,
      var.pipeline_plan_results_topic,
      var.pipeline_code_results_topic,
      var.pipeline_test_results_topic,
      var.pipeline_deploy_results_topic,
    ])) == 10
    error_message = "Pipeline command/result topics must be stage-specific, unique, and must not reuse either legacy planner/coder topic."
  }
}

# --- Trust roles --------------------------------------------------------------

resource "google_service_account" "orchestrator" {
  count        = local.pipeline_on ? 1 : 0
  project      = var.project_id
  account_id   = "pipeline-orchestrator-sa"
  display_name = "AI Fleet durable pipeline orchestrator"
}

resource "google_service_account" "tester" {
  count        = local.pipeline_on ? 1 : 0
  project      = var.project_id
  account_id   = "pipeline-tester-sa"
  display_name = "AI Fleet brokered pipeline tester"
}

resource "google_service_account" "deployer" {
  count        = local.pipeline_on ? 1 : 0
  project      = var.project_id
  account_id   = "pipeline-deployer-sa"
  display_name = "AI Fleet brokered pipeline deployer"
}

resource "google_project_iam_member" "orchestrator_datastore" {
  count   = local.pipeline_on ? 1 : 0
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.orchestrator[0].email}"
}

resource "google_project_iam_member" "tester_datastore" {
  count   = local.pipeline_on ? 1 : 0
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.tester[0].email}"
}

resource "google_project_iam_member" "deployer_datastore" {
  count   = local.pipeline_on ? 1 : 0
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.deployer[0].email}"
}

# Agent sidecars resolve managed/customer credentials through settings. The
# orchestrator receives only the internal S2S token needed to atomically consume
# a run-bound deployment approval; tester/deployer app containers stay secret-free.
resource "google_secret_manager_secret_iam_member" "pipeline_proxy_internal_token" {
  for_each = local.pipeline_on ? {
    orchestrator = google_service_account.orchestrator[0].email
    tester       = google_service_account.tester[0].email
    deployer     = google_service_account.deployer[0].email
  } : {}
  project   = var.project_id
  secret_id = one(google_secret_manager_secret.internal_api_token[*].secret_id)
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value}"
}

resource "google_cloud_run_v2_service_iam_member" "pipeline_proxy_invokes_settings" {
  for_each = local.pipeline_on ? {
    orchestrator = google_service_account.orchestrator[0].email
    tester       = google_service_account.tester[0].email
    deployer     = google_service_account.deployer[0].email
  } : {}
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.settings.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}

# --- Cloud Run control/data plane --------------------------------------------

resource "google_cloud_run_v2_service" "orchestrator" {
  count               = local.pipeline_on ? 1 : 0
  project             = var.project_id
  name                = var.orchestrator_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "pipeline-orchestrator" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.orchestrator[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 1
    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    containers {
      name  = "app"
      image = local.orchestrator_image
      ports { container_port = 8080 }
      dynamic "env" {
        for_each = local.orchestrator_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "INTERNAL_API_TOKEN"
        value_source {
          secret_key_ref {
            secret  = one(google_secret_manager_secret.internal_api_token[*].secret_id)
            version = "latest"
          }
        }
      }
      resources {
        limits            = { cpu = var.cloud_run_service_cpu, memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }
  }

  depends_on = [
    google_firestore_database.default,
    google_project_iam_member.orchestrator_datastore,
    google_secret_manager_secret_iam_member.pipeline_proxy_internal_token,
    google_cloud_run_v2_service_iam_member.pipeline_proxy_invokes_settings,
  ]
}

resource "google_cloud_run_v2_service" "tester" {
  count               = local.pipeline_on ? 1 : 0
  project             = var.project_id
  name                = var.tester_service_name
  location            = var.region
  ingress             = var.internal_ingress
  labels              = merge(local.common_labels, { component = "pipeline-tester" })
  deletion_protection = false

  template {
    service_account                  = google_service_account.tester[0].email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 1
    timeout                          = "3600s"
    scaling {
      min_instance_count = 0
      # Stage execution is synchronous. Firestore-backed execution claims and
      # result replay make Pub/Sub redelivery safe across process restarts; one
      # instance also avoids unnecessary concurrent work for this heavy stage.
      max_instance_count = 1
    }

    containers {
      name  = "app"
      image = local.tester_image
      ports { container_port = 8080 }
      dynamic "env" {
        for_each = local.tester_env
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
        name = "INTERNAL_API_TOKEN"
        value_source {
          secret_key_ref {
            secret  = one(google_secret_manager_secret.internal_api_token[*].secret_id)
            version = "latest"
          }
        }
      }
      resources {
        limits   = { cpu = var.cloud_run_proxy_cpu, memory = "512Mi" }
        cpu_idle = true
      }
    }
  }

  depends_on = [
    google_firestore_database.default,
    google_project_iam_member.tester_datastore,
    google_secret_manager_secret_iam_member.pipeline_proxy_internal_token,
    google_cloud_run_v2_service_iam_member.pipeline_proxy_invokes_settings,
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
      name  = "app"
      image = local.deployer_image
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
        name = "INTERNAL_API_TOKEN"
        value_source {
          secret_key_ref {
            secret  = one(google_secret_manager_secret.internal_api_token[*].secret_id)
            version = "latest"
          }
        }
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
    google_secret_manager_secret_iam_member.pipeline_proxy_internal_token,
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
  member  = "serviceAccount:${google_service_account.orchestrator[0].email}"
}

# Stage executors can publish only typed results, not commands.
resource "google_pubsub_topic_iam_member" "pipeline_result_publish" {
  for_each = local.pipeline_on ? {
    plan   = google_service_account.planner.email
    code   = google_service_account.coder.email
    test   = google_service_account.tester[0].email
    deploy = google_service_account.deployer[0].email
  } : {}
  project = var.project_id
  topic   = google_pubsub_topic.pipeline_results[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${each.value}"
}

# --- Authenticated push delivery ---------------------------------------------

resource "google_cloud_run_v2_service_iam_member" "gateway_invokes_orchestrator" {
  count    = local.pipeline_on ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.orchestrator[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway.email}"
}

resource "google_cloud_run_v2_service_iam_member" "push_invokes_pipeline" {
  for_each = local.pipeline_on ? {
    orchestrator = google_cloud_run_v2_service.orchestrator[0].name
    tester       = google_cloud_run_v2_service.tester[0].name
    deployer     = google_cloud_run_v2_service.deployer[0].name
  } : {}
  project  = var.project_id
  location = var.region
  name     = each.value
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

resource "google_pubsub_subscription" "pipeline_plan_push" {
  count                = local.pipeline_on ? 1 : 0
  project              = var.project_id
  name                 = "${var.pipeline_plan_topic}-push"
  topic                = google_pubsub_topic.pipeline_plan[0].id
  labels               = merge(local.common_labels, { component = "pipeline-plan" })
  ack_deadline_seconds = 600
  push_config {
    push_endpoint = "${local.planner_url}/pubsub/pipeline-stage"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.planner_url
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
    google_cloud_run_v2_service_iam_member.push_invokes_planner,
    google_service_account_iam_member.pubsub_agent_token_creator,
  ]
}

resource "google_pubsub_subscription" "pipeline_code_push" {
  count                = local.pipeline_on ? 1 : 0
  project              = var.project_id
  name                 = "${var.pipeline_code_topic}-push"
  topic                = google_pubsub_topic.pipeline_code[0].id
  labels               = merge(local.common_labels, { component = "pipeline-code" })
  ack_deadline_seconds = 600
  push_config {
    push_endpoint = "${local.coder_url}/pubsub/pipeline-stage"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.coder_url
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
    google_cloud_run_v2_service_iam_member.push_invokes_coder,
    google_service_account_iam_member.pubsub_agent_token_creator,
  ]
}

resource "google_pubsub_subscription" "pipeline_test_push" {
  count                = local.pipeline_on ? 1 : 0
  project              = var.project_id
  name                 = "${var.pipeline_test_topic}-push"
  topic                = google_pubsub_topic.pipeline_test[0].id
  labels               = merge(local.common_labels, { component = "pipeline-test" })
  ack_deadline_seconds = 600
  push_config {
    push_endpoint = "${local.tester_url}/pubsub/pipeline-stage"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.tester_url
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

resource "google_pubsub_subscription" "pipeline_deploy_push" {
  count                = local.pipeline_on ? 1 : 0
  project              = var.project_id
  name                 = "${var.pipeline_deploy_topic}-push"
  topic                = google_pubsub_topic.pipeline_deploy[0].id
  labels               = merge(local.common_labels, { component = "pipeline-deploy" })
  ack_deadline_seconds = 600
  push_config {
    push_endpoint = "${local.deployer_url}/pubsub/pipeline-stage"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = local.deployer_url
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

# Pub/Sub's service agent needs subscriber on every source subscription to make
# dead-letter forwarding work (the DLQ publisher binding is shared in pubsub.tf).
resource "google_pubsub_subscription_iam_member" "pipeline_dead_letter_subscriber" {
  for_each = local.pipeline_on ? {
    plan_command   = google_pubsub_subscription.pipeline_plan_push[0].name
    code_command   = google_pubsub_subscription.pipeline_code_push[0].name
    test_command   = google_pubsub_subscription.pipeline_test_push[0].name
    deploy_command = google_pubsub_subscription.pipeline_deploy_push[0].name
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
