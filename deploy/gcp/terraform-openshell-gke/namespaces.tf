# ---------------------------------------------------------------------------
# Core system namespaces
# ---------------------------------------------------------------------------

resource "kubernetes_namespace_v1" "openshell" {
  metadata {
    name = "openshell"
  }

  depends_on = [google_container_node_pool.primary_nodes]
}

resource "kubernetes_namespace_v1" "openshell_credentials" {
  metadata {
    name = "openshell-credentials"
  }

  depends_on = [google_container_node_pool.primary_nodes]
}

resource "kubernetes_namespace_v1" "cert_manager" {
  metadata {
    name = "cert-manager"
  }

  depends_on = [google_container_node_pool.primary_nodes]
}

resource "kubernetes_namespace_v1" "envoy_gateway_system" {
  metadata {
    name = "envoy-gateway-system"
  }

  depends_on = [google_container_node_pool.primary_nodes]
}

# ---------------------------------------------------------------------------
# Tenant namespaces with isolation labels
# ---------------------------------------------------------------------------

resource "kubernetes_namespace_v1" "tenants" {
  for_each = toset(var.tenants)

  metadata {
    name = each.key

    labels = {
      tenant                               = each.key
      "openshell.ai/workspace-allowed"     = "true"
      "pod-security.kubernetes.io/enforce" = "restricted"
    }
  }

  depends_on = [google_container_node_pool.primary_nodes]
}
