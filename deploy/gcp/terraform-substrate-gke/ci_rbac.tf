# ---------------------------------------------------------------------------
# RBAC for the cluster power workflow
# ---------------------------------------------------------------------------
# Cordoning and draining needs Kubernetes RBAC on nodes and pods, which the GKE
# IAM roles do not express. `roles/container.admin` (what bootstrap.sh grants)
# maps the caller to cluster-admin, so the workflow already passes and this
# binding is redundant for it — but harmless, and it is the least-privilege
# path for an operator who grants a pool-scoped role such as
# container.nodePoolAdmin instead. Set power_ci_sa_email to the exact
# `secrets.GCP_DEPLOYER_SA` value: the auth webhook presents that service
# account's email as the Kubernetes user name, and an empty variable skips
# both objects.

resource "kubectl_manifest" "power_ci_cluster_role" {
  count = var.power_ci_sa_email == "" ? 0 : 1

  yaml_body = <<YAML
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: substrate-node-maintainer
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "delete"]
  - apiGroups: [""]
    resources: ["pods/eviction"]
    verbs: ["create"]
  - apiGroups: ["apps"]
    resources: ["daemonsets", "replicasets", "statefulsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["get", "list", "watch"]
YAML
}

resource "kubectl_manifest" "power_ci_cluster_role_binding" {
  count = var.power_ci_sa_email == "" ? 0 : 1

  yaml_body = <<YAML
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: substrate-node-maintainer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: substrate-node-maintainer
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: User
    name: ${var.power_ci_sa_email}
YAML

  depends_on = [kubectl_manifest.power_ci_cluster_role]
}
