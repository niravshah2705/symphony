# fleet-local — authentication configuration (setup step 10)

The identity contract from browser to actor. Everything here is installed by
`scripts/setup-env.sh` steps 1/3/7/8/9; this page documents the resulting
configuration and WHY each piece exists (provenance: plan §"Identity & header
contract", T-08, T-09 work).

## The chain in one picture

```
browser ─TLS(mkcert)─► ingress-nginx ─strip spoofables─► oauth2-proxy ──► BFF / kagent-UI
                          │                                │
                          │            Google OIDC (auth code + prompt=none silent reauth)
                          ▼                                ▼
              kagent controller :8083  ◄──Bearer <Google ID token>── (via UI forwarding / BFF)
              auth.mode=trusted-proxy, userIdClaim=email
                          ▼ actor bootstrap through atenet-egress (Gateway injects actor JWT)
              gVisor actor ──team virtual key + ModelConfig.defaultHeaders + baggage──► LiteLLM
              LiteLLM ──fleet_metadata pre-call hook──► Flexprice ai.usage + Langfuse (UUID identity)
```

Each hop enforces its OWN response deadline, so the shortest one on the path is
the one that fails: nginx `proxy-read-timeout` 1800s, oauth2-proxy
`--upstream-timeout` 1800s (was its 30s default — see T-18). Raising only the
Ingress annotation buys nothing while the proxy in front of the BFF still gives up
at 30s, which is exactly what a cold actor wake overruns.

## 1. Edge — Google OAuth via oauth2-proxy (upstream mode)

* Provider: `--provider=oidc --oidc-issuer-url=https://accounts.google.com`,
  Web client from the Firebase project's GCP console.
  Redirect URIs (must be whitelisted in GCP, https-only):
  `https://app.fleet.dev/oauth2/callback`, `https://kagent.fleet.dev/oauth2/callback`.
* Two proxies (ns `fleet-system`), host-only cookies `_fleet_oauth` /
  `_kagent_oauth` so the two apps never clobber each other's session.
  `--cookie-refresh=55m`, `--skip-provider-button=true`,
  `--upstream-timeout=1800s` (T-18: the 30s default `502`s the chat's long POST —
  `…/api/agui/…` today, `…/chat` before PR 3 replaced it).
* **The two flags that make trusted-proxy work**: `--set-authorization-header`
  (delivers the Google **ID token** as `Authorization: Bearer …` downstream) and
  `--set-xauthrequest` (adds `X-Auth-Request-Email/User/Preferred-Username`).
* Secrets: `fleet-system/google-oauth` (client-id, client-secret, cookie-secret)
  created by `00-prereqs.sh` from exported env; rendered into the deployments —
  never in a committed file.
* TLS: mkcert SAN `app.fleet.dev` + `kagent.fleet.dev` only →
  `fleet-system/fleet-local-tls`; `/etc/hosts` points both at 127.0.0.1. The
  flexprice hosts stay plain HTTP behind the same nginx (unchanged).

## 2. Header sanitisation (nginx) — required, not cosmetic

`deploy/ingress/{app,kagent}.yaml` carry a `configuration-snippet` that sets to
empty every identity-bearing inbound header a client could spoof:
`X-Auth-Request-*`, `X-Forwarded-User/Email`, `X-Fleet-*`, `X-User-Id`,
`X-Agent-Name`. Without it, anyone could `curl -H "X-Auth-Request-Email: ceo@…"`
past the whole chain. Needs controller config `allow-snippet-annotations=true`
(set in `deploy/setup/ingress-nginx-values.yaml`; `10-ingress-oauth.sh` patches
it on older installs). The kagent UI nginx additionally forwards only the
allowlist in `ui.additionalForwardedHeaders` and always strips `X-User-Id` /
`X-Agent-Name` itself. Verify with gate point 10 in `verify-e2e.sh`.

Transient gotcha: repeated silent reauth (`prompt=none`) round-trips can leave
duplicate `_fleet_oauth` cookies → "Unable to find a valid CSRF token". Clear
site cookies for app.fleet.dev; it does not indicate misconfiguration.

## 3. kagent controller — trusted-proxy

`deploy/kagent/values-base.yaml` (fresh) ≡ `deploy/kagent/values-patch.yaml`
(patch of an existing release), one shape:

```yaml
config.server.auth:
  mode: trusted-proxy      # valid modes: insecure | trusted-proxy
  userIdClaim: email       # principal = trusted-proxy:https://accounts.google.com:<email>
ui.additionalForwardedHeaders: [X-Auth-Request-Email, X-Auth-Request-User, X-Auth-Request-Preferred-Username]
```

**Security model — read this twice:** trusted-proxy parses the Bearer JWT
claims WITHOUT verifying the signature. A self-signed token with a valid-shaped
`email` claim is accepted (that is exactly how the headless wake probe works).
The ONLY thing making this safe is the NetworkPolicy:

`deploy/networkpolicy/kagent-controller.yaml` (name `kagent-controller-ingress`,
ns `kagent`) admits :8083 from exactly three sources:
1. ns `kagent` (UI/tools),
2. ns `fleet-system` (BFF + oauth2-proxy),
3. ns `ate-system` **AND** `app=atenet-egress` — the actor bootstrap path (T-08).
   Remove it and every golden build dies on `GetBootstrapConfig` with ~3 s
   upstream connect timeouts; add loose selectors and you expose an
   impersonation endpoint. Keep it verbatim.

Background jobs from the BFF authenticate with a service-account token
(TokenReview-able) instead of a user ID token.

**Cluster preconditions live OUTSIDE helm.** Two objects the controller's own
postgres auth depends on are owned by the substrate install, not the kagent
release: the podcertificate-controller signer allowlist arg
`--postgres-client=kagent/kagent-controller=kagent_owner_user,kagent_readwrite_user`
(added to a deployment `kubectl apply`-ed by ate-setup) and the
`hostssl atepg kagent_owner_user,kagent_readwrite_user all cert` line in the
`postgres-config` ConfigMap's pg_hba.conf. A substrate rerun (setup step 6)
reverts both silently, and the kagent ns label `ate.dev/api-access=true`
(gate §1a) is likewise re-rendered by the parent release. `scripts/setup/s07-kagent.sh`
therefore re-asserts all three on every run — do not treat a green step 6 as
permission to skip step 7 (details: TROUBLESHOOTING.md T-15 items 11–14).

## 4. Actor egress bootstrap — the second, invisible auth layer

Actors hold no raw third-party credential. Their first action is
`GetBootstrapConfig` to `kagent-controller.kagent.svc:8083` **through the
atenet-egress agentgateway**, whose `substrateEgress` policy
(`cm/atenet-egress-agentgateway-config`, preview gate `GoldenEgressPolicy`)
injects the bootstrap `Authorization: Bearer <actor JWT, aud=kagent-bootstrap>`
minted via the credential provider. Delete that policy and the gateway rejects
every tunnel itself ("missing substrate egress request policy"). Actor→LiteLLM
traffic uses the per-org **team virtual key** only; provider keys never enter
an actor container env.

## 5. Identity below the controller — UUID convention

One canonical UUID per org / project reused verbatim everywhere (minted by the
wizard; adopted, never re-minted, on re-runs):

| Hop | Carries | Mechanism |
|---|---|---|
| BFF → controller | user ID token + `traceparent` + `baggage: fleet_org_id,fleet_project_id,fleet_user_id` | kagent proxy |
| actor → LiteLLM | `baggage` survives (`OTEL_PROPAGATORS=tracecontext,baggage` in Harness env) + static `x-fleet-org-id` / `x-fleet-project-id` (`ModelConfig.defaultHeaders`) | team key identifies org/team; headers identify project |
| LiteLLM → billing | `fleet_metadata.fleet_hook` pre-call copies baggage → `data["user"]` + `litellm_metadata` (tags, session_id, fleet UUIDs); vendored `flexprice_callback` posts `ai.usage` with `external_customer_id = <org uuid>` (bare, no prefix) | Langfuse gets userId=email, sessionId=context |

Budget enforcement is pure configuration: LiteLLM native
`max_budget`/`budget_duration` on org/team/key (429 at limit) + Flexprice
wallet/alerts. No custom enforcement code is deployed.

## 6. Where every credential lives (rotate accordingly)

| Secret (ns) | Contents | Created by | Notes |
|---|---|---|---|
| `google-oauth` (fleet-system) | client id/secret, cookie secret | `00-prereqs.sh` | from exported env; re-create to rotate |
| `fleet-local-tls` (fleet-system) | mkcert TLS pair | `00-prereqs.sh` | CA trust = `mkcert -install` per machine |
| `litellm-masterkey` (litellm) | proxy admin key | `setup/s03-litellm.sh` (generated) | read inline: `kubectl -n litellm get secret litellm-masterkey -o jsonpath='{.data.masterkey}' \| base64 -d` — never print to shared logs |
| `litellm-fleet-secrets` (litellm) | OpenRouter + Flexprice API keys, URL, env id | `setup/s03-litellm.sh` | delete + re-run step 3 to rotate |
| `litellm-postgres` (litellm) | db creds (copy) | `setup/s03-litellm.sh` | source: `flexprice-postgresql` |
| `litellm-langfuse-keys` (litellm) | Langfuse public/secret keys + host | `30-litellm.sh` | secret key sourced from `langfuse-stores` |
| `langfuse-stores` (langfuse) | postgres pw, salt, encryption key, nextauth, S3 pair, admin pw, LF secret key | `20-langfuse.sh` | generated once; stable across re-runs BY DESIGN (salt/keys are encryption inputs) |
| `fleet-bff-env` (fleet-system) | assembled inline from the secrets above | `50-bff-spa.sh` | re-run script to refresh after rotation |
| per-tenant `litellm-<org>-<proj>` (org-ns) | team virtual key | wizard step 3 | rotate via LiteLLM admin API, then re-secret |
| `kagent-rustfs-credentials`, `substrate-postgres-*` (ate-system) | platform stores | substrate installer | do not copy fleet-side |

Rotation rule of thumb: delete the Secret, re-run the owning script (all
idempotent), then `kubectl -n <ns> rollout restart deploy/<app>` where the
consumer only reads env at start. Nothing sensitive was ever placed in a git
file; `deploy/flexprice/.env` is gitignored and 0600.

> ⚠️ The cluster's LiteLLM master key was pasted into a chat log once — treat it
> as burned and re-mint it:
> `kubectl -n litellm delete secret litellm-masterkey && scripts/setup/s03-litellm.sh`
> (regenerates the Secret; the helm upgrade alone will NOT restart the pod, so
> follow with `kubectl -n litellm rollout restart deploy/litellm`), then refresh
> `fleet-bff-env` via `scripts/50-bff-spa.sh`.
