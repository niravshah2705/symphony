-- fleet_control: the BFF's own state. Canonical UUIDs (orgs.id / projects.id)
-- are reused verbatim in LiteLLM, Flexprice, baggage and k8s labels — no prefixes.
-- Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Organisation lifecycle: active -> disabled -> active, or active|disabled ->
-- offboarding -> deleted. deleted is terminal: the row is kept (slug, projects,
-- sessions and onboarding_runs are the cost audit trail) but its infrastructure
-- and its membership are gone, so there is nothing to hand back.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  google_sub  text,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member',
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug            text NOT NULL,
  name            text NOT NULL,
  agent_name      text,
  agent_namespace text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

-- One row per (org, step): the onboarding machine's durable state.
CREATE TABLE IF NOT EXISTS onboarding_runs (
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  step            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  attempt         integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  result_json     jsonb,
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, step)
);

-- The offboarding machine's durable state, in its own table rather than shared
-- with onboarding_runs: several teardown ids (key, namespace, flexprice) are also
-- onboarding ids, and one PK would make a teardown's progress render as
-- "onboarding complete" and — worse — make a later re-onboarding skip the steps it
-- marks done, so a re-enabled org could get no LiteLLM Secret. Separate also keeps
-- the create history intact as the audit trail a delete is required to preserve.
CREATE TABLE IF NOT EXISTS offboarding_runs (
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  step            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  attempt         integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  result_json     jsonb,
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, step)
);

-- The bundle machine's durable state. Third table for the same reason the other
-- two are separate: its step ids (key, apply) overlap the others', and it carries
-- one extra dimension — an org can have a run in flight per (runtime, selection),
-- so `target` is part of the key and a re-run with a different plugin set is a new
-- run rather than an override of the last one's state.
CREATE TABLE IF NOT EXISTS bundle_runs (
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  target          text NOT NULL,
  step            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  attempt         integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  result_json     jsonb,
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, target, step)
);

-- Desired state the tenant render reads: one current image per (org, runtime).
-- Kept apart from bundle_runs because the machine's rows are per selection while
-- this is the one ref that a Harness points at, and a re-onboard must reproduce it
-- without replaying a build. The offboard route clears an org's rows when a
-- teardown completes — the org row itself survives as status 'deleted', so
-- ON DELETE CASCADE alone would leave this table describing a removed tenant.
CREATE TABLE IF NOT EXISTS bundle_builds (
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  runtime        text NOT NULL,
  image          text NOT NULL,
  base_digest    text NOT NULL,
  plugins        jsonb NOT NULL,
  dockerfile_sha text NOT NULL,
  bundle_key     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, runtime)
);

-- Chat/agent sessions; the metering sweeper reads terminal rows to emit
-- fleet.actor_compute events and OTLP datapoints.CREATE TABLE IF NOT EXISTS sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_name        text NOT NULL,
  agent_namespace   text NOT NULL,
  model             text,
  kagent_session_id text,
  kagent_task_id    text,
  status            text NOT NULL DEFAULT 'running',
  tier              text NOT NULL DEFAULT 'gvisor-default',
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  duration_seconds  double precision,
  metered_at        timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_org_idx ON sessions (org_id);
CREATE INDEX IF NOT EXISTS sessions_meter_idx ON sessions (status, metered_at);
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects (org_id);

-- P6: chat sessions record the chosen model id (run the schema on every boot,
-- so the ADD COLUMN is how an existing fleet_control upgrades in place).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model text;

-- A2A facade: what a turn turned out to be, and why. status='closed' alone could
-- not tell a completed turn from one whose agent stream produced nothing, which
-- is how every failure — including a dead provider key — was billed as if it had
-- succeeded. Legacy rows keep outcome NULL and read as 'completed'.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS close_reason text;
-- A turn paused on input-required is not billable wall time; only the seconds an
-- agent stream actually ran are. meter_seconds accumulates them for the whole
-- conversation and billed_seconds records how much of that has been invoiced, so
-- the sweeper always bills the delta and a turn can never be lost or doubled.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS meter_seconds double precision;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS billed_seconds double precision;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS awaiting_since timestamptz;
-- Which turn an event belongs to: the event id is keyed on it, so a continuing
-- conversation bills more than once while a retry of the same turn still dedups.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn integer NOT NULL DEFAULT 1;
-- What the sweeper last emitted, so a disputed line on a statement can be
-- explained from the row alone. A turn the platform broke is acknowledged with
-- metered_seconds = 0 and never re-enters the sweep.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metered_seconds double precision;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metered_outcome text;

-- Rows metered before this migration already invoiced their wall clock; mark
-- them fully billed so the delta logic never re-bills history. Idempotent: after
-- the first pass billed_seconds equals meter_seconds (or the legacy duration).
UPDATE sessions
   SET billed_seconds = COALESCE(meter_seconds, duration_seconds, 0)
 WHERE metered_at IS NOT NULL AND billed_seconds IS NULL;

-- The facade's conversation handle is the A2A contextId (not a BFF-private
-- session id), so continuing a conversation looks the context up directly.
CREATE INDEX IF NOT EXISTS sessions_context_idx ON sessions (project_id, kagent_session_id);

-- The AG-UI leg's conversation handle is the client's threadId, which arrives on
-- every turn while the contextId is still unknown (a first turn has none). It is
-- unique per project so a double-submitted first turn collides instead of
-- silently splitting one conversation into two sessions, and the project scope is
-- what keeps a guessed uuid from resolving into another tenant's row.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thread_id text;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_thread_idx ON sessions (project_id, thread_id) WHERE thread_id IS NOT NULL;