# FlexPrice, locally

The Phase 0 billing spike's dependency: a real FlexPrice install, on this laptop,
reachable at `http://127.0.0.1:18080`. Nothing here is deployed, and nothing here
is merged into the root [`compose.yaml`](../../compose.yaml) — that file models the
Cloud Run loopback topology and keeps `npm start` at zero containers. This is a
separate compose project (`fleet-flexprice`) with its own volumes.

## Bring it up

```bash
npm run billing:flexprice:bootstrap
```

That is the only supported entry point. It does six things: pins the checkout to
the commit in [`VERSION`](./VERSION), generates `deploy/flexprice/.env` with real
secrets (mode 0600, values never printed), builds the app image, starts the
infrastructure, runs `./migrate postgres up && ./migrate clickhouse && ./migrate
kafka`, then verifies the result rather than assuming it — `/health`, an
authenticated `GET /v1/tenants`, an *unauthenticated* read that must be refused,
topic and table counts, `schema_migrations` rows, the seeded default tenant, and
that `consumer` and `worker` are actually running.

Starting `compose.yaml` directly fails on `${FLEXPRICE_CHECKOUT:?…}`, and that is
the intended behaviour: without a generated `FLEXPRICE_AUTH_API_KEY_KEYS` you have
a service that authenticates nothing, and a spike run against it proves nothing.

Tear it down (volumes included — see "First boot only" below):

```bash
npm run billing:flexprice:down
```

## What runs

Ten services — four long-running app processes (`api`, `consumer`, `worker`, and
the one-shot `migrate`), four infrastructure stores, one one-shot `seed`, and the
`dev`-profile inspection UIs, which are off by default.

| Service | Image | Host port | Why it is here |
|---|---|---|---|
| `api` | built from `VERSION` | 18080 | everything the Node client calls |
| `consumer` | same image | — | drains Kafka → ClickHouse. Without it, ingest returns `202` and usage queries return nothing **forever**, and 202 looks like success |
| `worker` | same image | — | Temporal workflows: credit expiry, draft finalization, subscription schedulers |
| `migrate` | same image | — | one-shot: Ent schema, then the dbmate versioned files, ClickHouse schema, Kafka topics |
| `seed` | `postgres:17` | — | one-shot: `V1__seed.sql` (Default Tenant, super_admin user, Sandbox + Production environments) after `migrate` succeeds |
| `postgres` | `postgres:17` | 15432 | system of record; also hosts Temporal's own database |
| `kafka` | `confluentinc/cp-kafka:7.7.1` (KRaft) | 19092 | event ingest bus |
| `clickhouse` | `clickhouse/clickhouse-server:24.9-alpine` | 18123 http / 18124 native | usage aggregation and `group_by` reads |
| `redis` | `redis:7-alpine` | 16379 | cache + idempotency |
| `temporal` | `temporalio/auto-setup:1.26.2` | 17233 | scheduled workflows |

Host ports are bound to `127.0.0.1` only. They sit outside the ranges this machine
already uses (4000–4090 and 8000/8100 for the Fleet services, 5432/6379 for
litellm-poc, 8084/8088 for other stacks).

**The store images are tag-pinned, not digest-pinned** — `postgres:17` and
`redis:7-alpine` float to whatever the registry serves today. The plan asked for
digests; this is the deliberate deviation, and the honest scope of it: the FlexPrice
image itself *is* pinned (commit + built image ID in `VERSION`), and for a spike the
stores only need to not change major. A Phase 1 deploy target pins every one of
them by digest.

**One topology, no `minimal` profile.** The plan allowed for a `full`/`minimal`
pair, and the findings killed it: Kafka, ClickHouse and Temporal are load-bearing,
not accelerators — ingest needs the broker, usage reads need ClickHouse, top-up and
expiry need Temporal. A `minimal` profile would be a stack that does not work,
documented as if it did. Item 13's real answer is measured, not assumed; see
"Footprint" below.

## Build, because there is nothing to pull

`ghcr.io/flexprice/flexprice` returns 401 for anonymous pulls and the image is not
on Docker Hub — the published package is private. So the image is built from the
pinned checkout, the same way upstream's own compose produces `flexprice-app:local`.
`FLEXPRICE_CHECKOUT` in `.env` points at that tree; the `image=` line in `VERSION`
records the digest that was built.

## Six ways this stack is easy to get wrong

**First boot only — and a from-scratch boot that does not work.** Postgres seeds
itself from two individually mounted files, `V0__init.sql` (schemas and
extensions, deliberately zero `CREATE TABLE`) and `init-temporal-db.sh` (creates
the database Temporal then migrates). An initialised data directory ignores
`/docker-entrypoint-initdb.d` completely, so editing a seed, restarting, and
seeing no change is the most common way to lose an hour here — `down -v` is part
of the fix, not a destructive last resort.

Upstream mounts the whole `migrations/postgres` directory instead, and on this
pinned commit that **cannot boot from scratch**: the directory mixes pre-Ent
bootstrap with post-Ent schema changes, so `V5__settings_unique_published_only`
runs at initdb time against a `public.settings` table that the Ent migration
layer has not created yet, postgres exits 3, and nothing comes up. Existing
developer volumes hide it, because initdb is first-boot-only. The seed *data*
(`V1__seed.sql`: Default Tenant, the `super_admin` user, Sandbox + Production
environments) is applied by a one-shot `seed` container after `migrate` finishes —
which is the ordering its own header documents ("this file runs twice… tables may
not exist yet, the DO blocks guard against that") and what `make seed-db` does.

The same file's `GRANT ALL PRIVILEGES ON DATABASE temporal TO flexprice` hardcodes
the role name, so `FLEXPRICE_PG_USER` is `flexprice` and not something prettier.

**Health means initialised, not merely running.** The init phase starts a
unix-socket-only server *before* it runs any seed script, and a plain `pg_isready`
answers "accepting connections" the whole time — healthy while the schema is still
empty. The healthcheck therefore also requires the `temporal` database to exist,
which the last init script creates, so `temporal` and `migrate` cannot start
against a half-initialised cluster.

**No `./internal/config` mount — and one env var to pay for it.** Upstream's
compose bind-mounts the checkout's config directory. The loader tries
`internal/config` *before* `./config`, so the mount shadows the `config.yaml`
baked into the image and behaviour then depends on whatever the working tree
happens to contain. This file mounts nothing; every value is set with `FLEXPRICE_*`
env, which is applied by reflection over every leaf key and therefore lands
regardless of which file was loaded.

One setting assumed the mount, though: `rbac.roles_config_path` defaults to
`internal/config/rbac/roles.json`, a path relative to the source tree. Without the
mount the API did not degrade — `api`, `consumer` and `worker` each crashlooped
inside dependency injection, before anything listened on 8080, with
`failed to read config: open internal/config/rbac/roles.json: no such file or
directory`. The image does contain that file (at `/app/config/rbac/roles.json`), so
`FLEXPRICE_RBAC_ROLES_CONFIG_PATH` points at it. That is the price of the no-mount
design, and it is cheap — but it is exactly the kind of thing that reads as a
cosmetic improvement until the container will not start.

**`FLEXPRICE_REDIS_CLUSTER_MODE=false`.** `redis.cluster_mode` defaults to `true`
in upstream's `config.yaml` (it is written for ElastiCache/MemoryDB). Left at the
default, every cache call fails and the app quietly runs on the DB path only —
which still passes most of the spike. It is set explicitly false here.

**Kafka replication factor 1 — and the topic *names* are the expensive half.**
`config.yaml` sizes its topic set for three brokers (`topics_defaults.replication_factor: 3`, `events` at 6 partitions). On one broker `./migrate kafka` does not degrade gracefully: it fails on the first topic with `Replication-factor is invalid … only 1 broker(s) are registered`, the one-shot exits 1, and everything behind it never starts. So the replication factor is overridden, via `FLEXPRICE_KAFKA_TOPICS_DEFAULTS_REPLICATION_FACTOR`.

An earlier version of this file claimed the names could be left alone because "leaving `FLEXPRICE_KAFKA_TOPICS` unset is what keeps the topics the app publishes to identical to the topics that get created". **That claim was false, and the spike ran against a silently billing-zero stack because of it.** `internal/config/config.yaml` mixes two naming conventions in the same file: the producer publishes to `kafka.topic`, which the seed file spells `"staging_events"` (:62), while the consumers that turn events into usage subscribe to `event_processing.topic` (:523) and `meter_usage_tracking.topic` (:546) — both spelled plain `"events"` — and the `kafka.topics` create-list (:99-122) creates the unprefixed names. Nothing reconciles the three. With `KAFKA_AUTO_CREATE` off, the publisher's topic simply does not exist, so:

- `POST /v1/events` returns **202 accepted** (the write path only needs to hand the event to Watermill),
- every container reports **healthy**, every bootstrap check passes,
- ClickHouse `flexprice.events` stays at **0 rows forever**,
- and every usage query returns "no data" — which reads like a FlexPrice semantics finding and is not one.

Fixing it means both halves: the `FLEXPRICE_KAFKA_TOPIC*` / `..._TOPIC_*` scalars align the producers and consumers on one name, and `FLEXPRICE_KAFKA_TOPICS` (JSON — remember it *replaces* the create block rather than merging, shape per `internal/kafka/topicspec/spec.go`) creates exactly those names. The migrate container's warning about the create-list is therefore **not** the correct state on this stack any more; if you see it, the alignment block has drifted.

This is the failure mode the plan warned about, and it is why `npm run billing:flexprice:spike` opens with a `pipeline-health` probe that posts one event and requires it to come back through the meter — with a ClickHouse row count and the live topic list in the diagnostics when it does not. **If that probe fails, the ingest-shaped verdicts below it are measurements of the compose stack, not of FlexPrice, and must not be written up as findings.**

**Healthchecks bind to `127.0.0.1`.** This Docker network has no IPv6, so
`localhost` resolves to `::1` first. Upstream's ClickHouse check
(`wget --spider http://localhost:8123/ping`) therefore fails forever against a
server that answers `Ok.` on IPv4 — the container reads `unhealthy` while working
perfectly, and everything gated on `service_healthy` inherits that as "the stack
never comes up", with no error anywhere mentioning IPv6.

## Secrets posture

`FLEXPRICE_ALLOW_INSECURE_DEFAULTS` is **`false`**, unlike upstream's own compose,
which sets it `true` and ships the public dev API key. The check that flag
bypasses exists precisely to reject that key, and upstream's comment says the flag
"must never be set outside local Docker Compose" — so setting it false makes the
boot path this spike exercises the path a real deployment takes. `.env` therefore
holds generated values: a `fp_local_<24 random bytes>` API key (stored as its
sha256 in the key map, the raw key only in `.env`), a random `AUTH_SECRET`, a
random 32-byte `SECRETS_ENCRYPTION_KEY`, and random database passwords. `.env` is
gitignored; the bootstrap never echoes a value to stdout.

`FLEXPRICE_DEPLOYMENT_MODE=local` is deliberately not used either: local mode
skips config validation entirely, so a successful local-mode boot proves nothing
about the environment you would actually deploy.

## Talking to it

```bash
set -a; . deploy/flexprice/.env; set +a
curl -s http://127.0.0.1:18080/health
curl -s -H "x-api-key: $FLEXPRICE_API_KEY" http://127.0.0.1:18080/v1/tenants
```

There is no FlexPrice dashboard in this stack by design — review the data through
our own UI and these endpoints. The two `dev`-profile UIs (Temporal, Kafka) exist
when you need to see a workflow or a consumer lag:

```bash
docker compose -f deploy/flexprice/compose.yaml --profile dev up -d temporal-ui kafka-ui
```

Webhooks are **not** configured. Upstream ships no signing secret and no mTLS, and
their own docs say to treat the payload as advisory — so nothing in this project
accepts a FlexPrice webhook as an amount, ever. Read the record back over the
authenticated API instead.

## Spike

`npm run billing:flexprice:spike` (`scripts/flexprice-spike/run.js`) runs fourteen
idempotent probes, one per open question in
[`docs/FLEXPRICE_FINDINGS.md`](../../docs/FLEXPRICE_FINDINGS.md) §9 — the ingest
pipeline itself first, then money units and wire shape, `event_id` replay
semantics, ingest-to-queryable latency, real-time balance latency, manual debit
into a negative balance and its replay error, statement-invoice `auto_completed`,
GST as price-less line items, draw order across credit rows, promo expiry
reporting, per-project/per-user usage by `filters`, the minted-key planes and
shadow RBAC, the webhook transport shape, and this stack's memory footprint. It
writes `docs/flexprice-spike/results.json` and prints a verdict per probe.

The first probe is the reason the rest can be believed. `pipeline-health` posts one
event and requires it to come back through the meter; if it does not, the
ingest-shaped verdicts below it are measurements of this compose file rather than of
FlexPrice, and the probe says so in its own output. The last full run reported
`202 → value 424242 in 3069 ms` and finished with **0 failing verdicts**; §9 of the
findings doc carries the graded numbers. Re-running is safe — probes key off a fresh
`RUN` id and read their own rows back.

It does **not** edit the findings doc. The findings grade each claim by evidence
(✅ verified against the pinned commit vs 🔴 measured and *falsifying* an earlier
source reading), and a script that rewrites that file would put unverified verdicts
in the same voice as verified ones. Fold the results in by hand, citing the probe
that produced them.

## Footprint (item 13)

Measured with `docker stats --no-stream` on a warm stack; the `resource-footprint`
spike probe reports the same numbers.

| | |
|---|---|
| Status | **measured** — 8 long-running containers, 1422 MiB (1.39 GiB) warm, **2015 MiB after a full spike run** |
| clickhouse / kafka | 526 / 495 MiB warm → 800 / 724 MiB after traffic — 72% of the footprint at rest, and the two the plan called optional |
| postgres / temporal | 143 / 129 MiB |
| api / consumer / worker / redis | 32 / 53 / 38 / 6 MiB — the FlexPrice binary itself costs 222 MiB |
| Docker VM | 7.9 GiB total, 3.1 GiB available at sample time with `kind` and litellm-poc already running |

This is a **floor, not a ceiling**: no service sets a memory limit, so ClickHouse
and the Kafka broker grow with retained data instead of staying at these sizes. That
is now an observation rather than a prediction — the two samples above are the same
stack before and after the spike pushed events through it. Either figure fits beside
`kind` in an 8 GiB Docker VM.

The finding that matters for the plan: nine containers is the answer to "minimum
container set" — all of them load-bearing, plus `migrate`/`seed` which exit and pay
no RAM — and 1.4 GiB is what that costs. It fits beside `kind` in an 8 GiB Docker
VM, so Phase 1 review can run the metrics stack and FlexPrice at the same time. If
a later measurement stops fitting, run them separately rather than raising memory
and pretending the constraint went away.
