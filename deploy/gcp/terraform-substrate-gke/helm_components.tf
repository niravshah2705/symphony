# ---------------------------------------------------------------------------
# Envoy Gateway (OCI chart)
#
# The GatewayClass carries no parametersRef: a class-level EnvoyProxy pinned the
# whole class to one static IP, which was correct when exactly one front (the
# OpenShell gRPC surface) existed and is wrong now that each plane fronts its own
# address. Every Gateway on this class declares its own infrastructure
# parametersRef (see substrate-envoy-proxy in substrate.tf), so a Gateway that
# forgets one gets Envoy's default Service instead of silently claiming another
# plane's IP.
# ---------------------------------------------------------------------------

resource "helm_release" "envoy_gateway" {
  name             = "eg"
  chart            = "oci://docker.io/envoyproxy/gateway-helm"
  version          = var.envoy_gateway_version
  namespace        = kubernetes_namespace_v1.envoy_gateway_system.metadata[0].name
  create_namespace = false
  wait             = true
  timeout          = 600

  values = [
    yamlencode({
      deployment = {
        pod = {
          nodeSelector = local.system_node_selector
        }
      }
      certgen = {
        job = {
          nodeSelector = local.system_node_selector
        }
      }
    })
  ]

  depends_on = [
    kubernetes_namespace_v1.envoy_gateway_system,
    google_container_node_pool.system_nodes,
  ]
}

resource "kubectl_manifest" "gateway_class" {
  yaml_body = <<YAML
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
YAML

  depends_on = [helm_release.envoy_gateway]
}

# ---------------------------------------------------------------------------
# cert-manager (OCI chart) with Gateway API support
# ---------------------------------------------------------------------------

resource "helm_release" "cert_manager" {
  name             = "cert-manager"
  chart            = "oci://quay.io/jetstack/charts/cert-manager"
  version          = var.cert_manager_version
  namespace        = kubernetes_namespace_v1.cert_manager.metadata[0].name
  create_namespace = false
  wait             = true
  timeout          = 600

  values = [
    yamlencode({
      crds = {
        enabled = true
      }
      extraArgs = [
        "--enable-gateway-api"
      ]
      # global.nodeSelector, not the top-level nodeSelector: the latter is only
      # read by the controller Deployment, leaving cert-manager-webhook,
      # cert-manager-cainjector and the startupapicheck Job on any node — which
      # would trip the power workflow's placement preflight on every stop.
      global = {
        nodeSelector = local.system_node_selector
      }
    })
  ]

  depends_on = [
    kubernetes_namespace_v1.cert_manager,
    google_container_node_pool.system_nodes,
    kubectl_manifest.gateway_class,
  ]
}

# ---------------------------------------------------------------------------
# Let's Encrypt ClusterIssuers
#
# The solver parentRefs come from local.acme_solver_parent_refs (substrate.tf)
# rather than being spelled out here: once the Substrate front is enabled its
# Gateway must present challenges too, because HTTP-01 connects to whichever
# front the hostname's A record points at.
# ---------------------------------------------------------------------------

resource "kubectl_manifest" "letsencrypt_staging" {
  yaml_body = <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: ${var.cert_email}
    privateKeySecretRef:
      name: letsencrypt-staging-account-key
    solvers:
      - http01:
          gatewayHTTPRoute:
            parentRefs:
              ${indent(14, yamlencode(local.acme_solver_parent_refs))}
YAML

  depends_on = [helm_release.cert_manager]
}

resource "kubectl_manifest" "letsencrypt_prod" {
  yaml_body = <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${var.cert_email}
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          gatewayHTTPRoute:
            parentRefs:
              ${indent(14, yamlencode(local.acme_solver_parent_refs))}
YAML

  depends_on = [helm_release.cert_manager]
}

