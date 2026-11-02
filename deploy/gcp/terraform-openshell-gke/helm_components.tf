# ---------------------------------------------------------------------------
# Agent Sandbox controller (kubernetes-sigs) — applied from the upstream
# release manifest.
# ---------------------------------------------------------------------------

data "http" "agent_sandbox_manifest" {
  url = "https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/sandbox.yaml"
}

data "kubectl_file_documents" "agent_sandbox_docs" {
  content = data.http.agent_sandbox_manifest.response_body
}

resource "kubectl_manifest" "agent_sandbox" {
  for_each  = data.kubectl_file_documents.agent_sandbox_docs.manifests
  yaml_body = each.value

  depends_on = [google_container_node_pool.primary_nodes]
}

# ---------------------------------------------------------------------------
# Envoy Gateway (OCI chart) + GatewayClass pinned to an EnvoyProxy with the
# reserved static IP.
# ---------------------------------------------------------------------------

resource "helm_release" "envoy_gateway" {
  name             = "eg"
  chart            = "oci://docker.io/envoyproxy/gateway-helm"
  version          = var.envoy_gateway_version
  namespace        = kubernetes_namespace_v1.envoy_gateway_system.metadata[0].name
  create_namespace = false
  wait             = true
  timeout          = 600

  depends_on = [
    kubernetes_namespace_v1.envoy_gateway_system,
    kubectl_manifest.agent_sandbox,
  ]
}

resource "kubectl_manifest" "envoy_proxy_config" {
  yaml_body = <<YAML
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: openshell-proxy-config
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: LoadBalancer
        loadBalancerIP: "${google_compute_address.openshell_ip.address}"
        externalTrafficPolicy: Local
        annotations:
          networking.gke.io/load-balancer-ip-addresses: "${google_compute_address.openshell_ip.address}"
YAML

  depends_on = [helm_release.envoy_gateway]
}

resource "kubectl_manifest" "gateway_class" {
  yaml_body = <<YAML
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: openshell-proxy-config
    namespace: envoy-gateway-system
YAML

  depends_on = [kubectl_manifest.envoy_proxy_config]
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
    })
  ]

  depends_on = [
    kubernetes_namespace_v1.cert_manager,
    kubectl_manifest.gateway_class,
  ]
}

# ---------------------------------------------------------------------------
# Let's Encrypt ClusterIssuers
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
              - name: openshell-ingress
                namespace: openshell
                kind: Gateway
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
              - name: openshell-ingress
                namespace: openshell
                kind: Gateway
YAML

  depends_on = [helm_release.cert_manager]
}

# ---------------------------------------------------------------------------
# Gateway, HTTPRoute and Envoy traffic policies for the OpenShell gRPC surface
# ---------------------------------------------------------------------------

resource "kubectl_manifest" "openshell_ingress_gateway" {
  yaml_body = <<YAML
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: openshell-ingress
  namespace: openshell
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: All
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: openshell-server-external-tls
      allowedRoutes:
        namespaces:
          from: All
YAML

  depends_on = [
    kubernetes_namespace_v1.openshell,
    kubectl_manifest.gateway_class,
  ]
}

resource "kubectl_manifest" "openshell_http_route" {
  yaml_body = <<YAML
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: openshell-http
  namespace: openshell
spec:
  parentRefs:
    - name: openshell-ingress
      namespace: openshell
  hostnames:
    - "${var.domain}"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: openshell
          port: 8080
YAML

  depends_on = [kubectl_manifest.openshell_ingress_gateway]
}

resource "kubectl_manifest" "openshell_backend_traffic" {
  yaml_body = <<YAML
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: openshell-backend-traffic
  namespace: openshell
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: openshell-http
  timeout:
    http:
      requestTimeout: 0s
YAML

  depends_on = [kubectl_manifest.openshell_http_route]
}

resource "kubectl_manifest" "openshell_client_traffic" {
  yaml_body = <<YAML
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: openshell-client-traffic
  namespace: openshell
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: openshell-ingress
  timeout:
    http:
      streamIdleTimeout: 600s
YAML

  depends_on = [kubectl_manifest.openshell_ingress_gateway]
}

# ---------------------------------------------------------------------------
# OpenShell gateway Helm release (operator multi-tenant mode)
# ---------------------------------------------------------------------------

resource "helm_release" "openshell" {
  name             = "openshell"
  repository       = "oci://ghcr.io/nvidia/openshell"
  chart            = "helm-chart"
  version          = var.openshell_version
  namespace        = kubernetes_namespace_v1.openshell.metadata[0].name
  create_namespace = false
  wait             = true
  timeout          = 900

  values = [
    yamlencode({
      server = {
        auth = {
          allowUnauthenticatedUsers = true
        }
        drivers = {
          kubernetes = {
            workspaceMode          = "operator"
            operatorNamespaceLabel = "openshell.ai/workspace-allowed"
          }
        }
        credentialDrivers = {
          kubernetesSecrets = {
            enabled         = true
            namespace       = kubernetes_namespace_v1.openshell_credentials.metadata[0].name
            createNamespace = true
          }
        }
        disableTls = true
      }
      workspaceResources = {
        enabled = true
      }
      certManager = {
        enabled = true
        serverIssuerRef = {
          name = "letsencrypt-prod"
          kind = "ClusterIssuer"
        }
        serverDnsNames = [var.domain]
      }
      grpcRoute = {
        enabled = true
        gateway = {
          create    = false
          name      = "openshell-ingress"
          namespace = kubernetes_namespace_v1.openshell.metadata[0].name
        }
        hostnames = [var.domain]
      }
    })
  ]

  depends_on = [
    kubernetes_namespace_v1.openshell,
    kubernetes_namespace_v1.openshell_credentials,
    kubectl_manifest.letsencrypt_prod,
    kubectl_manifest.openshell_ingress_gateway,
  ]
}
