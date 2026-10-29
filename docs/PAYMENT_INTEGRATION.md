# Payment Integration & Billing Configuration Guide

This document describes how to configure environment variables and secrets for the Billing microservice, Cashfree Payments integration, and auto-renew threshold execution across local development, Google Cloud Platform (Cloud Run, Secret Manager, Terraform), and multi-tenant vaults.

---

## 1. Overview of Variables & Secrets

| Variable | Sensitive? | Purpose | Default / Example |
|---|---|---|---|
| `CASHFREE_APP_ID` | **Yes** | Cashfree merchant App ID (client ID) | Test: `TEST10...` / Prod: `1438233e...` |
| `CASHFREE_SECRET_KEY` | **Yes** | Cashfree API Secret Key (client secret) | `cfsk_ma_...` |
| `CASHFREE_BASE_URL` | No | Cashfree Base URL (Sandbox or Production) | `https://sandbox.cashfree.com` or `https://api.cashfree.com` |
| `CASHFREE_ENV` | No | Cashfree target environment | `sandbox` (default) or `production` |
| `BILLING_SERVICE_PORT` | No | Local HTTP listen port for billing service | `4050` (in container: `8080`) |
| `BILLING_URL` | No | Base URL for billing service S2S calls | `http://localhost:4050` |
| `BILLING_SWEEP_ENABLED` | No | Enables hourly usage sweep & auto-recharge | `true` |
| `BILLING_RECHARGE_INTERVAL_MIN` | No | Schedule interval in minutes for auto-recharge | `60` |
| `BILLING_NOTIFY_EMAIL` | No | Email address for low-balance notifications | `billing-alerts@example.com` |
| `BILLING_SLACK_WEBHOOK_URL` | **Yes** | Incoming webhook URL for Slack alerts | `https://hooks.slack.com/services/...` |
| `INTERNAL_API_TOKEN` | **Yes** | Shared internal S2S token for local dev | Random 32-byte string |

---

## 2. Where to Set Variables

### A. GitHub Actions Secrets & Variables (CI/CD)

For automated workflows, tests, and deployments via GitHub Actions:

1. **GitHub Environment / Repository Variables (`vars`)**:
   - `CASHFREE_BASE_URL`: `https://sandbox.cashfree.com` (or `https://api.cashfree.com` for production)
   - Configure via GitHub CLI or Web UI:
     ```bash
     gh variable set CASHFREE_BASE_URL --body "https://sandbox.cashfree.com"
     ```

2. **GitHub Actions Secrets (`secrets`)**:
   - `CASHFREE_APP_ID`: Always passed as an env var/secret (`CASHFREE_APP_ID`).
   - `CASHFREE_SECRET_KEY`: Always passed as an env var/secret (`CASHFREE_SECRET_KEY`).
   - Configure via GitHub CLI:
     ```bash
     gh secret set CASHFREE_APP_ID --body "<YOUR_APP_ID>"
     gh secret set CASHFREE_SECRET_KEY --body "<YOUR_SECRET_KEY>"
     ```
   *(Note: API keys are maintained securely in GitHub Secrets and must never be committed to source control).*

---

### B. Local Development (`.env` file)

In local development, all services inherit variables from the root `.env` file. Create or edit `.env` in the root of the repository:

```bash
# Cashfree Credentials (get from Cashfree Merchant Dashboard > Developers > API Keys)
CASHFREE_APP_ID=TEST10385923abcdef123456789
CASHFREE_SECRET_KEY=cfsk_ma_test_abcdef0123456789...
CASHFREE_ENV=sandbox

# Billing Microservice Ports & Knobs
BILLING_SERVICE_PORT=4050
BILLING_URL=http://localhost:4050
BILLING_SWEEP_ENABLED=true
BILLING_RECHARGE_INTERVAL_MIN=60

# Optional Notifications
BILLING_NOTIFY_EMAIL=admin@example.com
BILLING_SLACK_WEBHOOK_URL=
```

When running `npm start`, the dev runner boots the billing service on port `4050` and the gateway on port `3000`. The gateway proxies `/api/billing/*` to `BILLING_URL`.

---

### B. Google Cloud Platform / Production (Cloud Run + Secret Manager)

In staging and production, credentials are never passed via raw environment variables in plaintext. They are managed through **Google Cloud Secret Manager** and mounted into the Cloud Run container.

#### 1. Store Secrets in Google Cloud Secret Manager
Create the secrets in your GCP project:
```bash
# Add Cashfree App ID
echo -n "YOUR_CASHFREE_APP_ID" | gcloud secrets create cashfree-app-id \
  --project="YOUR_GCP_PROJECT_ID" \
  --replication-policy="automatic" \
  --data-file=-

# Add Cashfree Secret Key
echo -n "YOUR_CASHFREE_SECRET_KEY" | gcloud secrets create cashfree-secret-key \
  --project="YOUR_GCP_PROJECT_ID" \
  --replication-policy="automatic" \
  --data-file=-
```

#### 2. Configure Terraform (`deploy/gcp/terraform/terraform.tfvars`)
In your Terraform configuration, reference the secret names:
```hcl
billing_service_name         = "billing"
cashfree_app_id_secret_id    = "cashfree-app-id"
cashfree_secret_key_secret_id = "cashfree-secret-key"
cashfree_env                 = "production"  # or "sandbox"
billing_schedule             = "0 * * * *"   # hourly cadence
```

#### 3. Cloud Run Service (`deploy/gcp/terraform/billing_service.tf`)
Terraform automatically mounts these secrets into the Cloud Run container under `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY` via `value_source.secret_key_ref`, granting the `billing-sa` service account `roles/secretmanager.secretAccessor`.

---

### C. Multi-Tenant Vault (`services/settings`)

In multi-tenant deployments where individual organizations bring their own payment credentials:
1. Keys are encrypted per-tenant using **GCP KMS envelope encryption**.
2. Stored in Firestore under: `organizations/{org_id}/secrets/vault`.
3. Secret keys:
   - `CASHFREE_APP_ID`
   - `CASHFREE_SECRET_KEY`
   - `CASHFREE_ENV`
4. The Settings service resolves these keys for the billing service via the internal S2S endpoint (`GET /internal/s2s/orgs/{org_id}/secrets`).

---

## 3. Cashfree Merchant Dashboard Configuration

To enable automated webhooks and recurring mandate authorization redirects:

### 1. Webhook Configuration
1. Log in to the [Cashfree Merchant Dashboard](https://merchant.cashfree.com).
2. Go to: **Payment Gateway > Developers > Webhooks**.
3. Click **Add Webhook Endpoint**.
4. Set URL to:
   ```
   https://<YOUR_GATEWAY_DOMAIN>/api/billing/cashfree/webhook
   ```
5. Select event subscriptions:
   - `SUBSCRIPTION_STATUS_CHANGE`
   - `SUBSCRIPTION_PAYMENT_SUCCESS`
   - `SUBSCRIPTION_PAYMENT_DECLINED`
   - `SUBSCRIPTION_PAYMENT_FAILED`

### 2. Whitelist Redirect / Return URLs
1. In the Dashboard under **Settings > Whitelist Domains**.
2. Whitelist your frontend application domain:
   ```
   https://<YOUR_GATEWAY_DOMAIN>/#cost
   ```

---

## 4. Standalone Billing UI & Auto-Renew Controls

The dedicated billing microservice exposes two ways to control auto-renew thresholds:

1. **Standalone Basic UI (`GET /` or `GET /ui`)**:
   - Access directly on the billing Cloud Run service (e.g. `http://localhost:4050` or `https://billing-<suffix>.run.app`).
   - Offers real-time service health, store backend status, Cashfree environment indicator, and an interactive form to toggle Auto-Renew, switch between Fixed Amount (₹) and Percentage (%) modes, set trigger thresholds, and trigger manual hourly sweeps.

2. **Main Application SPA (`/#cost`)**:
   - Integrated into the Symphony web dashboard (`public/js/views/cost.js`).
   - Communicates with `/api/billing` via the gateway reverse proxy with user authentication and organization context.
