# AI Fleet

A microservice-decomposed tool for managing Linear projects and running isolated
planner and coder agent services over a shared library. This glossary is the
canonical vocabulary for that product. It defines what terms *are*; it does not
describe configuration, file locations, or current feature flags.

## Language

### Gateways

Three different things are called a "gateway". Only the qualified forms below are
permitted in new writing; bare "gateway" is ambiguous and should be expanded or
dropped.

**App gateway**:
The service that owns request identity for the product — authentication,
organization pinning, and admission of a run. One per stack; the single place a
request is told which organization it belongs to.
_Avoid_: API gateway, main gateway, the gateway

**Model gateway**:
The per-request routing layer that decides which upstream serves an LLM call,
and records what that call cost. Chosen per request by a feature flag, never per
deployment.
_Avoid_: LLM proxy, AI gateway

**agentgateway**:
A specific product — an open-source L7 gateway for LLM, MCP and A2A traffic. A
proper noun, one word, lowercase, not an abbreviation and not a role we get to
redefine. It is one possible model gateway, not the concept itself.

**Harness**:
The agent-runtime technology that executes a run (the SDK, loop, and tool
surface). Answers *what runs the agent*.
_Avoid_: runtime, engine, driver, framework

**Agent pattern**:
How and where an agent run is hosted and isolated. Answers *where the agent
runs*. Orthogonal to harness: the same harness can run under any pattern.
_Avoid_: deployment mode, backend, topology

**Workflow pattern**:
The shape of the pipeline a request moves through — which stages run, in what
order. Orthogonal to both harness and agent pattern.
_Avoid_: agent pattern, flow

### Tenancy

**Organization**:
A tenant: one customer, its users, its configuration, its spend. The canonical
spelling is American.
_Avoid_: account, workspace, customer, tenant (as a synonym), organisation

**Deployment**:
A running instantiation of the product for an organization. An organization may
have more than one; every request is pinned to exactly one for its duration.
_Avoid_: environment, stack (as a synonym)

**Pinned organization**:
The organization a single request has been bound to, and asserted to match the
caller's own scope. The assertion, not the binding, is what makes it a security
boundary.

**Provisioning**:
Creating the infrastructure and initial configuration an organization needs
before its first run. Distinct from a run, and deliberately not implicit —
configuration is an explicit, re-runnable action.
_Avoid_: bootstrap, warm-up, tenant setup

### Money and limits

**Budget**:
A limit on tokens. Not a monetary amount.
_Avoid_: spend cap (when meaning tokens), quota (when meaning tokens)

**Balance**:
An organization's remaining prepaid money, held in the smallest unit of the
currency rather than a float. Drawing it down is what blocks future runs.
_Avoid_: budget, credit, spend

**Billing source**:
Who paid for a single model call: the platform (`managed`) or the organization's
own credential (`customer`). A property of one call, never of a whole
organization — one run can mix both, and only the managed calls draw down
balance.
_Avoid_: BYOK (as a per-call attribute), key owner, provider

**Notional cost**:
What a customer-sourced call *would* have cost the platform had it been
managed-billed. Reported and reconciled, never charged.
_Avoid_: actual cost, savings

### Secrets and egress

**Egress boundary**:
A substitution point where a sentinel becomes a real credential. There are two,
and they are not interchangeable: the sidecar an agent container talks to over
loopback, and the gateway a substrate actor's traffic passes through outside its
sandbox. A run crosses exactly one per outbound call, and each holds its own
credentials.
_Avoid_: the egress proxy (used for both), secret injector (as an umbrella term)

**Egress proxy**:
The sidecar at an agent container's egress boundary. Resolves credentials from
the vault and injects them on the outbound call; it holds the sentinel's
substitution and nothing the container can read back.
_Avoid_: outbound gateway, sidecar (when the actor boundary is meant)

**Actor egress**:
The gateway at a substrate actor's egress boundary, reading per-organization
credentials from cluster Secrets. It is a pre-existing second boundary, not a
copy of the sidecar: it terminates the actor's traffic outside the sandbox, where
no in-container env can observe or reach it.
_Avoid_: egress proxy, atenet-egress (in prose), the sidecar

**Decision record**:
The egress proxy's one structured line per request: the route prefix, the outcome
(`forwarded`, `no_route`, `bad_context`, `cred_unavailable`, `redirect_rejected`,
`upstream_error`) and the correlation handles. Never a header value, a resolved
credential, a body or a full query string. It is the unit the egress metrics
count, so a decision that produces no record is a signal nobody can alert on.
_Avoid_: access log (it carries no request line), audit trail

**Durable cost trail**:
The log export of the billing service and the hourly recharge job — the copy that
can still answer a disputed debit after the usage records have been pruned.
Usage records stay the authoritative ledger; a trail is evidence, never a second
ledger.
_Avoid_: cost sink, data warehouse, analytics copy

**Vault**:
The encrypted per-organization store of provider credentials, resolved by the
settings service. There is one resolution path for platform-managed and
customer-supplied keys alike.
_Avoid_: keystore, secrets manager, env
