# ---------------------------------------------------------------------------
# Per-tenant isolation: NetworkPolicies, quotas, limits, RBAC, workspace chart
# ---------------------------------------------------------------------------

locals {
  admin_domain = contains(split("@", var.cert_email), "@") ? element(split("@", var.cert_email), 1) : "example.com"
}

# 1. Default deny-all NetworkPolicy
resource "kubernetes_network_policy_v1" "tenant_default_deny" {
  for_each = toset(var.tenants)

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
  for_each = toset(var.tenants)

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
  for_each = toset(var.tenants)

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
  for_each = toset(var.tenants)

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
  for_each = toset(var.tenants)

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
  for_each = toset(var.tenants)

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

# 6. OpenShell workspace release per tenant (vendored chart)
#
# The helm provider does not hash local chart-directory contents, so chart
# edits alone would plan as no-op. Checksum the whole chart dir via
# archive_file and feed it in as a value: any file change under
# charts/openshell-workspace changes global.chartHash → an in-place helm
# upgrade. This is what the openshell-workspace-deploy.yml workflow relies on.
data "archive_file" "workspace_chart" {
  type        = "zip"
  source_dir  = "${path.module}/charts/openshell-workspace"
  output_path = "${path.module}/.chart-cache/openshell-workspace.zip"
}

resource "helm_release" "tenant_workspace" {
  for_each = toset(var.tenants)

  name      = "openshell-workspace-${each.key}"
  chart     = "${path.module}/charts/openshell-workspace"
  namespace = kubernetes_namespace_v1.tenants[each.key].metadata[0].name
  wait      = true

  set {
    name  = "global.chartHash"
    value = data.archive_file.workspace_chart.output_base64sha256
    type  = "string"
  }

  values = [
    yamlencode({
      gateway = {
        serviceAccount = {
          name      = "openshell"
          namespace = kubernetes_namespace_v1.openshell.metadata[0].name
        }
      }
    })
  ]

  depends_on = [
    helm_release.openshell,
    kubernetes_role_binding_v1.tenant_admins,
  ]
}
