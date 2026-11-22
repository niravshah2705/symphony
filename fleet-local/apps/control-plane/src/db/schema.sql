-- fleet_control: the BFF's own state. Canonical UUIDs (orgs.id / projects.id)
-- are reused verbatim in LiteLLM, Flexprice, baggage and k8s labels — no prefixes.
-- Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

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

-- Chat/agent sessions; the metering sweeper reads terminal rows to emit
-- fleet.actor_compute events and OTLP datapoints.
CREATE TABLE IF NOT EXISTS sessions (
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