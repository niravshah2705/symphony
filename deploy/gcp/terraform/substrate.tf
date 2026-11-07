# -----------------------------------------------------------------------------
# Substrate agent pattern — the environment surface. This file declares NO
# resources; it turns the substrate_* variables into the env maps the services
# read, and says which workloads get them.
# -----------------------------------------------------------------------------
# Why this needs writing down at all: every consumer of these names
# (packages/shared-core/src/config.js SUBSTRATE, agent/substrate.js,
# services/planner/src/jwks.js) falls back to an inert default when the variable
# is absent, so a deployment with the substrate root applied and this root
# unchanged does not fail — it just keeps running the shared pattern and reports
# "Substrate is not configured" in a status field nobody reads. Stage C's
# org→atespace binding and Stage D's login-triggered init are both unreachable
# from a cloud deployment until the address plus the binding table reach the
# containers that would use them.
#
# Placement rules, in order of how much they cost to get wrong:
#   - The control-plane address goes on the services that DISPATCH a run
#     (planner, coder-control) and the one that CREATES spaces (provisioner).
#   - It never goes on coder-worker on the SHARED stack: that container
#     executes model-generated code, and this deployment's own identity reaches
#     every tenant's namespace, so the address converts a workload into a caller
#     that can create, assign and delete actors it does not own. A per-tenant
#     stack may pass it down (see packages/shared-core/src/provisioning/plan.js)
#     because there SUBSTRATE_ALLOWED_ATESPACES pins one nameable space and the
#     in-cluster Role reaches only that namespace — the same allowance with
#     different confinement.
#   - The actor-callback group (mode + JWKS + audience + trust domain) goes on the
#     planner ONLY, because that is the one service with the endpoint that
#     verifies an actor's JWT. It opens only when substrate_actor_member names the
#     identity allowed to invoke the planner too (the run.invoker binding in
#     iam.tf) — a router mounted with no invoker is a refused call, and an invoker
#     without verification is an open prompt endpoint on behalf of any org.
#   - No credential lives in these maps. substrate.js also honours a
#     SUBSTRATE_TOKEN bearer for the control plane; it stays unwired here on
#     purpose — a bearer in a plaintext env map would be printed by an agent
#     `env`, and the day the control plane requires one it goes in through
#     Secret Manager as a secret env, not into local.substrate_control_env.

locals {
  # Blank URL is the whole switch: DEFAULT_SUBSTRATE_URL is '' in
  # packages/shared-core/src/agent/substrate.js, and the services treat an unset
  # URL as "pattern not configured" and refuse before doing any work. Emitting
  # the other keys anyway would be worse than emitting none — a deployment that
  # can resolve an atespace but cannot dial anything fails mid-run, after
  # admission has already accepted the request.
  substrate_enabled = trimspace(var.substrate_url) != ""

  # The JS side parses both of these out of ONE string each (comma-separated
  # pairs / comma-separated names), so the HCL has to produce exactly that
  # shape. A map `for` iterates in sorted key order, which keeps the rendered
  # string byte-stable across applies instead of reshuffling it on each plan.
  substrate_allowed_atespaces = join(",", var.substrate_allowed_atespaces)
  substrate_atespace_by_org = join(",", [
    for org, space in var.substrate_atespace_by_org : "${org}=${space}"
  ])

  substrate_control_env = local.substrate_enabled ? merge(
    {
      SUBSTRATE_URL          = var.substrate_url
      SUBSTRATE_WORKER_POOL  = var.substrate_worker_pool
      SUBSTRATE_TIMEOUT_MS   = tostring(var.substrate_timeout_ms)
      SUBSTRATE_ACTOR_TTL_MS = tostring(var.substrate_actor_ttl_ms)
    },
    # Keys stay absent rather than set to "" when unset: each one already has a
    # default in config.js, and an empty string here would silently win over a
    # value an operator put in the org's settings instead.
    trimspace(var.substrate_ingress_url) != "" ? { SUBSTRATE_INGRESS_URL = trimspace(var.substrate_ingress_url) } : {},
    trimspace(var.substrate_atespace) != "" ? { SUBSTRATE_ATESPACE = trimspace(var.substrate_atespace) } : {},
    trimspace(var.substrate_planner_image) != "" ? { SUBSTRATE_PLANNER_IMAGE = trimspace(var.substrate_planner_image) } : {},
    length(var.substrate_allowed_atespaces) > 0 ? { SUBSTRATE_ALLOWED_ATESPACES = local.substrate_allowed_atespaces } : {},
    length(var.substrate_atespace_by_org) > 0 ? { SUBSTRATE_ATESPACE_BY_ORG = local.substrate_atespace_by_org } : {},
  ) : {}

  # Half-configured actor mode is the dangerous shape: the endpoint accepts a
  # prompt on behalf of an organization, so it opens only when the deployment can
  # say WHO is calling AND someone has said that caller may call at all. All four
  # names are emitted together or none, because
  # services/planner/src/routes/substrate-actor.js:118 mounts the router on
  # SUBSTRATE_ACTOR_MODE=true + SUBSTRATE_JWKS_URL while the run.invoker binding in
  # iam.tf is gated by substrate_actor_member. Splitting those is how an operator
  # ends up with a 200-or-403 that depends on which half they remembered, so the
  # env and the IAM binding switch on the same three conditions.
  substrate_actor_env = (
    local.substrate_enabled
    && var.substrate_actor_mode
    && trimspace(var.substrate_actor_member) != ""
    && trimspace(var.substrate_jwks_url) != ""
    ) ? {
    SUBSTRATE_ACTOR_MODE = "true"
    SUBSTRATE_JWKS_URL   = trimspace(var.substrate_jwks_url)
    # The two things that decide what "verified" MEANS travel with the keys that
    # turn verification on, because a JWKS from one trust domain judged against
    # another domain's audience fails closed and looks like a dead cluster.
    SUBSTRATE_ACTOR_JWT_AUDIENCE = var.substrate_actor_jwt_audience
    SUBSTRATE_TRUST_DOMAIN       = var.substrate_trust_domain
  } : {}

  substrate_env = merge(local.substrate_control_env, local.substrate_actor_env)
}
