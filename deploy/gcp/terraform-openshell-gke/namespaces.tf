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

# Inverted from the binding table so a namespace is the instance key: one
# resource per atespace, and the organization that owns it is recorded on the
# namespace itself. Two orgs on one atespace is rejected by the variable's
# validation, not silently collapsed here.
locals {
  tenants = { for org_id, atespace in var.tenant_bindings : atespace => org_id }
}

resource "kubernetes_namespace_v1" "tenants" {
  for_each = local.tenants

  metadata {
    name = each.key

    labels = {
      tenant                           = each.key
      "openshell.ai/workspace-allowed" = "true"
      # Substrate reuses these tenant namespaces as its atespaces; the
      # credential-provider read grant + egress default-deny are applied here
      # when var.substrate_enabled.
      "substrate.ate.dev/atespace"         = var.substrate_enabled ? "true" : "false"
      "pod-security.kubernetes.io/enforce" = "restricted"
    }

    annotations = {
      # Which organization this namespace is reserved for. An annotation, not a
      # label: org ids are not guaranteed to be label-safe, and nothing selects
      # on it — it exists so a mis-bound tenant is readable in-cluster.
      "ai-fleet.internal/organization-id" = each.value
    }
  }

  depends_on = [google_container_node_pool.primary_nodes]
}

# ---------------------------------------------------------------------------
# Agent Substrate namespaces (created only when substrate_enabled)
# ---------------------------------------------------------------------------

# The credential-provider Secret vault. The k8s credential provider reads from
# here via the egress gateway; actors never see the raw values. Mirrors
# openshell-credentials.
resource "kubernetes_namespace_v1" "substrate_credentials" {
  count = var.substrate_enabled ? 1 : 0

  metadata {
    name = var.substrate_credentials_namespace

    labels = {
      "substrate.ate.dev/credential-provider" = "true"
      "pod-security.kubernetes.io/enforce"    = "restricted"
    }
  }

  depends_on = [google_container_node_pool.primary_nodes]
}

