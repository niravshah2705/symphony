# ---------------------------------------------------------------------------
# Namespace
#
# Owned here, not by the chart: every helm_release below runs with
# `create_namespace = false`, so an upgrade can never recreate this object and
# silently drop the Pod Security label, the labels that make the stack findable,
# or the annotation that says who owns it.
# ---------------------------------------------------------------------------

resource "kubernetes_namespace_v1" "flexprice" {
  count = var.flexprice_enabled ? 1 : 0

  metadata {
    name = var.namespace

    labels = merge(local.common_labels, {
      component = "flexprice"
      # `baseline`, not `restricted`, and the reason is in the images rather than
      # in a preference. The FlexPrice app containers would pass restricted — the
      # chart's own podSecurityContext sets runAsNonRoot, RuntimeDefault seccomp
      # and drop ALL. The five databases it depends on do not: templates/infra/
      # postgres.yaml renders `runAsUser: 999` with no runAsNonRoot and no
      # seccompProfile, redis does the same at uid 1000, cp-kafka renders no
      # securityContext at all, and the temporalio/auto-setup entrypoint has to
      # write its rendered config under uid 0. Enforce restricted and the
      # admission controller refuses those pods — the databases never come up,
      # and the symptom (a Pending pod with a namespace-policy annotation in the
      # event) is nowhere near the cause.
      #
      # So restricted is warn + audit instead: nothing breaks, and every pod that
      # could be hardened shows up in its own events. Making the third-party
      # images restricted-clean is a per-image change, not a label edit.
      "pod-security.kubernetes.io/enforce"       = "baseline"
      "pod-security.kubernetes.io/audit"         = "restricted"
      "pod-security.kubernetes.io/warn"          = "restricted"
      "pod-security.kubernetes.io/warn-version"  = "latest"
      "pod-security.kubernetes.io/audit-version" = "latest"
    })

    annotations = {
      "ai-fleet.internal/owner" = "deploy/gcp/terraform-flexprice"
    }
  }

  depends_on = [google_container_node_pool.flexprice]
}
