# -----------------------------------------------------------------------------
# Kagent runtime — the environment surface. Like substrate.tf this file declares
# NO resources; it turns the kagent_* variables into the env map the gateway
# reads, and says which workloads get it.
# -----------------------------------------------------------------------------
# kagent is the in-cluster agent runtime: CRDs in group api.kagent.dev (storage
# v1alpha3) that the platform applies on an operator's cluster when a workflow
# node selects backend 'kagent'. The client is
# packages/shared-core/src/agent/kagent.js, consumed by
# services/gateway/src/routes/workflows.js (/kagent/capabilities and the publish
# endpoint), and it resolves its configuration from CONFIG.KAGENT
# (packages/shared-core/src/config.js).
#
# Every one of those names falls back to an inert default when absent, which is
# exactly the failure mode substrate.tf documents: an apply that forgets to
# render this map does not fail, it keeps answering `kagent_not_configured` on
# publish and shows an empty capabilities list, and the operator learns from a
# 503 they did not expect rather than from a plan error. deploy/gcp/
# kagent-env.test.js holds the two-way contract (names emitted versus names
# read) so neither half of that stays invisible.
#
# Placement rules, in order of how much they cost to get wrong:
#   - The map goes on the gateway ONLY, because that is the only service that
#     imports kagent.js today. It is a control-plane surface: it holds a
#     Kubernetes identity that can create and delete agent CRDs.
#   - It never goes on coder-worker, and it does not go on coder-control or the
#     planner either. Those containers execute or dispatch model-generated code;
#     handing them a cluster address plus a bearer converts a workload into a
#     caller of the Kubernetes API. When planner /runtime/kagent/run lands, the
#     merge moves to the planner deliberately and the test moves with it — a
#     second recipient has to be a decision, not symmetry.
#   - No credential lives in this map. The API token is read from the file named
#     by KAGENT_TOKEN_FILE (mounted as a secret the same way
#     MEMORY_DATABASE_URL_FILE mounts /secrets/memory-db/url), so the env carries
#     a path and the token stays out of `env`, out of plans and out of an agent
#     container's printed environment. KAGENT_KUBECONFIG stays unwired here on
#     purpose for the same reason SUBSTRATE_TOKEN does: a kubeconfig is a bundle
#     of credentials, and it exists only for out-of-cluster local development.

locals {
  # kagent.js refuses to build a client unless BOTH the switch and an address are
  # present (config.enabled gates it, then an empty apiUrl returns null), so a
  # half-configured deployment is the dangerous shape: an address with no switch
  # publishes nothing while a plan shows the URL, and a switch with no address
  # makes /kagent/capabilities report enabled:false forever. Both names therefore
  # appear together or not at all, and the enabled value is the literal the JS
  # regex accepts rather than var.kagent_enabled rendered as "1"/"yes".
  kagent_enabled = var.kagent_enabled && trimspace(var.kagent_api_url) != ""

  kagent_env = local.kagent_enabled ? merge(
    {
      KAGENT_ENABLED   = "true"
      KAGENT_API_URL   = trimspace(var.kagent_api_url)
      KAGENT_NAMESPACE = trimspace(var.kagent_namespace)
      # Numbers cross the wire as strings, as everywhere else in these maps.
      KAGENT_TIMEOUT_MS = tostring(var.kagent_timeout_ms)
    },
    # Optional paths stay absent when unset: kagent.js falls back to the
    # in-cluster service-account mount paths when it is running inside a cluster,
    # and an empty string would beat that fallback with a path that does not
    # exist — after which the token read fails and the client silently returns
    # null, i.e. the same dark state as never having configured kagent.
    trimspace(var.kagent_token_file) != "" ? { KAGENT_TOKEN_FILE = trimspace(var.kagent_token_file) } : {},
    trimspace(var.kagent_ca_file) != "" ? { KAGENT_CA_FILE = trimspace(var.kagent_ca_file) } : {},
  ) : {}
}
