# ---------------------------------------------------------------------------
# Per-tenant isolation: NetworkPolicies, quotas, limits, RBAC
#
# Tenant namespaces here are the OpenShell-era isolation boundary that predates
# Substrate: nothing renders a per-tenant execution surface any more, because
# the Substrate WorkerPool (substrate.tf + the upstream installer) places actor
# pods in its own atespace namespaces. These objects stay because they are what
# makes a tenant namespace cheap to keep — default-deny, DNS-only egress, and a
# resource envelope — and they cost nothing while the pool is the one carrying
# workloads.
# ---------------------------------------------------------------------------

locals {
  admin_domain = contains(split("@", var.cert_email), "@") ? element(split("@", var.cert_email), 1) : "example.com"
}

# 1. Default deny-all NetworkPolicy
resource "kubernetes_network_policy_v1" "tenant_default_deny" {
  for_each = local.tenants

  metadata {
    name      = "default-deny-all"
    namespace = kubernetes_namespace_v1.tenants[each.key].metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress", "Egress"]
  }
}

# 2. Allow DNS egress
resource "kubernetes_network_policy_v1" "tenant_allow_dns" {
  for_each = local.tenants

  metadata {
    name      = "allow-dns"
    namespace = kubernetes_namespace_v1.tenants[each.key].metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Egress"]

    egress {
      to {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = "kube-system"
          }
        }
      }

      ports {
        protocol = "UDP"
        port     = "53"
      }

      ports {
        protocol = "TCP"
        port     = "53"
      }
    }
  }
}

# 3. Tenant resource quota
resource "kubernetes_resource_quota_v1" "tenant_quota" {
  for_each = local.tenants

  metadata {
    name      = "tenant-quota"
    namespace = kubernetes_namespace_v1.tenants[each.key].metadata[0].name
  }

  spec {
    hard = {
      "requests.cpu"           = "16"
      "requests.memory"        = "64Gi"
      "limits.cpu"             = "32"
      "limits.memory"          = "72Gi"
      "pods"                   = "50"
      "persistentvolumeclaims" = "10"
    }
  }
}

# 4. Tenant limit range
resource "kubernetes_limit_range_v1" "tenant_limit_range" {
  for_each = local.tenants

  metadata {
    name      = "tenant-limit-range"
    namespace = kubernetes_namespace_v1.tenants[each.key].metadata[0].name
  }

  spec {
    limit {
      type = "Container"

      default = {
        cpu    = "1"
        memory = "2Gi"
      }

      default_request = {
        cpu    = "100m"
        memory = "256Mi"
      }
    }
  }
}

# 5. Tenant admin RBAC
resource "kubernetes_role_v1" "tenant_admin" {
  for_each = local.tenants

  metadata {
    name      = "tenant-admin"
    namespace = kubernetes_namespace_v1.tenants[each.key].metadata[0].name
  }

  rule {
    api_groups = ["*"]
    resources  = ["*"]
    verbs      = ["*"]
  }
}

resource "kubernetes_role_binding_v1" "tenant_admins" {
  for_each = local.tenants

  metadata {
    name      = "tenant-admins"
    namespace = kubernetes_namespace_v1.tenants[each.key].metadata[0].name
  }

  subject {
    kind      = "Group"
    name      = "${each.key}-admins@${local.admin_domain}"
    api_group = "rbac.authorization.k8s.io"
  }

  role_ref {
    kind      = "Role"
    name      = kubernetes_role_v1.tenant_admin[each.key].metadata[0].name
    api_group = "rbac.authorization.k8s.io"
  }
}
