// Loaded via `node --test --import ./test/setup.ts` before any test module, so
// config.ts (which throws on missing required env) can be imported by tests of
// pure functions. These are non-secret test dummies, never real credentials.
process.env.FLEET_DATABASE_URL ??= 'postgres://fleet:fleet@127.0.0.1:5432/fleet_control';
process.env.GOOGLE_CLIENT_ID ??= 'test-client-id.apps.googleusercontent.com';
process.env.FLEET_SESSION_SECRET ??= 'test-session-secret-not-a-real-key';
process.env.LITELLM_MASTER_KEY ??= 'sk-test-master';
process.env.FLEXPRICE_API_KEY ??= 'test-flexprice-key';
process.env.LANGFUSE_SECRET_KEY ??= 'sk-lf-test';
process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= 'http://127.0.0.1:4318';
process.env.SWEEPER_INTERVAL_SECONDS ??= '3600';