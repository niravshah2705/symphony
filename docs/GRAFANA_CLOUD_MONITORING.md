# Grafana Cloud monitoring

AI Fleet can run one central Grafana Alloy collector on Cloud Run. It polls
native Cloud Monitoring metrics and sends them to Grafana Cloud Prometheus; a
Cloud Logging sink sends existing Cloud Run logs through Pub/Sub to Alloy and
Grafana Cloud Loki. Application services keep writing to stdout/stderr and do
not receive the Grafana credential.

Monitoring is fail-closed and disabled by default. While disabled, Terraform
creates only the `grafana-cloud-access-token` Secret Manager container and the
required APIs. Enabling it creates a private `grafana-alloy` service with one
always-running instance, its dedicated service account, the log sink, topic,
and pull subscription.

## Values to collect from Grafana Cloud

The Prometheus URL is already defaulted to:

```text
https://prometheus-prod-43-prod-ap-south-1.grafana.net/api/prom/push
```

The supplied `/api/prom` URL is a query base, not a remote-write endpoint; the
collector must use `/api/prom/push`. `grafanacloud-violetcocoa1449-prom` is a
stack/data-source name, not the basic-auth username.

Before enabling, collect these values from the Grafana Cloud connection page:

- the numeric Prometheus metrics instance ID;
- the Loki push URL ending in `/loki/api/v1/push`;
- the Loki username/user ID;
- one access-policy token with both `metrics:write` and `logs:write` scopes.

The usernames/IDs, endpoints, and numeric Secret Manager version are non-secret
configuration. The token is the only secret and must be written directly to
Secret Manager—never to a Terraform variable, GitHub secret, Cloud Build
substitution, image, or file in the repository.

## Two-stage enablement

### 1. Deploy once with monitoring disabled

The default is `false`. Merge/deploy the monitoring infrastructure first so
Terraform creates the empty token secret.

For a project bootstrapped before monitoring support was added, rerun
`deploy/gcp/bootstrap.sh` once (or grant the deployer
`roles/logging.configWriter`) so Terraform can create the project log sink.

For GitHub Actions, force the first complete build so the Alloy image is also
available at the immutable commit tag:

```bash
gh variable set GRAFANA_MONITORING_ENABLED --repo OWNER/REPO --body false
gh workflow run deploy.yml --repo OWNER/REPO -f deploy_all=true
```

Wait for that workflow to finish before adding a token.

### 2. Add the token and enable

Read the token without echoing it, then pipe it directly to Secret Manager:

```bash
read -rsp 'Grafana Cloud access-policy token: ' GRAFANA_TOKEN
printf '%s' "$GRAFANA_TOKEN" | gcloud secrets versions add \
  grafana-cloud-access-token --project PROJECT_ID --data-file=-
unset GRAFANA_TOKEN

TOKEN_NAME="$(gcloud secrets versions list grafana-cloud-access-token \
  --project PROJECT_ID --filter='state=ENABLED' --sort-by='~createTime' \
  --limit=1 --format='value(name)')"
TOKEN_VERSION="${TOKEN_NAME##*/}"
```

Configure the non-secret GitHub variables and exact numeric version:

```bash
gh variable set GRAFANA_METRICS_REMOTE_WRITE_URL --repo OWNER/REPO \
  --body 'https://prometheus-prod-43-prod-ap-south-1.grafana.net/api/prom/push'
gh variable set GRAFANA_METRICS_USERNAME --repo OWNER/REPO --body 'NUMERIC_METRICS_ID'
gh variable set GRAFANA_LOKI_PUSH_URL --repo OWNER/REPO --body 'HTTPS_LOKI_PUSH_URL'
gh variable set GRAFANA_LOKI_USERNAME --repo OWNER/REPO --body 'LOKI_USER_ID'
gh variable set GRAFANA_CLOUD_TOKEN_VERSION --repo OWNER/REPO --body "$TOKEN_VERSION"
gh variable set GRAFANA_MONITORING_ENABLED --repo OWNER/REPO --body true
gh workflow run deploy.yml --repo OWNER/REPO -f deploy_all=true
```

The workflow checks that the selected version is enabled but never accesses
its value. If `GRAFANA_CLOUD_TOKEN_VERSION` is omitted, it resolves the newest
enabled version and still passes that exact number to Terraform; Terraform
deliberately rejects `latest`.

For `deploy/gcp/deploy.sh`, pass the equivalent uppercase environment variables.
It can accept `GRAFANA_CLOUD_TOKEN` for the initial seed; it immediately removes
the inherited variable after capturing it and never passes it to Docker or
Terraform. Cloud Build uses the equivalent underscore-prefixed substitutions,
but does not accept a token value:

```text
_GRAFANA_MONITORING_ENABLED
_GRAFANA_METRICS_REMOTE_WRITE_URL
_GRAFANA_METRICS_USERNAME
_GRAFANA_LOKI_PUSH_URL
_GRAFANA_LOKI_USERNAME
_GRAFANA_CLOUD_TOKEN_VERSION
```

On a new Cloud Build-only project, run once with monitoring disabled, add the
secret version out of band, then rerun with the monitoring substitutions.

## What is collected

Alloy polls at five-minute intervals, except Firebase Hosting at ten minutes,
and exports:

- Cloud Run services and jobs;
- Pub/Sub topics and subscriptions;
- the default Firestore database;
- the configured SPA, skills, and registry buckets;
- the configured Artifact Registry repository;
- Firebase Hosting and Identity Platform;
- consumed-API signals for Scheduler, Secret Manager, and optional KMS;
- Alloy's own scrape, queue, remote-write, and log-source health metrics.

Exact shared resource names and the dedicated-tenant naming contract are
allowlisted. Delegated projects and unrelated project resources are dropped.
Stable `app`, `environment`, `gcp_project_id`, `component`, and `tenancy` labels
are added; request, user, organization, execution, revision, and task IDs are
not promoted into new high-cardinality labels.

The project log sink selects only `cloud_run_revision` entries for AI Fleet
shared/tenant services and `cloud_run_job` entries for shared/tenant coder jobs.
That covers stdout, stderr, Cloud Run request/system logs, and every container in
those resources, including egress-proxy sidecars. It intentionally excludes
unrelated project, audit, and data-access logs. Alloy preserves the incoming
Cloud Logging timestamp and keeps only bounded resource labels for Loki.

This phase does not add traces, dashboards, alerts, JSON conversion, request
IDs, or application/business metrics.

## Validation

Confirm that Cloud Run has exactly one private, always-on collector:

```bash
gcloud run services describe grafana-alloy --project PROJECT_ID \
  --region asia-south1 --format=yaml
gcloud run services logs read grafana-alloy --project PROJECT_ID \
  --region asia-south1 --limit 100
```

The service should report a ready revision, min/max instances of one, and no
`allUsers` invoker. Its startup and liveness probes use `/-/ready`.

In Grafana Explore:

- query metrics with `job=~"integrations/gcp/.*"` and verify Cloud Run,
  Pub/Sub, Firestore, GCS, and Artifact Registry series;
- query `job="integrations/grafana-alloy"` to verify the collector itself;
- query Loki with `{job="integrations/gcp", resource_type="cloud_run_revision"}`;
- generate shared and scratch-tenant traffic and verify both appear while an
  unrelated Cloud Run service does not.

If ingestion fails, inspect Alloy logs and its self-metrics. A bad or revoked
token should cause remote-write/Loki retries and a growing Pub/Sub backlog; it
must not restart or affect the monitored application services.

## Rotation, rollback, and retention

To rotate, add a new Secret Manager version, set
`GRAFANA_CLOUD_TOKEN_VERSION` to its numeric version, and deploy. Verify both
metrics and logs before disabling the old version. Never overwrite an existing
version or use `latest` in Terraform.

To roll back a bad rotation, restore the previous enabled numeric version and
redeploy only the collector configuration. To stop collection, set
`GRAFANA_MONITORING_ENABLED=false` and apply. The empty-capable token secret is
preserved, but the collector, sink, topic, subscription, and any queued logs are
removed.

The pull subscription retains unacknowledged logs for seven days while it
exists, so short collector outages do not lose logs. Alloy's remote-write WAL
uses `/tmp/alloy`, which is ephemeral on Cloud Run; buffered metric samples can
be lost across instance replacement or prolonged Grafana outages. This is
best-effort operational monitoring, not a durable telemetry archive.

Enabling monitoring breaks the otherwise scale-to-zero cost profile: Alloy has
one instance with always-allocated CPU, plus Cloud Logging, Pub/Sub, Cloud
Monitoring API, network egress, and Grafana Cloud usage charges.
