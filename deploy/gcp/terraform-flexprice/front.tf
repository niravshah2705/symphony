# ---------------------------------------------------------------------------
# Public front — opt-in by hostname, and the one DNS obligation this repo emits.
#
# Shape copied from ../terraform-substrate-gke/substrate.tf: a regional static
# address, an EnvoyProxy that pins the Gateway's Service to it, a Gateway with an
# HTTP listener as well as the HTTPS one, a redirect, and the route.
#
# The HTTP listener is not a cleartext path left by accident. Envoy Gateway will
# not Program a Gateway whose TLS certificate Secret is missing, so a front with
# only an HTTPS listener has no data plane at all on the first run —
# Programmed=False, reason=AddressNotAssigned — and HTTP-01, which connects to
# port 80 of whatever the A record resolves to, can never reach it. The redirect
# below closes the loop once the certificate exists.
#
# Why its own Issuer rather than the cluster's `letsencrypt-prod` ClusterIssuer:
# that issuer's solvers name the Gateways of the root that created it
# (substrate-ingress, agentgateway) in `acme_solver_parent_refs`. cert-manager
# presents an HTTP-01 challenge by creating ONE HTTPRoute carrying every one of
# those parentRefs — so a challenge for flexprice.archagentix.com would be
# attached to a front the hostname does not resolve to, and the failure mode is
# the worst kind: the Certificate sits Pending forever, the old expiry keeps
# serving, and nothing errors. Making that list complete would mean editing the
# substrate root to know about this stack's address. A front that owns its
# Gateway owns its solver.
# ---------------------------------------------------------------------------

locals {
  flexprice_front_enabled = var.flexprice_enabled && var.ingress_hostname != ""
}

resource "google_compute_address" "flexprice_ip" {
  count = local.flexprice_front_enabled ? 1 : 0

  name    = var.static_ip_name
  project = var.project_id
  region  = var.region

  depends_on = [google_project_service.flexprice_apis]
}

resource "kubectl_manifest" "flexprice_issuer" {
  count = local.flexprice_front_enabled ? 1 : 0

  # An empty email is a Let's Encrypt registration that fails after the Challenge
  # has already been created, which surfaces as a Pending Certificate rather than
  # as a plan error. Refuse it where it is readable.
  lifecycle {
    precondition {
      condition     = var.cert_email != ""
      error_message = "cert_email must be set when ingress_hostname is set: it is the ACME account contact on every expiry notice."
    }
  }

  yaml_body = yamlencode({
    apiVersion = "cert-manager.io/v1"
    kind       = "Issuer"
    metadata = {
      name      = "flexprice-issuer"
      namespace = var.namespace
    }
    spec = {
      acme = {
        server              = "https://acme-v02.api.letsencrypt.org/directory"
        email               = var.cert_email
        privateKeySecretRef = { name = "flexprice-issuer-account-key" }
        solvers = [{
          http01 = {
            gatewayHTTPRoute = {
              parentRefs = [{
                kind      = "Gateway"
                name      = "flexprice-ingress"
                namespace = var.namespace
              }]
            }
          }
        }]
      }
    }
  })

  depends_on = [
    kubectl_manifest.flexprice_gateway,
    kubernetes_namespace_v1.flexprice,
  ]
}

resource "kubectl_manifest" "flexprice_certificate" {
  count = local.flexprice_front_enabled ? 1 : 0

  yaml_body = yamlencode({
    apiVersion = "cert-manager.io/v1"
    kind       = "Certificate"
    metadata = {
      name      = "flexprice-server-tls"
      namespace = var.namespace
    }
    spec = {
      secretName = "flexprice-server-external-tls"
      issuerRef = {
        name = "flexprice-issuer"
        kind = "Issuer"
      }
      dnsNames = [var.ingress_hostname]
    }
  })

  depends_on = [kubectl_manifest.flexprice_issuer]
}

resource "kubectl_manifest" "flexprice_envoy_proxy" {
  count = local.flexprice_front_enabled ? 1 : 0

  # Without this the Gateway's Envoy Service is created with an EPHEMERAL IP and
  # the flexprice_ingress_ip output is a lie that outlives the first rollout —
  # which is the moment the operator's A record starts pointing at a dead
  # address. Same reasoning and same shape as substrate-proxy-config there.
  #
  # Envoy's own pods go on the system pool, not the FlexPrice pool: the data plane
  # belongs with the cluster's ingress layer (one Envoy per front, shared
  # placement), and pinning it to the tainted pool would mean the front depends on
  # a pool the databases also need.
  yaml_body = yamlencode({
    apiVersion = "gateway.envoyproxy.io/v1alpha1"
    kind       = "EnvoyProxy"
    metadata = {
      name      = "flexprice-proxy-config"
      namespace = var.namespace
    }
    spec = {
      provider = {
        type = "Kubernetes"
        kubernetes = {
          envoyDeployment = {
            pod = {
              nodeSelector = {
                "cloud.google.com/gke-nodepool" = var.system_node_pool_name
              }
            }
          }
          envoyService = {
            type                  = "LoadBalancer"
            loadBalancerIP        = google_compute_address.flexprice_ip[0].address
            externalTrafficPolicy = "Local"
            annotations = {
              "networking.gke.io/load-balancer-ip-addresses" = google_compute_address.flexprice_ip[0].address
            }
          }
        }
      }
    }
  })

  depends_on = [google_compute_address.flexprice_ip]
}

resource "kubectl_manifest" "flexprice_gateway" {
  count = local.flexprice_front_enabled ? 1 : 0

  yaml_body = yamlencode({
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "Gateway"
    metadata = {
      name      = "flexprice-ingress"
      namespace = var.namespace
    }
    spec = {
      gatewayClassName = "eg"
      infrastructure = {
        parametersRef = {
          group = "gateway.envoyproxy.io"
          kind  = "EnvoyProxy"
          name  = "flexprice-proxy-config"
        }
      }
      listeners = [
        {
          name     = "https"
          port     = 443
          protocol = "HTTPS"
          tls = {
            mode            = "Terminate"
            certificateRefs = [{ name = "flexprice-server-external-tls" }]
          }
          allowedRoutes = { namespaces = { from = "Same" } }
        },
        {
          name          = "http"
          port          = 80
          protocol      = "HTTP"
          allowedRoutes = { namespaces = { from = "Same" } }
        },
      ]
    }
  })

  depends_on = [kubectl_manifest.flexprice_envoy_proxy]
}

resource "kubectl_manifest" "flexprice_http_redirect" {
  count = local.flexprice_front_enabled ? 1 : 0

  yaml_body = yamlencode({
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "HTTPRoute"
    metadata = {
      name      = "flexprice-http-redirect"
      namespace = var.namespace
    }
    spec = {
      # `sectionName` rather than the whole Gateway: a redirect attached to both
      # listeners would be a route that matches `http://host/` and sends it to
      # itself. Pinned to the HTTP listener, it does exactly the one job.
      parentRefs = [{ kind = "Gateway", name = "flexprice-ingress", sectionName = "http" }]
      hostnames  = [var.ingress_hostname]
      rules = [{
        filters = [{
          type = "RequestRedirect"
          requestRedirect = {
            scheme = "https"
            port   = 443
          }
        }]
      }]
    }
  })

  depends_on = [kubectl_manifest.flexprice_gateway]
}

resource "kubectl_manifest" "flexprice_api_route" {
  count = local.flexprice_front_enabled ? 1 : 0

  # The backend is the app release's own Service — `flexprice-api`, port 80,
  # targetPort 8080 (values/base.yaml `service`). Gateway API to a ClusterIP
  # Service in the same namespace, `from: Same`, so nothing outside this namespace
  # can attach a route to this front.
  #
  # Nothing here authenticates a caller. FlexPrice's own api-key auth is the
  # boundary, and the ingest/money plane key split is what limits what a stolen
  # key can do (docs/BILLING_FLEXPRICE.md). Publishing the front makes the API
  # reachable from the internet; it does not make it authorised differently.
  yaml_body = yamlencode({
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "HTTPRoute"
    metadata = {
      name      = "flexprice-api"
      namespace = var.namespace
    }
    spec = {
      # HTTPS only, so the two routes here never contend for the same listener
      # and cleartext `/` always hits the redirect above.
      parentRefs = [{ kind = "Gateway", name = "flexprice-ingress", sectionName = "https" }]
      hostnames  = [var.ingress_hostname]
      rules = [{
        backendRefs = [{
          name = "flexprice-api"
          port = 80
        }]
      }]
    }
  })

  depends_on = [
    kubectl_manifest.flexprice_gateway,
    kubectl_manifest.flexprice_http_redirect,
    helm_release.flexprice_app,
  ]
}
