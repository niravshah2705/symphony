# Microsoft login — setup runbook

How to enable **"Continue with Microsoft"** sign-in. The application code is
already in place; Microsoft login is an optional provider gated by
`AUTH_MICROSOFT_ENABLED`. Because it federates through Firebase, most of the work
is one-time console setup that **cannot be provisioned from code** (the Azure
client secret can't be read back by Terraform, so it lives only in the Firebase
console — the same model as Google).

For the architecture and trust-boundary details see
[`ACCESS_MODEL.md` §2](./ACCESS_MODEL.md).

> **Prerequisite — find your Firebase `authDomain`.** Firebase console →
> **Project settings** → your Web app → `authDomain` (usually
> `<projectId>.firebaseapp.com`, or your `FIREBASE_AUTH_DOMAIN`). You need it for
> the Azure redirect URI below.

---

## Phase 1 — Register an app in Microsoft Entra ID (Azure portal)

1. [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** →
   **App registrations** → **New registration**.
2. **Name**: e.g. `AI Fleet Web`.
3. **Supported account types** — pick to match your intended tenant scope (must
   agree with `MICROSOFT_TENANT` in Phase 3):
   - *Accounts in any org directory **and** personal Microsoft accounts* →
     `MICROSOFT_TENANT=common` (default)
   - *Accounts in any org directory* → `organizations`
   - *This organizational directory only* → your specific tenant id
4. **Redirect URI**: platform **Web**, value = `https://<authDomain>/__/auth/handler`
5. **Register**, then copy the **Application (client) ID** from the *Overview* page.
6. **Certificates & secrets** → **New client secret** → copy the secret **Value**
   immediately (shown once). Note its **expiry** — rotate it before it lapses or
   sign-in will break.
7. API permissions default to Microsoft Graph `openid`, `email`, `profile`,
   `User.Read` — that is sufficient (the app needs `email` back).

## Phase 2 — Enable Microsoft in Firebase (console)

8. Firebase console → **Authentication** → **Sign-in method** → **Add new
   provider** → **Microsoft**.
9. Paste the **Application (client) ID** and the client secret **Value** from
   Phase 1. **This is the only place the secret is stored — never in env vars,
   `config.js`, `/api/auth/config`, or Git.**
10. Confirm the callback URL Firebase displays matches the Azure redirect URI
    (`https://<authDomain>/__/auth/handler`).
11. **Enable / Save.**
12. **Authentication → Settings → Authorized domains** → ensure your app origins
    are listed (`localhost` + your hosting / GCS domains — present by default).

## Phase 3 — Turn on the button (configuration)

The SPA renders **Google first, Microsoft below** when both are enabled, and only
the enabled one when a provider is off.

### Local (`.env` at the repo root)

```bash
AUTH_MODE=firebase
FIREBASE_PROJECT_ID=<your-project>
FIREBASE_API_KEY=<public Firebase web API key>   # public, not a secret
AUTH_MICROSOFT_ENABLED=true
MICROSOFT_TENANT=common          # must match the Azure "account types" choice; alias: AZURE_TENANT_ID
# AUTH_GOOGLE_ENABLED=true       # default; set false to show ONLY Microsoft
```

### Deployed (GCP / Terraform tfvars)

```hcl
auth_microsoft_enabled = true
microsoft_tenant       = "common"
```

Then `terraform plan && terraform apply`. These map to the gateway env vars in
`deploy/gcp/terraform/cloud_run.tf`.

> If you restrict who may sign in, make sure `FIREBASE_ALLOWED_DOMAIN` (single
> domain) or `FIREBASE_ALLOWED_EMAILS` (explicit list) includes your Microsoft
> users' email domains — these gates are email-based and provider-agnostic, so a
> single-domain pin will reject Microsoft users on other domains.

## Phase 4 — Verify

1. `npm start` (or hit the deployed URL). The sign-in card shows **Continue with
   Google**, then **Continue with Microsoft**.
2. Click **Continue with Microsoft** → Microsoft popup → consent → returns signed
   in and loads the authenticated workspace.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `AADSTS50011` (redirect mismatch) | Azure redirect URI must be **exactly** `https://<authDomain>/__/auth/handler`. |
| `AADSTS` tenant error | Azure "supported account types" and `MICROSOFT_TENANT` must agree. |
| Signed in but bounced to the read-only view | The account's `email_verified` is `false` (common for some personal Microsoft accounts; Azure AD work/school accounts are fine). The gateway requires a verified email — this is by design. |
| No Microsoft button | `AUTH_MICROSOFT_ENABLED` is not `true`, or a cached `/api/auth/config` (it is served `no-store`, so hard-reload). |
| Same email already used with Google | Firebase's "one account per email" rejects the second provider (`auth/account-exists-with-different-credential`); the SPA shows a friendly message. Use the provider you first signed in with. Account linking is out of scope. |

## Security notes

- `signInWithPopup` runs the whole OAuth authorization-code + `state` + nonce +
  PKCE exchange inside Firebase ↔ Azure AD; the app never handles `code`,
  `state`, or `redirect_uri` directly.
- The Azure **client secret** stays server-side (Firebase console only). Only the
  public tenant id and the enable flags are exposed to the browser via
  `/api/auth/config`.
- Rotate the Azure client secret before expiry; update it in the Firebase console
  (no code deploy needed).
