# ---------------------------------------------------------------------------
# agentgateway — the in-cluster L7 front for LLM (and, as a seam, MCP + A2A)
# traffic, and the substrate root's share of decision #1.
#
# Position in the pipe (read this before adding a route):
#
#   browser ──(X-AI-Fleet-Llm-Gateway: litellm)──▶ sidecar /agentgw ──▶ THIS
#                                                          └─▶ LiteLLM ─▶ provider
#
# agentgateway sits IN FRONT of LiteLLM, not beside it. `LLM_GATEWAY_MODES`
# stays {langsmith, litellm}: the flag is per-request and never per-deployment,
# so adding a third mode would rewrite the glossary's meaning of the header.
# What changes is the physical target the sidecar forwards to, decided by the
# operator, never by the client.
#
# Placement rules that are NOT negotiable:
#   * The gateway is reached over the cluster network by default. A public front
#     has to be asked for by name (`agentgateway_ingress_hostname`), because the
#     value of this hop is that a credential-holding request never leaves the
#     VPC.
#   * Nothing here writes a credential. Terraform renders Secret and ConfigMap
#     *names* and, for virtual keys, hashes only. The environment-init job's
#     `gw.virtualkey` step is the only writer of live material. A provider key
#     in config, tfvars or state is a leaked key: state is readable by anyone
#     with `container.admin`, which is exactly the CI deployer's identity.
#   * Per-tenant isolation comes from which backend holds which upstream key,
#     never from a header the caller controls.
#
# What this file does NOT do, and why:
#   * It does not install Gateway API CRDs. Envoy Gateway (helm_components.tf)
#     already owns that bundle in this cluster and agentgateway accepts any
#     Gateway API in 1.4–1.6. Applying upstream `standard-install.yaml` over it
#     would replace CRDs a working Envoy data plane depends on. If the bundled
#     version ever falls outside agentgateway's range, that is a migration with
#     a plan, not a `kubectl apply`.
#   * It does not enforce a token budget. Global rate limiting needs an external
#     `envoyproxy/ratelimit` plus Redis; a `local` limit counts per proxy
#     replica, which is a hint and not enforcement. Leaving it unset is honest —
#     setting a local limit and calling it a budget is what decision #4 forbids.
#   * It does not authenticate actors. Whether agentgateway accepts SPIFFE
#     JWT-SVIDs is unverified, and the fallback — a bearer key inside an actor
#     container — is the invariant that agents never hold a credential.
#
# Manifests here are `yamlencode`d rather than heredoc'd: the listener shape
# changes with whether the front is public, and three hand-written YAML
# variants of one Gateway is how a TLS-mode edit forgets the a2a listener.
# ---------------------------------------------------------------------------

locals {
  agentgateway_enabled = var.agentgateway_enabled
  # A public front exists only with a hostname to serve it.
  agentgateway_front = var.agentgateway_enabled && var.agentgateway_ingress_hostname != ""
  # The label a policy selects ConfigMaps by. ConfigMaps cannot be referenced
  # by name, so this label IS the pointer: anything carrying it is an auth
  # source for the whole Gateway.
  agentgateway_labels = { "agentgateway.dev/apikey" = "true" }

  # Fail closed on the model allowlist. An unset list renders an authorization
  # rule that refuses every POST rather than one that permits every model: the
  # first run 403s and somebody reads this comment, whereas a permissive default
  # silently serves models no org was granted.
  # deploy/gcp/agentgateway-config.test.js is what keeps var.agentgateway_models
  # equal to deploy/litellm/config.yaml's model_list.
  agentgateway_models = length(var.agentgateway_models) > 0 ? var.agentgateway_models : ["__agentgateway_models_unset__"]

  # CEL for the allowlist. Non-POST passes through: `/v1/models` is a metadata
  # probe (Codex sends it) and has no body to read.
  agentgateway_model_expression = "request.method != \"POST\" || json(request.body).model in [${join(",", [for m in local.agentgateway_models : "\"${m}\""])}]"

  # One entry per organization: the hash, never the key. `metadata.user_id` is
  # what authorization reads as `apiKey.user_id` and what the per-key metric
  # label carries, so it is the join key between a gateway metric and a Firestore
  # usage record. `org:<orgId>` matches the `x-fleet-org-id` the sidecar stamps.
  agentgateway_key_entries = {
    for org_id, hash in var.agentgateway_virtual_keys :
    "org-${org_id}" => jsonencode({
      keyHash  = hash
      metadata = { user_id = "org:${org_id}" }
    })
  }

  # Data plane Service. GKE wants both the field and the annotation:
  # `loadBalancerIP` alone is ignored on the newer backend-service path, and the
  # annotation alone races whatever ephemeral IP the controller grabbed first.
  # Where a field must be ABSENT rather than empty, it is filtered out of the
  # map instead of set to null: the API servers read `tls: null` and
  # `hostnames: null` as a type error, not as "unset", so a null attribute is a
  # failed apply instead of an omitted stanza. (This is also why these are
  # filtered maps and not `merge()`s of two conditional objects: HCL's merge is
  # shallow, so merging `{spec = {...}}` over `{spec = {...}}` silently deletes
  # the first one, and a conditional whole-object ternary would have to keep
  # both branches' types identical — a constraint that reads as noise here.)
  agentgateway_service_spec = {
    for key, value in {
      type           = local.agentgateway_front ? "LoadBalancer" : "ClusterIP"
      loadBalancerIP = local.agentgateway_front ? google_compute_address.agentgateway_ip[0].address : null
    } : key => value if value != null
  }

  agentgateway_service_config = {
    for key, value in {
      spec = local.agentgateway_service_spec
      metadata = local.agentgateway_front ? {
        annotations = {
          "networking.gke.io/load-balancer-ip-addresses" = google_compute_address.agentgateway_ip[0].address
        }
      } : null
    } : key => value if value != null
  }

  # The llm listener is HTTPS only when it has a certificate to terminate.
  # Port 80 HTTP is not a cleartext LLM path: with no hostname the front is
  # ClusterIP, so the only thing that can reach it already has VPC access.
  agentgateway_llm_listener = {
    for key, value in {
      port     = local.agentgateway_front ? 443 : 80
      protocol = local.agentgateway_front ? "HTTPS" : "HTTP"
      tls = local.agentgateway_front ? {
        mode            = "Terminate"
        certificateRefs = [{ name = "agentgateway-server-external-tls" }]
      } : null
      allowedRoutes = { namespaces = { from = "Same" } }
    } : key => value if value != null
  }

  agentgateway_tls_policy = var.agentgateway_llm_upstream_tls ? {
    sni = var.agentgateway_llm_upstream_host
  } : null

  agentgateway_backend_manifest = {
    apiVersion = "agentgateway.dev/v1alpha1"
    kind       = "AgentgatewayBackend"
    metadata = {
      name      = "litellm"
      namespace = var.agentgateway_namespace
    }
    spec = {
      ai = {
        provider = {
          # formats declares what deploy/litellm/config.yaml actually serves:
          # Completions + Responses for the OpenAI surface, Messages for
          # /v1/messages. `/v1/models` is deliberately absent — declaring it
          # would have the gateway price a metadata probe.
          custom = {
            # Not cosmetic. Without it agentgateway reports every custom
            # provider under the single identity `custom`, which collapses both
            # the cost catalog lookup (so `llm.cost` stays unset) and the
            # `gen_ai.provider.name` telemetry attribute — the two things this
            # hop is supposed to report.
            providerOverride = "litellm"
            formats = [
              { type = "Completions", path = "/v1/chat/completions" },
              { type = "Responses", path = "/v1/responses" },
              { type = "Messages", path = "/v1/messages" },
            ]
          }
          host       = var.agentgateway_llm_upstream_host
          port       = var.agentgateway_llm_upstream_port
          pathPrefix = "/v1"
        }
      }
      policies = {
        for key, value in {
          auth = {
            # Name only, and it is LiteLLM's model-scoped virtual key for this
            # organization class — never the LiteLLM master key, which forwards
            # any sub-path and would defeat the boundary this file exists to draw.
            secretRef = { name = var.agentgateway_provider_key_secret }
          }
          tls = local.agentgateway_tls_policy
        } : key => value if value != null
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Control plane: two pinned releases, both recorded in agentgateway-system
# ---------------------------------------------------------------------------

resource "kubernetes_namespace_v1" "agentgateway_system" {
  count = local.agentgateway_enabled ? 1 : 0

  metadata {
    name = var.agentgateway_namespace

    labels = {
      "pod-security.kubernetes.io/enforce" = "restricted"
    }
  }

  depends_on = [google_container_node_pool.system_nodes]
}

# The CRD chart is cluster-scoped work whose release metadata lives in the
# control-plane namespace so one `helm -n agentgateway-system list` shows both.
resource "helm_release" "agentgateway_crds" {
  count = local.agentgateway_enabled ? 1 : 0

  name      = "agentgateway-crds"
  chart     = "oci://cr.agentgateway.dev/charts/agentgateway-crds"
  version   = var.agentgateway_version
  namespace = var.agentgateway_namespace

  depends_on = [kubernetes_namespace_v1.agentgateway_system]
}

resource "helm_release" "agentgateway" {
  count = local.agentgateway_enabled ? 1 : 0

  name      = "agentgateway"
  chart     = "oci://cr.agentgateway.dev/charts/agentgateway"
  version   = var.agentgateway_version
  namespace = var.agentgateway_namespace

  # The chart installs ONLY the control plane; the data plane is per-Gateway
  # (its Deployment and Service are created by the controller and named after
  # the Gateway), which is why the scheduling and IP pinning lives in
  # AgentgatewayParameters below rather than in chart values.
  #
  # `create_namespace = false`: this root owns the namespace, including its Pod
  # Security label, and a chart that recreates it would drop that enforcement
  # on the next upgrade.
  create_namespace = false

  # Top-level `nodeSelector`, not `controller.nodeSelector`: the chart reads
  # `.Values.nodeSelector` on the controller Deployment. A dotted `set` path
  # would be accepted by helm and simply never match a key, which is how a
  # singleton ends up unschedulable on the pool the power workflow drains.
  values = [yamlencode({ nodeSelector = local.system_node_selector })]

  depends_on = [
    helm_release.agentgateway_crds,
    kubernetes_namespace_v1.agentgateway_system,
  ]
}

# ---------------------------------------------------------------------------
# Data plane: its own address when published, its own parameters always
# ---------------------------------------------------------------------------

resource "google_compute_address" "agentgateway_ip" {
  count = local.agentgateway_front ? 1 : 0

  name    = "agentgateway-ip"
  project = var.project_id
  region  = var.region

  depends_on = [google_project_service.required_apis]
}

resource "kubectl_manifest" "agentgateway_parameters" {
  count = local.agentgateway_enabled ? 1 : 0

  # Pinned to the system pool for the same reason Envoy is: the proxy is a
  # singleton the tenant pool cannot drain out from under the cluster, and the
  # autoscaler re-buys any node that held it. JSON logs, because decision #8 put
  # these lines behind a log-based metric.
  yaml_body = yamlencode({
    apiVersion = "agentgateway.dev/v1alpha1"
    kind       = "AgentgatewayParameters"
    metadata = {
      name      = "${var.agentgateway_gateway_name}-config"
      namespace = var.agentgateway_namespace
    }
    spec = {
      logging = { format = "json" }
      deployment = {
        spec = {
          template = {
            spec = {
              nodeSelector = local.system_node_selector
            }
          }
        }
      }
      service = local.agentgateway_service_config
    }
  })

  depends_on = [
    helm_release.agentgateway,
    kubernetes_namespace_v1.agentgateway_system,
    google_compute_address.agentgateway_ip,
  ]
}

resource "kubectl_manifest" "agentgateway_certificate" {
  count = local.agentgateway_front ? 1 : 0

  yaml_body = yamlencode({
    apiVersion = "cert-manager.io/v1"
    kind       = "Certificate"
    metadata = {
      name      = "agentgateway-server-tls"
      namespace = var.agentgateway_namespace
    }
    spec = {
      secretName = "agentgateway-server-external-tls"
      issuerRef = {
        name  = "letsencrypt-prod"
        kind  = "ClusterIssuer"
        group = "cert-manager.io"
      }
      dnsNames = [var.agentgateway_ingress_hostname]
    }
  })

  depends_on = [helm_release.cert_manager, kubernetes_namespace_v1.agentgateway_system]
}

resource "kubectl_manifest" "agentgateway_gateway" {
  count = local.agentgateway_enabled ? 1 : 0

  # The a2a listener is separate on purpose: an LLM request must never be able
  # to reach an agent-to-agent path, and a dedicated listener makes that a
  # structural fact rather than a match-precedence argument.
  yaml_body = yamlencode({
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "Gateway"
    metadata = {
      name      = var.agentgateway_gateway_name
      namespace = var.agentgateway_namespace
    }
    spec = {
      gatewayClassName = "agentgateway"
      infrastructure = {
        parametersRef = {
          group = "agentgateway.dev"
          kind  = "AgentgatewayParameters"
          name  = "${var.agentgateway_gateway_name}-config"
        }
      }
      listeners = [
        merge(local.agentgateway_llm_listener, { name = "llm" }),
        {
          name     = "a2a"
          port     = 8081
          protocol = "HTTP"
          # The deny-all default, stated in the one place Gateway API enforces
          # it structurally rather than by policy: no HTTPRoute in any namespace
          # may attach here. Turning A2A on is a reviewable flip of this line
          # plus a route plus backends, not a credential someone forgot to gate.
          allowedRoutes = { namespaces = { from = "None" } }
        },
      ]
    }
  })

  depends_on = [
    helm_release.agentgateway,
    kubectl_manifest.agentgateway_parameters,
    kubectl_manifest.agentgateway_certificate,
  ]
}

# ---------------------------------------------------------------------------
# Virtual keys: hashes only
# ---------------------------------------------------------------------------

resource "kubernetes_config_map_v1" "agentgateway_virtual_keys" {
  count = local.agentgateway_enabled ? 1 : 0

  metadata {
    name      = "agentgateway-api-keys"
    namespace = var.agentgateway_namespace
    labels    = local.agentgateway_labels
  }

  # Empty by default, and that is the safe state: `mode: Strict` against zero
  # hashes 401s every request, so a half-wired deployment is dark rather than
  # open. Rotation is an entry swap, not a provider-key ceremony.
  data = { for name, entry in local.agentgateway_key_entries : name => entry }

  depends_on = [kubernetes_namespace_v1.agentgateway_system]
}

# ---------------------------------------------------------------------------
# LiteLLM as the upstream, and the route that reaches it
# ---------------------------------------------------------------------------

resource "kubectl_manifest" "agentgateway_litellm_backend" {
  count = local.agentgateway_enabled ? 1 : 0

  # null values are dropped by yamlencode/merge, so `tls: null` above renders
  # no tls stanza instead of an empty one.
  yaml_body = yamlencode(local.agentgateway_backend_manifest)

  depends_on = [helm_release.agentgateway, kubernetes_namespace_v1.agentgateway_system]
}

resource "kubectl_manifest" "agentgateway_llm_route" {
  count = local.agentgateway_enabled ? 1 : 0

  yaml_body = yamlencode({
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "HTTPRoute"
    metadata = {
      name      = "agentgateway-llm"
      namespace = var.agentgateway_namespace
    }
    # A hostname is only meaningful, and only legal, on a front that has one:
    # an HTTPRoute naming a host no listener serves is refused.
    spec = {
      for key, value in {
        parentRefs = [{ name = var.agentgateway_gateway_name, namespace = var.agentgateway_namespace, sectionName = "llm" }]
        hostnames  = local.agentgateway_front ? [var.agentgateway_ingress_hostname] : null
        rules = [{
          matches = [{ path = { type = "PathPrefix", value = "/" } }]
          backendRefs = [{
            name      = "litellm"
            namespace = var.agentgateway_namespace
            group     = "agentgateway.dev"
            kind      = "AgentgatewayBackend"
          }]
        }]
      } : key => value if value != null
    }
  })

  depends_on = [kubectl_manifest.agentgateway_litellm_backend, kubectl_manifest.agentgateway_gateway]
}

# ---------------------------------------------------------------------------
# ONE whole policy: auth + model allowlist + per-key metric label
#
# agentgateway's docs warn that separate policies can overwrite one another even
# when both report ACCEPTED/ATTACHED, and that a dropped field is not surfaced
# by any condition. Three policies patched piecemeal — auth, then authorization,
# then metrics — is therefore not a style preference to keep but a silent
# misconfiguration to avoid. Everything targeting the Gateway lives in this one
# object, and it is never partially patched.
# ---------------------------------------------------------------------------

resource "kubectl_manifest" "agentgateway_policy" {
  count = local.agentgateway_enabled ? 1 : 0

  yaml_body = yamlencode({
    apiVersion = "agentgateway.dev/v1alpha1"
    kind       = "AgentgatewayPolicy"
    metadata = {
      name      = "agentgateway-tenant-access"
      namespace = var.agentgateway_namespace
    }
    spec = {
      targetRefs = [{
        group = "gateway.networking.k8s.io"
        kind  = "Gateway"
        name  = var.agentgateway_gateway_name
      }]
      traffic = {
        apiKeyAuthentication = {
          # Strict: an anonymous request is a 401, not a free pass. `Optional`
          # would make a credential-holding hop an open relay for whoever
          # forgets a header.
          mode              = "Strict"
          configMapSelector = { matchLabels = local.agentgateway_labels }
        }
        authorization = {
          action = "Require"
          policy = { matchExpressions = [local.agentgateway_model_expression] }
        }
      }
      frontend = {
        metrics = {
          attributes = {
            add = [{ name = "user_id", expression = "apiKey.user_id" }]
          }
        }
      }
    }
  })

  depends_on = [
    kubectl_manifest.agentgateway_gateway,
    kubernetes_config_map_v1.agentgateway_virtual_keys,
  ]
}

# ---------------------------------------------------------------------------
# The /a2a seam (decision #3): a listener that nothing may attach to.
#
# agentgateway authorization is deny-by-absence — NO policy means allow-all,
# the opposite of what a placeholder needs. So the denial is stated positively:
# require an `apiKey.user_id` no ConfigMap entry can carry. Both halves of a
# request then fail (no key 401s, a valid key 403s) and there is no agent
# backend to reach by accident.
#
# ---------------------------------------------------------------------------

# The seam is closed by absence, which is the strongest form available here:
# the `a2a` listener exists and admits no routes, so a connection to 8081 has
# nothing to route to and is refused. No backends, no agent cards (decision #3).
#
# What this deliberately does NOT do is add a second AgentgatewayPolicy. The
# vendor caveat is that separate policies can overwrite one another even while
# both report ACCEPTED/ATTACHED, so the Gateway above carries exactly one whole
# policy — and a route-scoped denial would be the piecemeal patch that caveat
# warns about. The denial does not depend on it either: the one policy above
# already requires a virtual key *and* a POST body whose `model` is on the
# allowlist, so if the listener above were flipped to `Same` and a route
# attached, the first thing that happens is a 403 for a body with no model in
# it. Who would publish an agent card, and why actor-local A2A stays out of
# scope, is section 12 of docs/SUBSTRATE_INTEGRATION.md — not a resource here.
