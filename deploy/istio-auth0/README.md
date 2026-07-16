# Production authentication with Istio and Auth0

This deployment boundary uses Auth0 Universal Login for the browser and Istio's
JWT authentication filter for the API. The browser requests an **access token**
for an Auth0 custom API and sends it as `Authorization: Bearer <token>` on every
`/api/*` request. Istio validates the signature, issuer, audience, and expiry
before the request reaches AI Fleet. Envoy places the verified, base64-encoded
JWT payload in `x-ai-fleet-jwt-payload` for the application middleware.

The policy deliberately leaves the SPA, JavaScript, styles, and OAuth callback
routes public. They must load before an unauthenticated browser can start Auth0
Universal Login. Except for `/api/auth/config`, all non-`OPTIONS` API requests
require a verified JWT.

## Prerequisites

1. Create an Auth0 **Single Page Application** and use Authorization Code Flow
   with PKCE. Configure the production origin as an allowed callback URL,
   logout URL, and web origin.
2. Create an Auth0 **custom API**. Use its API identifier as the audience and
   use an asymmetric JWT signing algorithm such as RS256. Enable RBAC and the
   option to include permissions in access tokens, create the `fleet:access`
   permission, and grant it only to trusted operators. Do not send an ID token
   to the API.
3. Deploy the gateway with this exact pod label:

   ```yaml
   app.kubernetes.io/name: ai-fleet-gateway
   ```

4. Enable Istio sidecar injection for the gateway pod and expose only the
   gateway service through ingress. The gateway Service must be an internal
   `ClusterIP`, never a direct `LoadBalancer` or `NodePort`. Planner and coder
   services must also remain internal.
5. Configure the gateway application to trust `x-ai-fleet-jwt-payload` only in
   its production Istio authentication mode. Do not enable proxy-header trust
   when the application can be reached without the sidecar policy.

## Application environment

Set these variables on the gateway container. They are browser OAuth metadata,
not a confidential Auth0 client secret; this application uses a public SPA
client with Authorization Code Flow and PKCE.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV=production` | Yes | Enables production runtime behavior and refuses startup unless Istio authentication is fully configured. |
| `AUTH_MODE=istio` | Yes | Enables fail-closed Istio proxy-header authentication. Local development defaults to `disabled`. |
| `AUTH0_DOMAIN` | Yes | Auth0 tenant or custom-domain hostname only, without scheme or path. |
| `AUTH0_CLIENT_ID` | Yes | Auth0 Single Page Application client ID. |
| `AUTH0_AUDIENCE` | Yes | Auth0 custom API identifier; it must exactly match the audience rendered into `security.yaml.tmpl`. |
| `AUTH0_REQUIRED_PERMISSION` | Yes | Auth0 API permission required by both Istio and the gateway, normally `fleet:access`. |
| `AUTH0_REDIRECT_URI` | Yes | Absolute HTTPS callback URI registered in Auth0, normally `https://fleet.example.com/`. |
| `AUTH0_LOGOUT_RETURN_TO` | No | Absolute HTTPS post-logout URI registered in Auth0; defaults to the redirect URI's origin. |
| `AUTH0_SCOPE` | No | OAuth scopes; defaults to `openid profile email`. Add API scopes only when corresponding authorization is enforced. |
| `AUTH0_ORGANIZATION` | No | Auth0 Organization ID used for organization-bound login; when set, the gateway requires an exact matching `org_id` claim. |

Example gateway container configuration:

```yaml
env:
  - name: NODE_ENV
    value: production
  - name: AUTH_MODE
    value: istio
  - name: AUTH0_DOMAIN
    value: YOUR_TENANT.REGION.auth0.com
  - name: AUTH0_CLIENT_ID
    value: YOUR_PUBLIC_SPA_CLIENT_ID
  - name: AUTH0_AUDIENCE
    value: https://api.ai-fleet.example.com
  - name: AUTH0_REQUIRED_PERMISSION
    value: fleet:access
  - name: AUTH0_REDIRECT_URI
    value: https://fleet.example.com/
  - name: AUTH0_LOGOUT_RETURN_TO
    value: https://fleet.example.com/
  - name: AUTH0_SCOPE
    value: openid profile email
  # Omit when Auth0 Organizations are not used.
  - name: AUTH0_ORGANIZATION
    value: org_REPLACE_ME
```

Do not configure an Auth0 client secret in the browser-facing gateway.

## Render and apply

Auth0's issuer must use exactly the same domain that issued the token and must
include the trailing slash.

```bash
export AI_FLEET_NAMESPACE=ai-fleet
export AUTH0_DOMAIN=YOUR_TENANT.REGION.auth0.com
export AUTH0_AUDIENCE=https://api.ai-fleet.example.com
export AUTH0_REQUIRED_PERMISSION=fleet:access

envsubst < deploy/istio-auth0/security.yaml.tmpl \
  | istioctl analyze --use-kube=false -

envsubst < deploy/istio-auth0/security.yaml.tmpl \
  | kubectl apply -f -
```

## Protect planner and coder

`internal-services-mtls.yaml.tmpl` puts the planner and coder workloads in
Istio `STRICT` mTLS mode. Its `ALLOW` policies accept their HTTP API paths only
from the gateway Kubernetes service account; the presence of an `ALLOW` policy
means every non-matching source or path is denied.

Before applying it, give the gateway a dedicated service account and make sure
all three workloads have injected, ready sidecars. The template expects these
workload labels:

```yaml
app.kubernetes.io/name: ai-fleet-gateway
app.kubernetes.io/name: ai-fleet-planner
app.kubernetes.io/name: ai-fleet-coder
```

Render and apply the internal policy:

```bash
export AI_FLEET_NAMESPACE=ai-fleet
export AI_FLEET_GATEWAY_NAMESPACE=ai-fleet
export AI_FLEET_GATEWAY_SERVICE_ACCOUNT=ai-fleet-gateway

envsubst < deploy/istio-auth0/internal-services-mtls.yaml.tmpl \
  | istioctl analyze --use-kube=false -

envsubst < deploy/istio-auth0/internal-services-mtls.yaml.tmpl \
  | kubectl apply -f -
```

The gateway, planner, and coder Deployments must set distinct
`serviceAccountName` values. Do not run the gateway under the namespace's
`default` service account, because any pod using that identity would inherit
the same access. Istio auto-mTLS handles the gateway's outbound connection once
both source and destination sidecars are ready; no bearer token is forwarded to
the internal services. Name the Service ports with an `http-` prefix (or set
`appProtocol: http`) and keep Istio's HTTP-probe rewriting enabled if Kubernetes
liveness/readiness probes are added later.

The optional `network-policy.yaml.tmpl` limits gateway ingress to the standard
Istio ingress-gateway pods. Confirm the namespace, workload label, service port,
and that the cluster CNI enforces `NetworkPolicy` before applying it:

```bash
export ISTIO_INGRESS_NAMESPACE=istio-system

envsubst < deploy/istio-auth0/network-policy.yaml.tmpl \
  | kubectl apply --dry-run=server -f -

envsubst < deploy/istio-auth0/network-policy.yaml.tmpl \
  | kubectl apply -f -
```

If the ingress gateway uses a revision-specific or custom workload label,
replace `istio: ingressgateway` in the template before applying it. An incorrect
selector will make the gateway unreachable.

Set `AUTH0_DOMAIN` to a custom Auth0 domain if that is the domain used during
login. Supply only the hostname: no scheme, path, or trailing slash. Never mix
the tenant domain and custom domain.

## Verify before rollout

Run the checks against the public gateway URL. A missing token is denied by the
authorization policy, while an invalid token is rejected by JWT validation.

```bash
curl -i https://fleet.example.com/
curl -i https://fleet.example.com/api/settings
curl -i -H 'Authorization: Bearer invalid' \
  https://fleet.example.com/api/settings
curl -i -H "Authorization: Bearer ${AUTH0_ACCESS_TOKEN}" \
  https://fleet.example.com/api/settings
```

Expected results:

| Request | Expected result |
| --- | --- |
| SPA without a token | `200` |
| API without a token | `403` from Istio |
| API with an invalid token | `401` from Istio |
| API with a valid access token | Application response |

Roll the authorization policy out in Istio dry-run/audit mode first when adding
it to an existing production environment, then inspect proxy authorization logs
before enforcing it.

## Recommended rollout order

1. Configure the Auth0 SPA/custom API and register the exact callback, logout,
   and web origins. Confirm an access token contains the expected `iss`, `aud`,
   `sub`, expiry, and `fleet:access` permission claims.
2. Assign dedicated Kubernetes service accounts, add the documented workload
   labels, inject sidecars into gateway/planner/coder, and wait for every proxy
   to become ready. Keep all application Services internal.
3. Apply `RequestAuthentication` and deploy the edge `AuthorizationPolicy` with
   the `istio.io/dry-run: "true"` annotation first. Test missing, invalid, and
   valid access tokens and inspect Istio authorization telemetry.
4. Deploy the gateway with all Auth0 variables and `AUTH_MODE=istio`, then
   enforce the edge policy in the same controlled rollout. A partially updated
   rollout can otherwise either deny every API request or leave an unprotected
   replica available.
5. Apply `internal-services-mtls.yaml.tmpl`, then exercise both proxied agent
   APIs through the gateway. Confirm a different in-mesh service account is
   denied before proceeding.
6. Apply the optional gateway `NetworkPolicy` last. Keep a tested rollback path
   and use a canary namespace or workload revision for the first production
   deployment.

Never enable `AUTH_MODE=istio` on a gateway that is reachable around Envoy. If
emergency rollback requires disabling application authentication, first keep or
restore an enforcing edge policy so the public API does not become anonymous.

## Security invariants

- `forwardOriginalToken: false` keeps the bearer token out of the Node services.
- Envoy emits `x-ai-fleet-jwt-payload` only for a verified JWT. The application
  must still fail closed if that header is absent or malformed in production.
- The audience is pinned to the AI Fleet custom API, so an Auth0 token minted
  for another API is not accepted.
- Istio and the gateway both require the configured Auth0 permission. Every
  accepted operator currently has the same access; add finer route-level
  policies if individual operations need different roles.
- Network policy and service exposure must prevent bypassing the Istio sidecar.
  The header is not a security boundary on a directly reachable Node port. A
  gateway Service exposed outside the mesh makes proxy-header authentication
  unsafe even if the Istio resources themselves are correct.

## References

- [Istio RequestAuthentication](https://istio.io/latest/docs/reference/config/security/request_authentication/)
- [Istio AuthorizationPolicy](https://istio.io/latest/docs/reference/config/security/authorization-policy/)
- [Istio PeerAuthentication](https://istio.io/latest/docs/reference/config/security/peer_authentication/)
- [Istio auto-mTLS behavior](https://istio.io/latest/docs/ops/configuration/traffic-management/tls-configuration/)
- [Auth0 token guidance](https://auth0.com/docs/secure/tokens)
